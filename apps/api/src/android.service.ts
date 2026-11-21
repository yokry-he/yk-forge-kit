import { BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { isAbsolute } from 'node:path';
import { LocalFsArtifactStore } from '@forgekit/artifact-store';
import { AndroidConfigSchema, AndroidJobSchema, AndroidLogEventSchema, type AndroidConfigInput, type AndroidJobInput } from '@forgekit/contracts';
import { AndroidRepository, AndroidLogRepository, AndroidConflictError, deployEncryptionKey, encryptAndroidSigning, type AndroidConfigRow, type AndroidJobRow } from '@forgekit/db';
import { DatabaseService } from './database.service';
import { ProjectsService } from './projects.service';
import { InvitationRateLimiter } from './invitation-rate-limiter';
import { AndroidQueueService } from './android-queue.service';
import type { ProjectAuthContext } from './project-auth-context';
@Injectable()
export class AndroidService {
  constructor(@Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(ProjectsService) private readonly projects: ProjectsService,
    @Inject(AndroidQueueService) private readonly queue: AndroidQueueService,
    @Inject(InvitationRateLimiter) private readonly limiter: InvitationRateLimiter) {}
  private get repository() { return new AndroidRepository(this.database.db); }
  private async authorize(projectId: string, auth: ProjectAuthContext, permission: 'deploy:read' | 'deploy:manage' | 'deploy:run' = 'deploy:read') {
    if (auth.mode !== 'oidc') throw new ForbiddenException('Android 打包需要已验证的项目成员身份。');
    const project = await this.projects.findById(projectId, auth, permission);
    if (project.template !== 'uniapp') throw new BadRequestException('仅 uniapp 项目支持 Android 打包。');
    const actor = await this.projects.findUserId(auth);
    if (!actor) throw new ForbiddenException('项目成员身份不存在。');
    if (permission !== 'deploy:read') await this.limiter.consume('android-write', auth.issuer, auth.subject);
    return actor;
  }
  async config(projectId: string, auth: ProjectAuthContext) {
    await this.authorize(projectId, auth);
    try { const row = await this.repository.config(projectId); return row ? serializeAndroidConfig(row) : null; }
    catch { throw new ServiceUnavailableException('Android 配置暂不可用。'); }
  }
  async save(projectId: string, input: AndroidConfigInput, auth: ProjectAuthContext) {
    const actor = await this.authorize(projectId, auth, 'deploy:manage');
    let key: Buffer | undefined;
    try {
      key = deployEncryptionKey(process.env.FORGEKIT_DEPLOY_ENCRYPTION_KEY);
      const { signing, ...metadata } = input;
      const encrypted = signing === undefined ? undefined : encryptAndroidSigning(JSON.stringify(signing), key, projectId);
      return serializeAndroidConfig(await this.repository.save(projectId, metadata, encrypted, actor));
    } catch (error) {
      if (error instanceof BadRequestException) throw error;
      throw androidHttpError(error);
    } finally { key?.fill(0); }
  }
  async remove(projectId: string, auth: ProjectAuthContext) {
    const actor = await this.authorize(projectId, auth, 'deploy:manage');
    try { await this.repository.remove(projectId, actor); } catch (error) { throw androidHttpError(error); }
  }
  async list(projectId: string, auth: ProjectAuthContext) {
    await this.authorize(projectId, auth);
    try { return (await this.repository.list(projectId)).map(serializeAndroidJob); } catch { throw androidHttpError(); }
  }
  async record(projectId: string, id: string, auth: ProjectAuthContext) {
    await this.authorize(projectId, auth);
    let row;
    try { row = await this.repository.get(id); } catch { throw androidHttpError(); }
    if (!row || row.projectId !== projectId) throw new NotFoundException('Android 打包任务不存在。'); return row;
  }
  async get(projectId: string, id: string, auth: ProjectAuthContext) { return serializeAndroidJob(await this.record(projectId, id, auth)); }
  async trigger(projectId: string, input: AndroidJobInput, auth: ProjectAuthContext) {
    const actor = await this.authorize(projectId, auth, 'deploy:run');
    if (!process.env.FORGEKIT_ANDROID_IMAGE) throw new ServiceUnavailableException('Android 打包镜像尚未配置。');
    this.queue.requireConfigured();
    try { deployEncryptionKey(process.env.FORGEKIT_DEPLOY_ENCRYPTION_KEY).fill(0); } catch { throw androidHttpError(); }
    let row;
    try { row = await this.repository.create(projectId, input, actor); } catch (error) { throw androidHttpError(error); }
    try { await this.queue.enqueue(row.id); }
    catch {
      try { await this.repository.transition(row.id, 'queued', 'failed', 'android_enqueue_failed'); }
      catch (error) { if (!(error instanceof AndroidConflictError)) throw androidHttpError(); }
      throw androidHttpError();
    }
    return serializeAndroidJob(row);
  }
  async cancel(projectId: string, id: string, auth: ProjectAuthContext) {
    const actor = await this.authorize(projectId, auth, 'deploy:run');
    const row = await this.repository.get(id).catch(() => { throw androidHttpError(); });
    if (!row || row.projectId !== projectId) throw new NotFoundException('Android 打包任务不存在。');
    try { await this.repository.cancel(projectId, id, actor); } catch (error) { throw androidHttpError(error); }
    return this.get(projectId, id, auth);
  }
  async logs(projectId: string, id: string, seq: number, limit: number, auth: ProjectAuthContext) {
    await this.record(projectId, id, auth);
    try { return (await new AndroidLogRepository(this.database.db).listSince(id, seq, limit)).map(row => AndroidLogEventSchema.parse({ ...row, ts: row.ts.toISOString() })); }
    catch { throw androidHttpError(); }
  }
  async artifact(projectId: string, id: string, auth: ProjectAuthContext) {
    const row = await this.record(projectId, id, auth);
    if (row.status !== 'succeeded' || !row.artifactKey || !row.artifact) throw new NotFoundException('安装包尚不可用。');
    const directory = process.env.FORGEKIT_ARTIFACT_DIR;
    if (!directory || !isAbsolute(directory)) throw androidHttpError();
    try {
      const file = await new LocalFsArtifactStore(directory).open(row.artifactKey, `app.${row.artifact.kind}`);
      if (file.size !== row.artifact.size) { file.close?.(); throw new Error(); }
      return { ...file, kind: row.artifact.kind };
    } catch { throw new NotFoundException('安装包制品不可用，请重新打包。'); }
  }
}
function androidHttpError(error?: unknown) {
  if (error instanceof AndroidConflictError) return new ConflictException('需要有效 Android 配置；release 需要签名，项目不能存在进行中的任务。');
  return new ServiceUnavailableException('Android 打包服务暂不可用，请检查服务配置后重试。');
}
export function serializeAndroidConfig(row: AndroidConfigRow) {
  return AndroidConfigSchema.parse({ projectId: row.projectId, settings: row.settings,
    hasSigning: !!row.encryptedSigning, updatedAt: row.updatedAt.toISOString(), updatedBy: row.updatedBy });
}
export function serializeAndroidJob(row: AndroidJobRow) {
  return AndroidJobSchema.parse({ id: row.id, projectId: row.projectId, settings: row.settings,
    input: row.input, status: row.status, triggeredBy: row.triggeredBy, createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString(),
    startedAt: row.startedAt?.toISOString() ?? null, finishedAt: row.finishedAt?.toISOString() ?? null, errorCode: row.errorCode, artifact: row.artifact });
}
