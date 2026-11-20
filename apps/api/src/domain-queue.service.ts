import { Injectable, Logger, ServiceUnavailableException, type OnModuleDestroy } from '@nestjs/common';
import { Queue } from 'bullmq';
import { DOMAIN_JOB_NAME, DOMAIN_QUEUE_NAME, DomainJobPayloadSchema, type DomainJobPayload } from '@forgekit/contracts';

import { resolveBuildRedisConfig } from './build-queue.service';

@Injectable()
export class DomainQueueService implements OnModuleDestroy {
  private readonly logger = new Logger(DomainQueueService.name);
  private readonly connection = resolveBuildRedisConfig(process.env);
  private queue?: Queue<DomainJobPayload>;
  requireConfigured(): void {
    if (!this.connection) throw new ServiceUnavailableException('域名队列尚未配置 REDIS_URL。');
  }
  async enqueue(operationId: string): Promise<void> {
    this.requireConfigured();
    const payload = DomainJobPayloadSchema.parse({ operationId });
    if (!this.queue) {
      this.queue = new Queue<DomainJobPayload>(DOMAIN_QUEUE_NAME, { connection: this.connection! });
      this.queue.on('error', this.onError);
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([this.queue.waitUntilReady(), new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('queue_connection_timeout')), 3500);
      })]);
      await this.queue.add(DOMAIN_JOB_NAME, payload, { jobId: operationId, attempts: 3,
        backoff: { type: 'exponential', delay: 1000 }, removeOnComplete: 1000, removeOnFail: 1000 });
    } catch { throw new ServiceUnavailableException('域名队列暂不可用。'); }
    finally { clearTimeout(timer); }
  }
  private readonly onError = () => this.logger.warn('域名队列连接不可用。');
  async onModuleDestroy(): Promise<void> { await this.queue?.close(); }
}
