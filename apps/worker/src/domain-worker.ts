import { Queue, Worker } from 'bullmq';
import { DOMAIN_JOB_NAME, DOMAIN_QUEUE_NAME, type DomainJobPayload } from '@forgekit/contracts';
import { DomainRepository, DomainLogRepository, DeployRepository, DeployConflictError, deployEncryptionKey, type DatabaseClient } from '@forgekit/db';
import { DomainProcessor } from './domain-processor';
import { NodeDomainDnsVerifier, type DomainDnsVerifier } from './domain-dns';
import { SshDomainHost } from './domain-ssh';
import type { resolveWorkerConfig } from './config';
export async function startDomainWorker(client: DatabaseClient, config: ReturnType<typeof resolveWorkerConfig>, env = process.env,
  log: (event: Record<string, unknown>) => void = event => console.log(JSON.stringify(event)), dns: DomainDnsVerifier = new NodeDomainDnsVerifier()) {
  if (!env.FORGEKIT_DEPLOY_ENCRYPTION_KEY) return { close: async () => {} };
  const key = deployEncryptionKey(env.FORGEKIT_DEPLOY_ENCRYPTION_KEY);
  const domains = new DomainRepository(client.db), logs = new DomainLogRepository(client.db);
  const processor = new DomainProcessor(domains, new DeployRepository(client.db), logs, dns, new SshDomainHost(key));
  const queue = new Queue<DomainJobPayload>(DOMAIN_QUEUE_NAME, { connection: { ...config.connection, maxRetriesPerRequest: 1 } });
  const worker = new Worker<DomainJobPayload>(DOMAIN_QUEUE_NAME, job => processor.process(job.data, job.id), {
    connection: { ...config.connection, maxRetriesPerRequest: null }, concurrency: config.concurrency, autorun: false, maxStalledCount: 1,
  });
  worker.on('error', () => log({ event: 'domain_worker_error' })); queue.on('error', () => log({ event: 'domain_queue_error' }));
  worker.on('failed', job => log({ event: 'domain_job_failed', operationId: job?.id }));
  const add = (id: string) => queue.add(DOMAIN_JOB_NAME, { operationId: id }, { jobId: id, attempts: 3,
    backoff: { type: 'exponential', delay: 1000 }, removeOnComplete: 1000, removeOnFail: 1000 });
  let closing = false, timer: ReturnType<typeof setTimeout> | undefined, task: Promise<void> | undefined;
  const fail = async (id: string, code: string, from: 'pending' | 'running') => {
    await logs.append({ operationId: id, stream: 'system', content: `域名任务中断：${code}。请核对主机后重试。\n` });
    await domains.finish(id, 'failed', { status: 'failed', errorCode: code, lastCheckedAt: new Date() }, code, from);
  };
  const reconcile = async () => {
    for (const op of await domains.stale('pending', new Date(Date.now() - 30000))) {
      const job = await queue.getJob(op.id), state = await job?.getState();
      if (state === 'failed' || state === 'completed') await fail(op.id, 'domain_queue_ended', 'pending');
      else if (!job) await add(op.id);
    }
    // Remote timeout 240s + 5s kill grace; local timeout 270s + 60s lease grace.
    for (const op of await domains.stale('running', new Date(Date.now() - 330000))) {
      const state = await (await queue.getJob(op.id))?.getState();
      if (!state || state === 'failed' || state === 'completed') await fail(op.id, 'domain_worker_lost_check_remote', 'running');
    }
    // Caddy renews independently. Daily observations also retry failed checks of historical certificates.
    for (const domain of await domains.due(new Date(Date.now() - 86400000))) {
      try {
        const op = await domains.request(domain.projectId, domain.id, 'refresh', 'system:certificate-check');
        await add(op.id);
      } catch (error) { if (!(error instanceof DeployConflictError)) throw error; }
    }
  };
  let startupTimer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([(async () => { await queue.waitUntilReady(); await worker.waitUntilReady(); await reconcile(); })(),
      new Promise<never>((_, reject) => { startupTimer = setTimeout(() => reject(new Error('domain_worker_startup_timeout')), 10000); })]);
  } catch (error) { await Promise.allSettled([worker.close(true), queue.close()]); key.fill(0); throw error; }
  finally { clearTimeout(startupTimer); }
  const running = worker.run().catch(() => log({ event: 'domain_worker_run_error' }));
  const schedule = () => { task = reconcile().catch(() => log({ event: 'domain_reconcile_failed' })).finally(() => {
    if (!closing) timer = setTimeout(schedule, config.heartbeatMs);
  }); };
  timer = setTimeout(schedule, config.heartbeatMs);
  log({ event: 'domain_worker_ready' });
  return { async close() {
    closing = true; clearTimeout(timer); await worker.pause(true); processor.shutdown(); await task;
    await worker.close(); await running; await queue.close(); key.fill(0);
  } };
}
