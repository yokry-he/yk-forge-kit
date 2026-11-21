import { Injectable, Logger, ServiceUnavailableException, type OnModuleDestroy } from '@nestjs/common';
import { Queue } from 'bullmq';
import { ANDROID_JOB_NAME, ANDROID_QUEUE_NAME, AndroidJobPayloadSchema, type AndroidJobPayload } from '@forgekit/contracts';

import { resolveBuildRedisConfig } from './build-queue.service';

@Injectable()
export class AndroidQueueService implements OnModuleDestroy {
  private readonly logger = new Logger(AndroidQueueService.name);
  private readonly connection = resolveBuildRedisConfig(process.env);
  private queue?: Queue<AndroidJobPayload>;
  requireConfigured(): void {
    if (!this.connection) throw new ServiceUnavailableException('Android 打包队列尚未配置 REDIS_URL。');
  }
  async enqueue(jobId: string): Promise<void> {
    this.requireConfigured();
    const payload = AndroidJobPayloadSchema.parse({ jobId });
    if (!this.queue) {
      this.queue = new Queue<AndroidJobPayload>(ANDROID_QUEUE_NAME, { connection: this.connection! });
      this.queue.on('error', this.onError);
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([this.queue.waitUntilReady(), new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('queue_connection_timeout')), 3500);
      })]);
      await this.queue.add(ANDROID_JOB_NAME, payload, { jobId: jobId, attempts: 3,
        backoff: { type: 'exponential', delay: 1000 }, removeOnComplete: 1000, removeOnFail: 1000 });
    } catch { throw new ServiceUnavailableException('Android 打包队列暂不可用。'); }
    finally { clearTimeout(timer); }
  }
  private readonly onError = () => this.logger.warn('Android 打包队列连接不可用。');
  async onModuleDestroy(): Promise<void> { await this.queue?.close(); }
}
