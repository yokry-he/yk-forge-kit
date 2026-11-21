import { isAbsolute } from 'node:path';
import { Queue, Worker } from 'bullmq';
import { ALIPAY_JOB_NAME, ALIPAY_QUEUE_NAME, type AlipayJobPayload } from '@forgekit/contracts';
import { LocalFsArtifactStore } from '@forgekit/artifact-store';
import { BuildRepository, AlipayConflictError, AlipayLogRepository, AlipayRepository, deployEncryptionKey, type DatabaseClient } from '@forgekit/db';
import { AlipayProcessor } from './alipay-processor';
import { DockerAlipayRunner, alipayDockerArgs } from './alipay-runner';
import type { resolveWorkerConfig } from './config';
export function resolveAlipayConfig(env: NodeJS.ProcessEnv) {
  if (!env.FORGEKIT_ALIPAY_IMAGE) return null;
  const options = { image: env.FORGEKIT_ALIPAY_IMAGE, network: env.FORGEKIT_ALIPAY_NETWORK ?? '', workspaceRoot: env.FORGEKIT_BUILD_WORKSPACE_DIR };
  alipayDockerArgs(options, '/tmp/validate', 'validate', 1000, 1000);
  if (!env.FORGEKIT_ARTIFACT_DIR || !isAbsolute(env.FORGEKIT_ARTIFACT_DIR) || (options.workspaceRoot && !isAbsolute(options.workspaceRoot))) throw new Error('alipay_artifact_dir_required');
  return { ...options, artifactDir: env.FORGEKIT_ARTIFACT_DIR };
}
export async function startAlipayWorker(client: DatabaseClient, config: ReturnType<typeof resolveWorkerConfig>, env = process.env,
  log: (event: Record<string, unknown>) => void = event => console.log(JSON.stringify(event))) {
  const options = resolveAlipayConfig(env);
  if (!options) return { close: async () => {} };
  const key = deployEncryptionKey(env.FORGEKIT_DEPLOY_ENCRYPTION_KEY);
  const store = new LocalFsArtifactStore(options.artifactDir);
  const jobs = new AlipayRepository(client.db);
  const processor = new AlipayProcessor(jobs, new BuildRepository(client.db), new AlipayLogRepository(client.db),
    new DockerAlipayRunner(store, options), key, artifact => store.remove(artifact));
  const queue = new Queue<AlipayJobPayload>(ALIPAY_QUEUE_NAME, { connection: { ...config.connection, maxRetriesPerRequest: 1 } });
  const worker = new Worker<AlipayJobPayload>(ALIPAY_QUEUE_NAME, job => processor.process(job.data, job.id), {
    connection: { ...config.connection, maxRetriesPerRequest: null }, concurrency: config.concurrency, autorun: false, maxStalledCount: 1,
  });
  worker.on('error', () => log({ event: 'alipay_worker_error' })); queue.on('error', () => log({ event: 'alipay_queue_error' }));
  worker.on('failed', job => log({ event: 'alipay_job_failed', jobId: job?.id }));
  let closing = false, timer: ReturnType<typeof setTimeout> | undefined, task: Promise<void> | undefined;
  const fail = async (id: string, from: 'queued' | 'running', code: string) => {
    try { await jobs.transition(id, from, 'failed', code); }
    catch (error) { if (!(error instanceof AlipayConflictError)) throw error; }
  };
  const reconcile = async () => {
    for (const row of await jobs.stale('queued', new Date(Date.now() - 30000))) {
      const job = await queue.getJob(row.id), state = await job?.getState();
      if (state === 'failed' || state === 'completed') await fail(row.id, 'queued', 'alipay_queue_ended');
      else if (!job) await queue.add(ALIPAY_JOB_NAME, { jobId: row.id }, { jobId: row.id, attempts: 3,
        backoff: { type: 'exponential', delay: 1000 }, removeOnComplete: 1000, removeOnFail: 1000 });
    }
    for (const row of await jobs.stale('running', new Date(Date.now() - 390000))) {
      const state = await (await queue.getJob(row.id))?.getState();
      if (!state || state === 'failed' || state === 'completed') await fail(row.id, 'running', 'alipay_worker_lost_check_platform');
    }
  };
  let startupTimer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([(async () => { await queue.waitUntilReady(); await worker.waitUntilReady(); await reconcile(); })(),
      new Promise<never>((_, reject) => { startupTimer = setTimeout(() => reject(new Error('alipay_worker_startup_timeout')), 10000); })]);
  } catch (error) { await Promise.allSettled([worker.close(true), queue.close()]); key.fill(0); throw error; }
  finally { clearTimeout(startupTimer); }
  const running = worker.run().catch(() => log({ event: 'alipay_worker_run_error' }));
  const schedule = () => { task = reconcile().catch(() => log({ event: 'alipay_reconcile_failed' })).finally(() => {
    if (!closing) timer = setTimeout(schedule, config.heartbeatMs);
  }); };
  timer = setTimeout(schedule, config.heartbeatMs); log({ event: 'alipay_worker_ready' });
  return { async close() {
    closing = true; clearTimeout(timer); await worker.pause(true); processor.shutdown(); await task;
    await worker.close(); await running; await queue.close(); key.fill(0);
  } };
}
