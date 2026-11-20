import { randomUUID } from 'node:crypto';
import { BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { DeployTargetSchema, DeploymentSchema, DeployLogEventSchema, type DeployTargetCreate, type DeployTargetUpdate } from '@forgekit/contracts';
import { DeployRepository, DeployLogRepository, DeployConflictError, DeployNotFoundError, deployEncryptionKey,
  encryptDeployKey, requireUnencryptedPrivateKey, type DeploymentRow, type DeployTargetRow } from '@forgekit/db';
import { DatabaseService } from './database.service';
import { ProjectsService } from './projects.service';
import { DeployQueueService } from './deploy-queue.service';
import { InvitationRateLimiter } from './invitation-rate-limiter';
import type { ProjectAuthContext } from './project-auth-context';

@Injectable()
export class DeploysService {
  constructor(@Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(ProjectsService) private readonly projects: ProjectsService,
    @Inject(DeployQueueService) private readonly queue: DeployQueueService,
    @Inject(InvitationRateLimiter) private readonly limiter: InvitationRateLimiter) {}
  private get repository() { return new DeployRepository(this.database.db); }
  private async authorize(projectId: string, auth: ProjectAuthContext, permission: 'deploy:read' | 'deploy:run' | 'deploy:manage') {
    if (auth.mode !== 'oidc') throw new ForbiddenException('部署需要已验证的 OIDC 项目成员身份。');
    await this.projects.findById(projectId, auth, permission);
    const actor = await this.projects.findUserId(auth);
    if (!actor) throw new ForbiddenException('项目成员身份不存在。');
    if (permission !== 'deploy:read') await this.limiter.consume('deploy-write', auth.issuer, auth.subject);
    return actor;
  }
  private encryptionKey() {
    try { return deployEncryptionKey(process.env.FORGEKIT_DEPLOY_ENCRYPTION_KEY); }
    catch { throw new ServiceUnavailableException('部署密钥加密尚未配置。'); }
  }
  async listTargets(projectId: string, auth: ProjectAuthContext) {
    await this.authorize(projectId, auth, 'deploy:read');
    return (await this.repository.listTargets(projectId)).map(serializeTarget);
  }
  async saveTarget(projectId: string, targetId: string | undefined, input: DeployTargetCreate | DeployTargetUpdate, auth: ProjectAuthContext) {
    const actor = await this.authorize(projectId, auth, 'deploy:manage');
    const id = targetId ?? randomUUID();
    const { privateKey, ...metadata } = input;
    const key = this.encryptionKey();
    let encrypted: string | undefined;
    try {
      if (privateKey !== undefined) {
        try { requireUnencryptedPrivateKey(privateKey); }
        catch { throw new BadRequestException('请使用有效的专用无口令 SSH 私钥。'); }
        encrypted = encryptDeployKey(privateKey.endsWith('\n') ? privateKey : privateKey + '\n', key, projectId, id);
      }
    } finally { key.fill(0); }
    try {
      await this.repository.saveTarget(projectId, id, actor, metadata, encrypted, !targetId);
      return serializeTarget((await this.repository.target(projectId, id))!);
    } catch (error) { throw deployHttpError(error); }
  }
  async removeTarget(projectId: string, targetId: string, auth: ProjectAuthContext) {
    const actor = await this.authorize(projectId, auth, 'deploy:manage');
    try { await this.repository.removeTarget(projectId, targetId, actor); }
    catch (error) { throw deployHttpError(error); }
  }
  async list(projectId: string, auth: ProjectAuthContext) {
    await this.authorize(projectId, auth, 'deploy:read');
    return (await this.repository.list(projectId)).map(serializeDeployment);
  }
  async get(projectId: string, id: string, auth: ProjectAuthContext) {
    await this.authorize(projectId, auth, 'deploy:read');
    const row = await this.repository.get(id);
    if (!row || row.projectId !== projectId) throw new NotFoundException('部署记录不存在。');
    return serializeDeployment(row);
  }
  async trigger(projectId: string, buildId: string, deployTargetId: string, auth: ProjectAuthContext, rollbackOf?: string) {
    const actor = await this.authorize(projectId, auth, 'deploy:run');
    this.encryptionKey().fill(0); this.queue.requireConfigured();
    let row;
    try { row = await this.repository.create({ projectId, buildId, deployTargetId, actor, rollbackOf }); }
    catch (error) { throw deployHttpError(error); }
    try { await this.queue.enqueue(row.id); }
    catch (error) {
      try { await this.repository.transition(row.id, 'pending', 'failed', 'deploy_queue_enqueue_failed'); }
      catch (transition) { if (!(transition instanceof DeployConflictError)) throw transition; }
      throw error;
    }
    return serializeDeployment(row);
  }
  async rollback(projectId: string, id: string, auth: ProjectAuthContext) {
    const previous = await this.get(projectId, id, auth);
    return this.trigger(projectId, previous.buildId, previous.deployTargetId, auth, id);
  }
  async logs(projectId: string, id: string, seq: number, limit: number, auth: ProjectAuthContext) {
    await this.get(projectId, id, auth);
    return (await new DeployLogRepository(this.database.db).listSince(id, seq, limit))
      .map(row => DeployLogEventSchema.parse({ ...row, ts: row.ts.toISOString() }));
  }
}
function deployHttpError(error: unknown) {
  if (error instanceof DeployConflictError) return new ConflictException('目标忙碌、连接信息不可迁移、构建不可用或版本已不在保留范围，请刷新后重试。');
  if (error instanceof DeployNotFoundError) return new NotFoundException('部署目标不存在。');
  return error;
}
export function serializeTarget(row: DeployTargetRow) {
  // Explicit allowlist: never spread a secret-bearing row into API output.
  return DeployTargetSchema.parse({ id: row.id, projectId: row.projectId, kind: row.kind, name: row.name,
    host: row.host, port: row.port, username: row.username, hostKey: row.hostKey, basePath: row.basePath,
    retention: row.retention, currentReleaseId: row.currentReleaseId, disabledAt: row.disabledAt?.toISOString() ?? null,
    createdBy: row.createdBy, createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString() });
}
export function serializeDeployment(row: DeploymentRow) {
  return DeploymentSchema.parse({ ...row, createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString(),
    startedAt: row.startedAt?.toISOString() ?? null, finishedAt: row.finishedAt?.toISOString() ?? null });
}
