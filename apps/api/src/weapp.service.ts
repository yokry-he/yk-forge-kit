import { BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { createPrivateKey } from 'node:crypto';
import { isAbsolute } from 'node:path';
import { LocalFsArtifactStore } from '@forgekit/artifact-store';
import { WeappConfigSchema, WeappJobSchema, WeappLogEventSchema, type WeappConfigInput, type WeappJobInput } from '@forgekit/contracts';
import { WeappRepository, WeappLogRepository, WeappConflictError, deployEncryptionKey, encryptWeappKey, type WeappConfigRow, type WeappJobRow } from '@forgekit/db';
import { DatabaseService } from './database.service';
import { ProjectsService } from './projects.service';
import { InvitationRateLimiter } from './invitation-rate-limiter';
import { WeappQueueService } from './weapp-queue.service';
import type { ProjectAuthContext } from './project-auth-context';
@Injectable()
export class WeappService {
  constructor(@Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(ProjectsService) private readonly projects: ProjectsService,
    @Inject(WeappQueueService) private readonly queue: WeappQueueService,
    @Inject(InvitationRateLimiter) private readonly limiter: InvitationRateLimiter) {}
  private get repository() { return new WeappRepository(this.database.db); }
  private async authorize(projectId: string, auth: ProjectAuthContext, permission: 'deploy:read' | 'deploy:manage' | 'deploy:run' = 'deploy:read') {
    if (auth.mode !== 'oidc') throw new ForbiddenException('小程序上传需要已验证的项目成员身份。');
    const project = await this.projects.findById(projectId, auth, permission);
    if (project.template !== 'uniapp') throw new BadRequestException('仅 uniapp 项目支持微信上传。');
    const actor = await this.projects.findUserId(auth);
    if (!actor) throw new ForbiddenException('项目成员身份不存在。');
    if (permission !== 'deploy:read') await this.limiter.consume('weapp-write', auth.issuer, auth.subject);
    return actor;
  }
  async config(projectId: string, auth: ProjectAuthContext) {
    await this.authorize(projectId, auth);
    try { const row = await this.repository.config(projectId); return row ? serializeWeappConfig(row) : null; }
    catch { throw new ServiceUnavailableException('微信配置暂不可用。'); }
  }
  async save(projectId: string, input: WeappConfigInput, auth: ProjectAuthContext) {
    const actor = await this.authorize(projectId, auth, 'deploy:manage');
    let key: Buffer | undefined;
    try {
      key = deployEncryptionKey(process.env.FORGEKIT_DEPLOY_ENCRYPTION_KEY);
      const { privateKey, ...metadata } = input;
      if (privateKey !== undefined) {
        try {
          const parsed = createPrivateKey({ key: privateKey, passphrase: '' });
          if (parsed.asymmetricKeyType !== 'rsa' || !privateKey.startsWith('-----BEGIN ')) throw new Error();
        } catch { throw new BadRequestException('请粘贴有效的微信上传 RSA PEM 私钥。'); }
      }
      const encrypted = privateKey === undefined ? undefined : encryptWeappKey(privateKey, key, projectId);
      return serializeWeappConfig(await this.repository.save(projectId, metadata, encrypted, actor));
    } catch (error) {
      if (error instanceof BadRequestException) throw error;
      throw weappHttpError(error);
    } finally { key?.fill(0); }
  }
  async remove(projectId: string, auth: ProjectAuthContext) {
    const actor = await this.authorize(projectId, auth, 'deploy:manage');
    try { await this.repository.remove(projectId, actor); } catch (error) { throw weappHttpError(error); }
  }
  async list(projectId: string, auth: ProjectAuthContext) {
    await this.authorize(projectId, auth);
    try { return (await this.repository.list(projectId)).map(serializeWeappJob); } catch { throw weappHttpError(); }
  }
  async record(projectId: string, id: string, auth: ProjectAuthContext) {
    await this.authorize(projectId, auth);
    let row;
    try { row = await this.repository.get(id); } catch { throw weappHttpError(); }
    if (!row || row.projectId !== projectId) throw new NotFoundException('微信上传任务不存在。'); return row;
  }
  async get(projectId: string, id: string, auth: ProjectAuthContext) { return serializeWeappJob(await this.record(projectId, id, auth)); }
  async trigger(projectId: string, input: WeappJobInput, auth: ProjectAuthContext) {
    const actor = await this.authorize(projectId, auth, 'deploy:run');
    this.queue.requireConfigured();
    try { deployEncryptionKey(process.env.FORGEKIT_DEPLOY_ENCRYPTION_KEY).fill(0); } catch { throw weappHttpError(); }
    let row;
    try { row = await this.repository.create(projectId, input, actor); } catch (error) { throw weappHttpError(error); }
    try { await this.queue.enqueue(row.id); }
    catch {
      try { await this.repository.transition(row.id, 'queued', 'failed', 'weapp_enqueue_failed'); }
      catch (error) { if (!(error instanceof WeappConflictError)) throw weappHttpError(); }
      throw weappHttpError();
    }
    return serializeWeappJob(row);
  }
  async logs(projectId: string, id: string, seq: number, limit: number, auth: ProjectAuthContext) {
    await this.record(projectId, id, auth);
    try { return (await new WeappLogRepository(this.database.db).listSince(id, seq, limit)).map(row => WeappLogEventSchema.parse({ ...row, ts: row.ts.toISOString() })); }
    catch { throw weappHttpError(); }
  }
  async qr(projectId: string, id: string, auth: ProjectAuthContext) {
    const row = await this.record(projectId, id, auth);
    if (row.status !== 'succeeded' || !row.qrArtifactKey) throw new NotFoundException('二维码尚不可用。');
    const directory = process.env.FORGEKIT_ARTIFACT_DIR;
    if (!directory || !isAbsolute(directory)) throw weappHttpError();
    try {
      const file = await new LocalFsArtifactStore(directory).open(row.qrArtifactKey, 'qrcode.jpg');
      if (file.size > 1048576) { file.close?.(); throw new Error(); } return file;
    } catch { throw new NotFoundException('二维码制品不可用，请重新预览。'); }
  }
}
function weappHttpError(error?: unknown) {
  if (error instanceof WeappConflictError) return new ConflictException('需要已配置密钥、成功的 mp-weixin 制品且项目无进行中的任务；首次配置或更换 AppID 必须填写新私钥。');
  return new ServiceUnavailableException('微信上传服务暂不可用，请检查服务配置后重试。');
}
export function serializeWeappConfig(row: WeappConfigRow) {
  return WeappConfigSchema.parse({ projectId: row.projectId, appId: row.appId, ipWhitelistNote: row.ipWhitelistNote,
    hasPrivateKey: !!row.encryptedPrivateKey, updatedAt: row.updatedAt.toISOString(), updatedBy: row.updatedBy });
}
export function serializeWeappJob(row: WeappJobRow) {
  return WeappJobSchema.parse({ id: row.id, projectId: row.projectId, buildId: row.buildId, appId: row.appId,
    input: row.input, status: row.status, triggeredBy: row.triggeredBy, createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString(),
    startedAt: row.startedAt?.toISOString() ?? null, finishedAt: row.finishedAt?.toISOString() ?? null, errorCode: row.errorCode, hasQrCode: !!row.qrArtifactKey });
}
