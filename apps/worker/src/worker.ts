import { workerErrorDetails } from './diagnostics';
import { startAlipayWorker } from './alipay-worker';
import { startAndroidWorker } from './android-worker';
import { startWeappWorker } from './weapp-worker';
import { startRuntimeLogWorker } from './runtime-log-worker';
import { startDomainWorker } from './domain-worker';
import { startDeployWorker } from './deploy-worker';
import { Queue, Worker } from 'bullmq';
import { BUILD_JOB_NAME, BUILD_QUEUE_NAME, classifyBuildFailure, type BuildJobPayload } from '@forgekit/contracts';
import { BuildLogRepository, BuildRepository, EnvironmentVariableRepository, BuildTransitionError, type DatabaseClient } from '@forgekit/db';
import { BuildProcessor } from './processor';
import { NoopRunner, type BuildRunner } from './runner';
import type { resolveWorkerConfig } from './config';
import { DockerBuildRunner } from './docker-runner';
import { LocalFsArtifactStore } from './artifact-store';
import { TemplateWorkspaceSource } from './workspace-source';

type Log = (event: Record<string, unknown>) => void;
export async function startWorker(client: DatabaseClient, config: ReturnType<typeof resolveWorkerConfig>,
  log: Log = (event) => console.log(JSON.stringify(event)), runner?: BuildRunner, options: { development?: boolean } = {}) {
  const builds = new BuildRepository(client.db);
  const runnerName = runner ? 'injected' : config.runner;
  if (!runner) {
    runner = config.docker ? new DockerBuildRunner(new TemplateWorkspaceSource((id) => builds.getProjectSource(id)),
      new LocalFsArtifactStore(config.docker.artifactDir, config.docker.maxArtifactBytes), config.docker, undefined, undefined, build => new EnvironmentVariableRepository(client.db).forBuild(build.projectId, build.id)) : new NoopRunner();
  }
  const processor = new BuildProcessor(builds, new BuildLogRepository(client.db), runner, config.timeoutMs);
  const queue = new Queue<BuildJobPayload>(BUILD_QUEUE_NAME, { connection: { ...config.connection, maxRetriesPerRequest: 1 } });
  const worker = new Worker<BuildJobPayload>(BUILD_QUEUE_NAME, (job) => processor.process(job.data, job.id), {
    connection: { ...config.connection, maxRetriesPerRequest: null }, concurrency: config.concurrency,
    autorun: false, maxStalledCount: 1,
  });
  worker.on('error', error => log({ event: 'worker_error', ...workerErrorDetails(error) }));
  queue.on('error', error => log({ event: 'queue_error', ...workerErrorDetails(error) }));
  worker.on('failed', (job) => log({ event: 'job_failed', buildId: job?.id }));
  worker.on('completed', (job) => log({ event: 'job_processed', buildId: job.id }));
  let heartbeat: ReturnType<typeof setTimeout> | undefined;
  let closing = false;
  let healthTask: Promise<void> | undefined;
  const reconcile = async () => {
    // A permanently failed/lost Redis job cannot be redelivered by stalled recovery.
    // Allow timeout + two default lease periods before inspecting abandoned DB rows.
    for (const row of await builds.listRunningBefore(new Date(Date.now() - config.timeoutMs - 60000))) {
      const job = await queue.getJob(row.id);
      const state = await job?.getState();
      if (!job || state === 'failed' || state === 'completed') {
        try { await builds.updateStatus(row.id, 'running', 'failed', { errorMessage: 'worker_lost: queue job unavailable',
          diagnosis: classifyBuildFailure({ errorCodes: ['worker_lost'], logs: [] }) }); }
        catch (error) { if (!(error instanceof BuildTransitionError)) throw error; }
      }
    }
    for (const row of await builds.listQueuedBefore(new Date(Date.now() - 30000))) {
      const job = await queue.getJob(row.id);
      if (job) {
        const state = await job.getState();
        if (state === 'failed' || state === 'completed') {
          try { await builds.updateStatus(row.id, 'queued', 'failed', { errorMessage: 'queue_job_ended_before_start',
            diagnosis: classifyBuildFailure({ errorCodes: ['queue_job_ended_before_start'], logs: [] }) }); }
          catch (error) { if (!(error instanceof BuildTransitionError)) throw error; }
        }
      } else {
        await queue.add(BUILD_JOB_NAME, { buildId: row.id }, { jobId: row.id, attempts: 3,
          backoff: { type: 'exponential', delay: 1000 }, removeOnComplete: 1000, removeOnFail: 1000 });
      }
    }
  };
  let startupTimer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([(async () => {
      await client.ping();
      await queue.waitUntilReady();
      await worker.waitUntilReady();
      await reconcile();
    })(), new Promise<never>((_resolve, reject) => {
      startupTimer = setTimeout(() => reject(new Error('worker_startup_timeout')), 10000);
    })]);
  } catch (error) {
    await Promise.allSettled([worker.close(true), queue.close()]);
    throw error;
  } finally { clearTimeout(startupTimer); }
  let deployWorker;
  try {
    if (options.development && process.env.FORGEKIT_DEPLOY_ENCRYPTION_KEY && !process.env.FORGEKIT_ARTIFACT_DIR) {
      log({ event: 'deploy_worker_disabled', reason: 'dev requires FORGEKIT_ARTIFACT_DIR' });
      deployWorker = { close: async () => {} };
    } else deployWorker = await startDeployWorker(client, config, process.env, log);
  }
  catch (error) { await Promise.allSettled([worker.close(true), queue.close()]); throw error; }
  let domainWorker;
  try { domainWorker = await startDomainWorker(client, config, process.env, log); }
  catch (error) { await Promise.allSettled([deployWorker.close(), worker.close(true), queue.close()]); throw error; }
  let runtimeWorker;
  try { runtimeWorker = await startRuntimeLogWorker(client, config, process.env, log); }
  catch (error) { await Promise.allSettled([domainWorker.close(), deployWorker.close(), worker.close(true), queue.close()]); throw error; }
  let weappWorker;
  try { weappWorker = await startWeappWorker(client, config, process.env, log); }
  catch (error) { await Promise.allSettled([runtimeWorker.close(), domainWorker.close(), deployWorker.close(), worker.close(true), queue.close()]); throw error; }
  let androidWorker;
  try { androidWorker = await startAndroidWorker(client, config, process.env, log); }
  catch (error) { await Promise.allSettled([weappWorker.close(), runtimeWorker.close(), domainWorker.close(), deployWorker.close(), worker.close(true), queue.close()]); throw error; }
  let alipayWorker;
  try { alipayWorker = await startAlipayWorker(client, config, process.env, log); }
  catch (error) { await Promise.allSettled([androidWorker.close(), weappWorker.close(), runtimeWorker.close(), domainWorker.close(), deployWorker.close(), worker.close(true), queue.close()]); throw error; }
  const running = worker.run().catch(error => log({ event: 'worker_run_error', ...workerErrorDetails(error) }));
  const tick = async () => {
    try {
      if (!worker.isRunning()) throw new Error('consumer_not_running');
      await client.ping();
      await queue.getJobCounts('waiting', 'active');
      await reconcile();
      log({ event: 'worker_heartbeat', status: 'ok', concurrency: config.concurrency });
    } catch (error) { log({ event: 'worker_heartbeat', status: 'unavailable', ...workerErrorDetails(error) }); }
    if (!closing) heartbeat = setTimeout(schedule, config.heartbeatMs);
  };
  function schedule() { healthTask = tick(); }
  log({ event: 'worker_ready', queue: BUILD_QUEUE_NAME, runner: runnerName, concurrency: config.concurrency });
  heartbeat = setTimeout(schedule, config.heartbeatMs);
  return {
    async close() {
      closing = true;
      clearTimeout(heartbeat);
      // Stop intake first, but keep active jobs/lock renewal alive while their runners abort.
      await worker.pause(true);
      processor.shutdown();
      await Promise.all([alipayWorker.close(), androidWorker.close(), weappWorker.close(), runtimeWorker.close(), deployWorker.close(), domainWorker.close(), (async () => {
        await healthTask;
        await worker.close();
        await running;
        await queue.close();
      })()]);
    },
  };
}
