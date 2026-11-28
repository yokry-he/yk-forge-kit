import { BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { BuildLogRepository, BuildRepository, BuildTransitionError } from '@forgekit/db';
import { BuildSchema, BuildLogEventSchema, classifyBuildFailure } from '@forgekit/contracts';
import { DatabaseService } from './database.service';
import { ProjectsService } from './projects.service';
import { BuildQueueService } from './build-queue.service';
import { InvitationRateLimiter } from './invitation-rate-limiter';
import type { ProjectAuthContext } from './project-auth-context';

@Injectable()
export class BuildsService {
  constructor(@Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(ProjectsService) private readonly projects: ProjectsService,
    @Inject(BuildQueueService) private readonly queue: BuildQueueService,
    @Inject(InvitationRateLimiter) private readonly limiter: InvitationRateLimiter) {}
  private get repository() { return new BuildRepository(this.database.db); }
  private async actor(auth: ProjectAuthContext): Promise<string> {
    if (auth.mode !== 'oidc') throw new ForbiddenException('构建操作需要已验证的 OIDC 项目成员身份。');
    const id = await this.projects.findUserId(auth);
    if (!id) throw new ForbiddenException('项目成员身份不存在。');
    return id;
  }
  async trigger(projectId: string, sourceRef: string, auth: ProjectAuthContext, environmentName?: string, target?: 'h5' | 'mp-weixin' | 'mp-alipay') {
    const actorId = await this.actor(auth);
    const project = await this.projects.findById(projectId, auth, 'build:run');
    if ((target === 'mp-weixin' || target === 'mp-alipay') && project.template !== 'uniapp') throw new BadRequestException('仅 uniapp 项目支持小程序构建。');
    this.queue.requireConfigured();
    if (auth.mode === 'oidc') await this.limiter.consume('build-trigger', auth.issuer, auth.subject);
    const repository = this.repository;
    const row = await repository.create({ projectId, template: project.template, sourceRef, triggeredBy: actorId, ...(target ? { target } : {}) }, true, ...(environmentName === undefined ? [] : [environmentName]));
    try { await this.queue.enqueue(row.id); }
    catch (error) {
      // An ambiguous enqueue may already have reached Redis. The CAS guard preserves a worker's result.
      try { await repository.updateStatus(row.id, 'queued', 'failed', { errorMessage: 'queue_enqueue_failed',
        diagnosis: classifyBuildFailure({ errorCodes: ['queue_enqueue_failed'], logs: [] }) }); }
      catch (transitionError) { if (!(transitionError instanceof BuildTransitionError)) throw transitionError; }
      throw error;
    }
    return serializeBuild(row);
  }
  async list(projectId: string, options: { beforeNumber?: number; limit?: number }, auth: ProjectAuthContext) {
    await this.projects.findById(projectId, auth, 'build:read');
    return (await this.repository.listByProject(projectId, options)).map(serializeBuild);
  }
  private async authorizedBuild(projectId: string, buildId: string, auth: ProjectAuthContext, permission: 'build:read' | 'build:cancel') {
    await this.projects.findById(projectId, auth, permission);
    const row = await this.repository.get(buildId);
    if (!row || row.projectId !== projectId) throw new NotFoundException('构建不存在。');
    return row;
  }
  async get(projectId: string, buildId: string, auth: ProjectAuthContext) {
    return serializeBuild(await this.authorizedBuild(projectId, buildId, auth, 'build:read'));
  }
  async cancel(projectId: string, buildId: string, auth: ProjectAuthContext) {
    const actorId = await this.actor(auth);
    const row = await this.authorizedBuild(projectId, buildId, auth, 'build:cancel');
    if (auth.mode === 'oidc') await this.limiter.consume('build-cancel', auth.issuer, auth.subject);
    if (row.status === 'canceled') return serializeBuild(row);
    if (row.status !== 'queued' && row.status !== 'running') throw new ConflictException('已结束的构建不能取消。');
    try { return serializeBuild(await this.repository.updateStatus(buildId, row.status, 'canceled', {}, actorId)); }
    catch (error) {
      if (!(error instanceof BuildTransitionError)) throw error;
      // A dequeue may race queued cancellation. Retry once against the current guarded state.
      const current = await this.repository.get(buildId);
      if (current?.status === 'canceled') return serializeBuild(current);
      if (current?.status === 'running' && row.status === 'queued') {
        try { return serializeBuild(await this.repository.updateStatus(buildId, 'running', 'canceled', {}, actorId)); }
        catch (retryError) { if (!(retryError instanceof BuildTransitionError)) throw retryError; }
      }
      throw new ConflictException('构建状态已变化，请刷新后重试。');
    }
  }
  async logs(projectId: string, buildId: string, seq: number, limit: number, auth: ProjectAuthContext) {
    await this.authorizedBuild(projectId, buildId, auth, 'build:read');
    return (await new BuildLogRepository(this.database.db).listSince(buildId, seq, limit))
      .map((row) => BuildLogEventSchema.parse({ ...row, ts: row.ts.toISOString() }));
  }
}
function serializeBuild(row: NonNullable<Awaited<ReturnType<BuildRepository['get']>>>) {
  return BuildSchema.parse({ ...row, queuedAt: row.queuedAt.toISOString(), startedAt: row.startedAt?.toISOString() ?? null,
    finishedAt: row.finishedAt?.toISOString() ?? null, createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString() });
}
