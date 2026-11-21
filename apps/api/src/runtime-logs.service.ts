import { ConflictException, ForbiddenException, HttpException, Inject, Injectable, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { RuntimeLogSessionSchema, RuntimeLogEventSchema, RUNTIME_LOG_LIMITS, type RuntimeLogInput } from '@forgekit/contracts';
import { RuntimeLogRepository, RuntimeLogLimitError, DeployConflictError, DeployNotFoundError, deployEncryptionKey, type RuntimeLogRow } from '@forgekit/db';
import { DatabaseService } from './database.service';
import { ProjectsService } from './projects.service';
import { InvitationRateLimiter } from './invitation-rate-limiter';
import { RuntimeLogQueueService } from './runtime-log-queue.service';
import type { ProjectAuthContext } from './project-auth-context';
@Injectable()
export class RuntimeLogsService {
  constructor(@Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(ProjectsService) private readonly projects: ProjectsService,
    @Inject(InvitationRateLimiter) private readonly limiter: InvitationRateLimiter,
    @Inject(RuntimeLogQueueService) private readonly queue: RuntimeLogQueueService) {}
  private get repository() { return new RuntimeLogRepository(this.database.db); }
  private async authorize(projectId: string, auth: ProjectAuthContext, rate?: 'runtime-start' | 'runtime-poll') {
    if (auth.mode !== 'oidc') throw new ForbiddenException('运行日志需要已验证的 OIDC 项目成员身份。');
    await this.projects.findById(projectId, auth, 'deploy:read');
    const actor = await this.projects.findUserId(auth);
    if (!actor) throw new ForbiddenException('项目成员身份不存在。');
    if (rate) await this.limiter.consume(rate, auth.issuer, auth.subject);
    return actor;
  }
  async create(projectId: string, input: RuntimeLogInput, auth: ProjectAuthContext) {
    const actor = await this.authorize(projectId, auth, 'runtime-start');
    this.queue.requireConfigured();
    try { deployEncryptionKey(process.env.FORGEKIT_DEPLOY_ENCRYPTION_KEY).fill(0); }
    catch { throw new ServiceUnavailableException('部署密钥尚未正确配置。'); }
    let row;
    try { row = await this.repository.create(projectId, actor, input); }
    catch (error) {
      if (error instanceof RuntimeLogLimitError) throw new HttpException('运行日志会话过多，请稍后重试。', 429);
      if (error instanceof DeployNotFoundError) throw new NotFoundException('站点不存在。');
      if (error instanceof DeployConflictError) throw new ConflictException('请选择已部署并已验证域名的站点。');
      throw new ServiceUnavailableException('运行日志服务暂不可用。');
    }
    try { await this.queue.enqueue(row.id); }
    catch {
      await this.repository.finish(row.id, 'failed', 'runtime_queue_failed');
      throw new ServiceUnavailableException('运行日志队列暂不可用。');
    }
    return serializeRuntimeSession(row);
  }
  async get(projectId: string, sessionId: string, auth: ProjectAuthContext, rate = false) {
    const actor = await this.authorize(projectId, auth, rate ? 'runtime-poll' : undefined);
    const row = await this.repository.get(sessionId);
    // A session belongs to its initiating member; tickets never expose another member's tail.
    if (!row || row.projectId !== projectId || row.actorUserId !== actor || row.expiresAt.getTime() + RUNTIME_LOG_LIMITS.retentionMs < Date.now()) throw new NotFoundException('日志会话不存在或已清理。');
    return serializeRuntimeSession(row);
  }
  async cancel(projectId: string, sessionId: string, auth: ProjectAuthContext) {
    await this.get(projectId, sessionId, auth, true);
    await this.repository.finish(sessionId, 'canceled');
  }
  async logs(projectId: string, sessionId: string, seq: number, limit: number, auth: ProjectAuthContext) {
    await this.get(projectId, sessionId, auth, true);
    return (await this.repository.listSince(sessionId, seq, limit)).map(row => RuntimeLogEventSchema.parse({
      sessionId: row.sessionId, seq: row.seq, stream: row.stream, content: row.content, ts: row.ts.toISOString(),
    }));
  }
}
export function serializeRuntimeSession(row: RuntimeLogRow) {
  return RuntimeLogSessionSchema.parse({ id: row.id, projectId: row.projectId, domainId: row.domainId, deployTargetId: row.deployTargetId,
    source: row.input.source, status: row.status, errorCode: row.errorCode, createdAt: row.createdAt.toISOString(), expiresAt: row.expiresAt.toISOString() });
}
