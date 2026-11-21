import { BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { createPrivateKey } from 'node:crypto';
import { isAbsolute } from 'node:path';
import { LocalFsArtifactStore } from '@forgekit/artifact-store';
import { qrImageType, AlipayConfigSchema, AlipayJobSchema, AlipayLogEventSchema, type AlipayConfigInput, type AlipayJobInput } from '@forgekit/contracts';
import { AlipayRepository, AlipayLogRepository, AlipayConflictError, deployEncryptionKey, encryptAlipayKey, type AlipayConfigRow, type AlipayJobRow } from '@forgekit/db';
import { DatabaseService } from './database.service';
import { ProjectsService } from './projects.service';
import { InvitationRateLimiter } from './invitation-rate-limiter';
import { AlipayQueueService } from './alipay-queue.service';
import type { ProjectAuthContext } from './project-auth-context';
@Injectable()
export class AlipayService {
  constructor(@Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(ProjectsService) private readonly projects: ProjectsService,
    @Inject(AlipayQueueService) private readonly queue: AlipayQueueService,
    @Inject(InvitationRateLimiter) private readonly limiter: InvitationRateLimiter) {}
  private get repository() { return new AlipayRepository(this.database.db); }
  private async authorize(projectId: string, auth: ProjectAuthContext, permission: 'deploy:read' | 'deploy:manage' | 'deploy:run' = 'deploy:read') {
    if (auth.mode !== 'oidc') throw new ForbiddenException('小程序上传需要已验证的项目成员身份。');
    const project = await this.projects.findById(projectId, auth, permission);
    if (project.template !== 'uniapp') throw new BadRequestException('仅 uniapp 项目支持支付宝上传。');
    const actor = await this.projects.findUserId(auth);
    if (!actor) throw new ForbiddenException('项目成员身份不存在。');
    if (permission !== 'deploy:read') await this.limiter.consume('alipay-write', auth.issuer, auth.subject);
    return actor;
  }
  async config(projectId: string, auth: ProjectAuthContext) {
    await this.authorize(projectId, auth);
    try { const row = await this.repository.config(projectId); return row ? serializeAlipayConfig(row) : null; }
    catch { throw new ServiceUnavailableException('支付宝配置暂不可用。'); }
  }
  async save(projectId: string, input: AlipayConfigInput, auth: ProjectAuthContext) {
    const actor = await this.authorize(projectId, auth, 'deploy:manage');
    let key: Buffer | undefined;
    try {
      key = deployEncryptionKey(process.env.FORGEKIT_DEPLOY_ENCRYPTION_KEY);
      const { privateKey: submittedKey, ...metadata } = input;
      let privateKey = submittedKey;
      if (privateKey !== undefined) {
        try {
          const parsed = createPrivateKey({ key: privateKey, passphrase: '' });
          if (parsed.asymmetricKeyType !== 'rsa' || (parsed.asymmetricKeyDetails?.modulusLength ?? 0) < 2048 || !privateKey.startsWith('-----BEGIN ')) throw new Error();
          // minidev expects an unencrypted PKCS8 PEM; normalize accepted RSA PEM in memory.
          privateKey = parsed.export({ format: 'pem', type: 'pkcs8' }).toString();
        } catch { throw new BadRequestException('请粘贴有效的支付宝上传 RSA PEM 私钥。'); }
      }
      const encrypted = privateKey === undefined ? undefined : encryptAlipayKey(privateKey, key, projectId);
      return serializeAlipayConfig(await this.repository.save(projectId, metadata, encrypted, actor));
    } catch (error) {
      if (error instanceof BadRequestException) throw error;
      throw alipayHttpError(error);
    } finally { key?.fill(0); }
  }
  async remove(projectId: string, auth: ProjectAuthContext) {
    const actor = await this.authorize(projectId, auth, 'deploy:manage');
    try { await this.repository.remove(projectId, actor); } catch (error) { throw alipayHttpError(error); }
  }
  async list(projectId: string, auth: ProjectAuthContext) {
    await this.authorize(projectId, auth);
    try { return (await this.repository.list(projectId)).map(serializeAlipayJob); } catch { throw alipayHttpError(); }
  }
  async record(projectId: string, id: string, auth: ProjectAuthContext) {
    await this.authorize(projectId, auth);
    let row;
    try { row = await this.repository.get(id); } catch { throw alipayHttpError(); }
    if (!row || row.projectId !== projectId) throw new NotFoundException('支付宝上传任务不存在。'); return row;
  }
  async get(projectId: string, id: string, auth: ProjectAuthContext) { return serializeAlipayJob(await this.record(projectId, id, auth)); }
  async trigger(projectId: string, input: AlipayJobInput, auth: ProjectAuthContext) {
    const actor = await this.authorize(projectId, auth, 'deploy:run');
    this.queue.requireConfigured();
    try { deployEncryptionKey(process.env.FORGEKIT_DEPLOY_ENCRYPTION_KEY).fill(0); } catch { throw alipayHttpError(); }
    let row;
    try { row = await this.repository.create(projectId, input, actor); } catch (error) { throw alipayHttpError(error); }
    try { await this.queue.enqueue(row.id); }
    catch {
      try { await this.repository.transition(row.id, 'queued', 'failed', 'alipay_enqueue_failed'); }
      catch (error) { if (!(error instanceof AlipayConflictError)) throw alipayHttpError(); }
      throw alipayHttpError();
    }
    return serializeAlipayJob(row);
  }
  async logs(projectId: string, id: string, seq: number, limit: number, auth: ProjectAuthContext) {
    await this.record(projectId, id, auth);
    try { return (await new AlipayLogRepository(this.database.db).listSince(id, seq, limit)).map(row => AlipayLogEventSchema.parse({ ...row, ts: row.ts.toISOString() })); }
    catch { throw alipayHttpError(); }
  }
  async qr(projectId: string, id: string, auth: ProjectAuthContext) {
    const row = await this.record(projectId, id, auth);
    if (row.status !== 'succeeded' || !row.qrArtifactKey) throw new NotFoundException('二维码尚不可用。');
    const directory = process.env.FORGEKIT_ARTIFACT_DIR;
    if (!directory || !isAbsolute(directory)) throw alipayHttpError();
    try {
      const file = await new LocalFsArtifactStore(directory).open(row.qrArtifactKey, 'qrcode.img');
      try {
        if (file.size > 1048576) throw new Error();
        const chunks: Buffer[] = []; let size = 0;
        for await (const chunk of file.body) { size += chunk.length; if (size > 1048576) throw new Error(); chunks.push(chunk); }
        const data = Buffer.concat(chunks), type = qrImageType(data);
        return { body: [data], size: data.length, type };
      } finally { file.close?.(); }
    } catch { throw new NotFoundException('二维码制品不可用，请重新预览。'); }
  }
}
function alipayHttpError(error?: unknown) {
  if (error instanceof AlipayConflictError) return new ConflictException('需要已配置密钥、成功的 mp-alipay 制品且项目无进行中的任务；首次配置或更换 AppID / toolId 必须填写新私钥。');
  return new ServiceUnavailableException('支付宝上传服务暂不可用，请检查服务配置后重试。');
}
export function serializeAlipayConfig(row: AlipayConfigRow) {
  return AlipayConfigSchema.parse({ projectId: row.projectId, appId: row.appId, toolId: row.toolId,
    hasPrivateKey: !!row.encryptedPrivateKey, updatedAt: row.updatedAt.toISOString(), updatedBy: row.updatedBy });
}
export function serializeAlipayJob(row: AlipayJobRow) {
  return AlipayJobSchema.parse({ id: row.id, projectId: row.projectId, buildId: row.buildId, appId: row.appId, toolId: row.toolId,
    input: row.input, status: row.status, triggeredBy: row.triggeredBy, createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString(),
    startedAt: row.startedAt?.toISOString() ?? null, finishedAt: row.finishedAt?.toISOString() ?? null, errorCode: row.errorCode, hasQrCode: !!row.qrArtifactKey });
}
