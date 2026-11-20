import { isAbsolute } from 'node:path';
import { Queue, Worker } from 'bullmq';
import { DEPLOY_JOB_NAME, DEPLOY_QUEUE_NAME, type DeployJobPayload } from '@forgekit/contracts';
import { LocalFsArtifactStore } from '@forgekit/artifact-store';
import { BuildRepository, DeployConflictError, DeployLogRepository, DeployRepository, deployEncryptionKey, type DatabaseClient } from '@forgekit/db';
import { DeployProcessor } from './deploy-processor';
import { SshStaticDeployer } from './ssh-deployer';
import type { resolveWorkerConfig } from './config';

export async function startDeployWorker(client: DatabaseClient, config: ReturnType<typeof resolveWorkerConfig>,
  env = process.env, log: (event: Record<string, unknown>) => void = event => console.log(JSON.stringify(event))) {
  if (!env.FORGEKIT_DEPLOY_ENCRYPTION_KEY) return { close: async () => {} };
  const key = deployEncryptionKey(env.FORGEKIT_DEPLOY_ENCRYPTION_KEY);
  const artifactDir = env.FORGEKIT_ARTIFACT_DIR;
  if (!artifactDir || !isAbsolute(artifactDir)) throw new Error('deploy_artifact_dir_required');
  const jobs = new DeployRepository(client.db);
  const processor = new DeployProcessor(jobs, new BuildRepository(client.db), new DeployLogRepository(client.db),
    new SshStaticDeployer(new LocalFsArtifactStore(artifactDir), key));
  const queue = new Queue<DeployJobPayload>(DEPLOY_QUEUE_NAME, { connection: { ...config.connection, maxRetriesPerRequest: 1 } });
  const worker = new Worker<DeployJobPayload>(DEPLOY_QUEUE_NAME, job => processor.process(job.data, job.id), {
    connection: { ...config.connection, maxRetriesPerRequest: null }, concurrency: config.concurrency, autorun: false, maxStalledCount: 1,
  });
  worker.on('error', () => log({ event: 'deploy_worker_error' })); queue.on('error', () => log({ event: 'deploy_queue_error' }));
  worker.on('failed', job => log({ event: 'deploy_job_failed', deploymentId: job?.id }));
  let closing = false, timer: ReturnType<typeof setTimeout> | undefined, task: Promise<void> | undefined;
  const fail = async (id: string, from: 'pending' | 'running', code: string) => {
    try { await jobs.transition(id, from, 'failed', code); }
    catch (error) { if (!(error instanceof DeployConflictError)) throw error; }
  };
  const reconcile = async () => {
    for (const row of await jobs.stale('pending', new Date(Date.now() - 30000))) {
      const job = await queue.getJob(row.id);
      const state = await job?.getState();
      if (state === 'failed' || state === 'completed') await fail(row.id, 'pending', 'deploy_queue_ended');
      else if (!job) await queue.add(DEPLOY_JOB_NAME, { deploymentId: row.id }, { jobId: row.id, attempts: 3,
        backoff: { type: 'exponential', delay: 1000 }, removeOnComplete: 1000, removeOnFail: 1000 });
    }
    // Local 330s budget + lease grace; remote script expires after at most 305s.
    for (const row of await jobs.stale('running', new Date(Date.now() - 390000))) {
      const state = await (await queue.getJob(row.id))?.getState();
      if (!state || state === 'failed' || state === 'completed') await fail(row.id, 'running', 'deploy_worker_lost_check_remote');
    }
  };
  let startupTimer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([(async () => { await queue.waitUntilReady(); await worker.waitUntilReady(); await reconcile(); })(),
      new Promise<never>((_, reject) => { startupTimer = setTimeout(() => reject(new Error('deploy_worker_startup_timeout')), 10000); })]);
  } catch (error) { await Promise.allSettled([worker.close(true), queue.close()]); key.fill(0); throw error; }
  finally { clearTimeout(startupTimer); }
  const running = worker.run().catch(() => log({ event: 'deploy_worker_run_error' }));
  const schedule = () => { task = reconcile().catch(() => log({ event: 'deploy_reconcile_failed' })).finally(() => {
    if (!closing) timer = setTimeout(schedule, config.heartbeatMs);
  }); };
  timer = setTimeout(schedule, config.heartbeatMs);
  log({ event: 'deploy_worker_ready' });
  return { async close() {
    closing = true; clearTimeout(timer); await worker.pause(true); processor.shutdown(); await task;
    await worker.close(); await running; await queue.close(); key.fill(0);
  } };
}
