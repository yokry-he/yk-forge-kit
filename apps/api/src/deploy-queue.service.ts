import { Injectable, Logger, ServiceUnavailableException, type OnModuleDestroy } from '@nestjs/common';
import { Queue } from 'bullmq';
import { DEPLOY_JOB_NAME, DEPLOY_QUEUE_NAME, DeployJobPayloadSchema, type DeployJobPayload } from '@forgekit/contracts';

import { resolveBuildRedisConfig } from './build-queue.service';

@Injectable()
export class DeployQueueService implements OnModuleDestroy {
  private readonly logger = new Logger(DeployQueueService.name);
  private readonly connection = resolveBuildRedisConfig(process.env);
  private queue?: Queue<DeployJobPayload>;
  requireConfigured(): void {
    if (!this.connection) throw new ServiceUnavailableException('部署队列尚未配置 REDIS_URL。');
  }
  async enqueue(deploymentId: string): Promise<void> {
    this.requireConfigured();
    const payload = DeployJobPayloadSchema.parse({ deploymentId });
    if (!this.queue) {
      this.queue = new Queue<DeployJobPayload>(DEPLOY_QUEUE_NAME, { connection: this.connection! });
      this.queue.on('error', this.onError);
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([this.queue.waitUntilReady(), new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('queue_connection_timeout')), 3500);
      })]);
      await this.queue.add(DEPLOY_JOB_NAME, payload, { jobId: deploymentId, attempts: 3,
        backoff: { type: 'exponential', delay: 1000 }, removeOnComplete: 1000, removeOnFail: 1000 });
    } catch { throw new ServiceUnavailableException('部署队列暂不可用。'); }
    finally { clearTimeout(timer); }
  }
  private readonly onError = () => this.logger.warn('部署队列连接不可用。');
  async onModuleDestroy(): Promise<void> { await this.queue?.close(); }
}
