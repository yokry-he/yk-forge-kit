import { ConflictException, ForbiddenException, Inject, Injectable, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { DomainSchema, DomainOperationSchema, DomainLogEventSchema, DomainTlsModeSchema, type DomainOperation } from '@forgekit/contracts';
import { DomainRepository, DomainLogRepository, DeployConflictError, DeployNotFoundError, deployEncryptionKey, type DomainRow, type DomainOperationRow } from '@forgekit/db';
import { DatabaseService } from './database.service';
import { ProjectsService } from './projects.service';
import { InvitationRateLimiter } from './invitation-rate-limiter';
import { DomainQueueService } from './domain-queue.service';
import type { ProjectAuthContext } from './project-auth-context';
@Injectable()
export class DomainsService {
  constructor(@Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(ProjectsService) private readonly projects: ProjectsService,
    @Inject(InvitationRateLimiter) private readonly limiter: InvitationRateLimiter,
    @Inject(DomainQueueService) private readonly queue: DomainQueueService) {}
  private get repository() { return new DomainRepository(this.database.db); }
  private async authorize(projectId: string, auth: ProjectAuthContext, write = false) {
    if (auth.mode !== 'oidc') throw new ForbiddenException('域名管理需要已验证的 OIDC 项目成员身份。');
    await this.projects.findById(projectId, auth, write ? 'deploy:manage' : 'deploy:read');
    const actor = await this.projects.findUserId(auth);
    if (!actor) throw new ForbiddenException('项目成员身份不存在。');
    if (write) await this.limiter.consume('deploy-write', auth.issuer, auth.subject);
    return actor;
  }
  async list(projectId: string, auth: ProjectAuthContext) {
    await this.authorize(projectId, auth); return (await this.repository.list(projectId)).map(serializeDomain);
  }
  async create(projectId: string, input: { deployTargetId: string; hostname: string }, auth: ProjectAuthContext) {
    const actor = await this.authorize(projectId, auth, true);
    let mode;
    try { deployEncryptionKey(process.env.FORGEKIT_DEPLOY_ENCRYPTION_KEY).fill(0); mode = DomainTlsModeSchema.parse(process.env.FORGEKIT_DOMAIN_TLS_MODE ?? 'internal'); }
    catch { throw new ServiceUnavailableException('域名 TLS 模式或部署密钥尚未正确配置。'); }
    try { return serializeDomain(await this.repository.create(projectId, input.deployTargetId, input.hostname, actor, mode)); }
    catch (error) { throw domainHttpError(error); }
  }
  async request(projectId: string, domainId: string, action: DomainOperation['action'], auth: ProjectAuthContext) {
    const actor = await this.authorize(projectId, auth, true);
    try { deployEncryptionKey(process.env.FORGEKIT_DEPLOY_ENCRYPTION_KEY).fill(0); }
    catch { throw new ServiceUnavailableException('部署密钥尚未正确配置。'); }
    this.queue.requireConfigured();
    let row;
    try { row = await this.repository.request(projectId, domainId, action, actor); }
    catch (error) { throw domainHttpError(error); }
    try { await this.queue.enqueue(row.id); }
    catch (error) {
      await this.repository.finish(row.id, 'failed', { errorCode: 'domain_queue_enqueue_failed' }, 'domain_queue_enqueue_failed', 'pending');
      throw error;
    }
    return serializeDomainOperation(row);
  }
  async operations(projectId: string, auth: ProjectAuthContext) {
    await this.authorize(projectId, auth); return (await this.repository.operations(projectId)).map(serializeDomainOperation);
  }
  async get(projectId: string, operationId: string, auth: ProjectAuthContext) {
    await this.authorize(projectId, auth);
    const row = await this.repository.operation(operationId);
    if (!row || row.projectId !== projectId) throw new NotFoundException('域名操作不存在。');
    return serializeDomainOperation(row);
  }
  async logs(projectId: string, operationId: string, seq: number, limit: number, auth: ProjectAuthContext) {
    await this.get(projectId, operationId, auth);
    return (await new DomainLogRepository(this.database.db).listSince(operationId, seq, limit)).map(row => DomainLogEventSchema.parse({ ...row, ts: row.ts.toISOString() }));
  }
}
function domainHttpError(error: unknown) {
  if (error instanceof DeployConflictError) return new ConflictException('目标尚未部署、目标忙碌、域名已存在或操作不适用，请刷新后重试。');
  if (error instanceof DeployNotFoundError) return new NotFoundException('域名或部署目标不存在。');
  return error;
}
export function serializeDomain(row: DomainRow) {
  return DomainSchema.parse({ id: row.id, projectId: row.projectId, deployTargetId: row.deployTargetId, hostname: row.hostname, status: row.status === 'active' && row.certificateExpiresAt && row.certificateExpiresAt.getTime() <= Date.now() ? 'expired' : row.status,
    verificationName: '_forgekit-challenge.' + row.hostname, verificationValue: 'forgekit-domain=' + row.verificationToken, tlsMode: row.tlsMode,
    certificateExpiresAt: row.certificateExpiresAt?.toISOString() ?? null, certificateFingerprint: row.certificateFingerprint,
    verifiedAt: row.verifiedAt?.toISOString() ?? null, lastCheckedAt: row.lastCheckedAt?.toISOString() ?? null, errorCode: row.errorCode,
    createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString() });
}
export function serializeDomainOperation(row: DomainOperationRow) {
  return DomainOperationSchema.parse({ id: row.id, projectId: row.projectId, deployTargetId: row.deployTargetId, domainId: row.domainId, action: row.action,
    status: row.status, errorCode: row.errorCode, finishedAt: row.finishedAt?.toISOString() ?? null, createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString() });
}
