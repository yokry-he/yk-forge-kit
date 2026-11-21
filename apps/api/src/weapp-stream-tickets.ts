import { createHash, randomBytes } from 'node:crypto';
import { ForbiddenException, Injectable, ServiceUnavailableException, UnauthorizedException, type OnModuleDestroy } from '@nestjs/common';
import { Redis } from 'ioredis';
import { resolveBuildRedisConfig } from './build-queue.service';
import type { ProjectAuthContext } from './project-auth-context';

export interface WeappStreamIdentity {
  projectId: string; jobId: string; auth: ProjectAuthContext; expires: number;
}
@Injectable()
export class WeappStreamTickets implements OnModuleDestroy {
  private readonly config = resolveBuildRedisConfig(process.env);
  private redis?: Redis;
  private connecting?: Promise<Redis>;
  private async client(): Promise<Redis> {
    if (!this.config) throw new ServiceUnavailableException('日志票据服务尚未配置。');
    if (this.connecting) return this.connecting;
    if (this.redis?.status === 'ready') return this.redis;
    this.redis?.disconnect();
    const redis = new Redis({ ...this.config, lazyConnect: true, retryStrategy: () => null });
    this.redis = redis;
    redis.on('error', () => { /* Only generic HTTP errors leave this adapter. */ });
    this.connecting = redis.connect().then(() => redis).finally(() => { this.connecting = undefined; });
    return this.connecting;
  }

  private key(ticket: string): string {
    return `weapp-stream-ticket:${createHash('sha256').update(ticket).digest('hex')}`;
  }
  async issue(projectId: string, jobId: string, auth: ProjectAuthContext) {
    if (auth.mode !== 'oidc') throw new ForbiddenException('本机模式不能签发日志票据。');
    const ticket = randomBytes(32).toString('base64url');
    const expires = Date.now() + 60_000;
    try {
      await (await this.client()).set(this.key(ticket), JSON.stringify({ projectId, jobId, auth, expires }), 'PX', 60_000);
    } catch { throw new ServiceUnavailableException('日志票据服务暂不可用。'); }
    return { ticket, expiresAt: new Date(expires).toISOString() };
  }
  async take(ticket: unknown, projectId: string, jobId: string): Promise<WeappStreamIdentity> {
    if (typeof ticket !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(ticket)) throw new UnauthorizedException('日志凭证无效。');
    let raw: string | null;
    try { raw = await (await this.client()).getdel(this.key(ticket)); }
    catch { throw new ServiceUnavailableException('日志票据服务暂不可用。'); }
    if (!raw) throw new UnauthorizedException('日志凭证无效或已到期。');
    const identity = JSON.parse(raw) as WeappStreamIdentity;
    if (identity.expires <= Date.now() || identity.projectId !== projectId || identity.jobId !== jobId) {
      throw new UnauthorizedException('日志凭证无效或已到期。');
    }
    return identity;
  }
  onModuleDestroy(): void { this.redis?.disconnect(); }
}
