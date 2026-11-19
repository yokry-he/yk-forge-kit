import { Injectable, Logger, ServiceUnavailableException, type OnModuleDestroy } from '@nestjs/common';
import { Queue, type ConnectionOptions } from 'bullmq';
import { BUILD_JOB_NAME, BUILD_QUEUE_NAME, BuildJobPayloadSchema, type BuildJobPayload } from '@forgekit/contracts';

export function resolveBuildRedisConfig(env: Record<string, string | undefined>): ConnectionOptions | null {
  if (!env.REDIS_URL) return null;
  let url: URL;
  try { url = new URL(env.REDIS_URL); } catch { throw new Error('REDIS_URL 格式无效。'); }
  if (!['redis:', 'rediss:'].includes(url.protocol) || !url.hostname || url.search || url.hash ||
      !/^\/(\d+)?$/.test(url.pathname || '/') || Number(url.port || 6379) < 1) throw new Error('REDIS_URL 格式无效。');
  return { host: url.hostname, port: Number(url.port || 6379), db: Number(url.pathname.slice(1) || 0),
    ...(url.username ? { username: decodeURIComponent(url.username) } : {}),
    ...(url.password ? { password: decodeURIComponent(url.password) } : {}),
    ...(url.protocol === 'rediss:' ? { tls: {} } : {}),
    connectTimeout: 3000, commandTimeout: 3000, maxRetriesPerRequest: 1, enableOfflineQueue: false };
}

@Injectable()
export class BuildQueueService implements OnModuleDestroy {
  private readonly logger = new Logger(BuildQueueService.name);
  private readonly connection = resolveBuildRedisConfig(process.env);
  private queue?: Queue<BuildJobPayload>;
  requireConfigured(): void {
    if (!this.connection) throw new ServiceUnavailableException('构建队列尚未配置 REDIS_URL。');
  }
  async enqueue(buildId: string): Promise<void> {
    this.requireConfigured();
    const payload = BuildJobPayloadSchema.parse({ buildId });
    if (!this.queue) {
      this.queue = new Queue<BuildJobPayload>(BUILD_QUEUE_NAME, { connection: this.connection! });
      this.queue.on('error', this.onError);
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([this.queue.waitUntilReady(), new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('queue_connection_timeout')), 3500);
      })]);
      await this.queue.add(BUILD_JOB_NAME, payload, { jobId: buildId, attempts: 3,
        backoff: { type: 'exponential', delay: 1000 }, removeOnComplete: 1000, removeOnFail: 1000 });
    } catch { throw new ServiceUnavailableException('构建队列暂不可用。'); }
    finally { clearTimeout(timer); }
  }
  private readonly onError = () => this.logger.warn('构建队列连接不可用。');
  async onModuleDestroy(): Promise<void> { await this.queue?.close(); }
}
