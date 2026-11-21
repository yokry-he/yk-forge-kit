import { Injectable, Logger, ServiceUnavailableException, type OnModuleDestroy } from '@nestjs/common';
import { Queue } from 'bullmq';
import { RUNTIME_LOG_JOB_NAME, RUNTIME_LOG_QUEUE_NAME, RuntimeLogJobSchema, type RuntimeLogJob } from '@forgekit/contracts';

import { resolveBuildRedisConfig } from './build-queue.service';

@Injectable()
export class RuntimeLogQueueService implements OnModuleDestroy {
  private readonly logger = new Logger(RuntimeLogQueueService.name);
  private readonly connection = resolveBuildRedisConfig(process.env);
  private queue?: Queue<RuntimeLogJob>;
  requireConfigured(): void {
    if (!this.connection) throw new ServiceUnavailableException('运行日志队列尚未配置 REDIS_URL。');
  }
  async enqueue(sessionId: string): Promise<void> {
    this.requireConfigured();
    const payload = RuntimeLogJobSchema.parse({ sessionId });
    if (!this.queue) {
      this.queue = new Queue<RuntimeLogJob>(RUNTIME_LOG_QUEUE_NAME, { connection: this.connection! });
      this.queue.on('error', this.onError);
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([this.queue.waitUntilReady(), new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('queue_connection_timeout')), 3500);
      })]);
      await this.queue.add(RUNTIME_LOG_JOB_NAME, payload, { jobId: sessionId, attempts: 1,
        backoff: { type: 'exponential', delay: 1000 }, removeOnComplete: 100, removeOnFail: 100 });
    } catch { throw new ServiceUnavailableException('运行日志队列暂不可用。'); }
    finally { clearTimeout(timer); }
  }
  private readonly onError = () => this.logger.warn('运行日志队列连接不可用。');
  async onModuleDestroy(): Promise<void> { await this.queue?.close(); }
}
