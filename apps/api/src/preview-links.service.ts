import { ConflictException, ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { BuildRepository, BuildTransitionError, PreviewLinkRepository } from '@forgekit/db';
import { PreviewLinkCreateRequestSchema, PreviewLinkCreateResponseSchema, PreviewLinkSchema } from '@forgekit/contracts';
import { DatabaseService } from './database.service';
import { ProjectsService } from './projects.service';
import { InvitationRateLimiter } from './invitation-rate-limiter';
import { PreviewArtifactsService } from './preview-artifacts.service';
import { generatePreviewToken } from './preview-tokens';
import { previewUrl } from './preview-config';
import type { ProjectAuthContext } from './project-auth-context';

@Injectable()
export class PreviewLinksService {
  constructor(@Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(ProjectsService) private readonly projects: ProjectsService,
    @Inject(InvitationRateLimiter) private readonly limiter: InvitationRateLimiter,
    @Inject(PreviewArtifactsService) private readonly artifacts: PreviewArtifactsService) {}
  private get repository() { return new PreviewLinkRepository(this.database.db); }
  private async build(projectId: string, buildId: string, auth: ProjectAuthContext, manage = false) {
    if (auth.mode !== 'oidc') throw new ForbiddenException('预览链接需要已验证的 OIDC 项目成员身份。');
    await this.projects.findById(projectId, auth, manage ? 'preview:manage' : 'preview:read');
    const build = await new BuildRepository(this.database.db).get(buildId);
    if (!build || build.projectId !== projectId) throw new NotFoundException('构建不存在。');
    return build;
  }
  async create(projectId: string, buildId: string, input: unknown, auth: ProjectAuthContext) {
    const { ttlSeconds } = PreviewLinkCreateRequestSchema.parse(input);
    const build = await this.build(projectId, buildId, auth, true);
    if (build.status !== 'succeeded' || !build.artifactKey) throw new ConflictException('仅成功且具有制品的构建可创建预览。');
    if (auth.mode !== 'oidc') throw new ForbiddenException();
    const actorUserId = await this.projects.findUserId(auth);
    if (!actorUserId) throw new ForbiddenException();
    await this.limiter.consume('preview-create', auth.issuer, auth.subject);
    const base = this.artifacts.base;
    await this.artifacts.requireIndex(build.artifactKey);
    const { token, tokenHash } = generatePreviewToken();
    try {
      const row = await this.repository.create({ buildId, createdBy: actorUserId, tokenHash, ttlSeconds }, { projectId, actorUserId });
      return PreviewLinkCreateResponseSchema.parse({ previewLink: serializePreviewLink(row), token, url: previewUrl(base, token) });
    } catch (error) {
      if (error instanceof BuildTransitionError) throw new ConflictException('构建制品已不可用。');
      throw error;
    }
  }
  async list(projectId: string, buildId: string, auth: ProjectAuthContext) {
    await this.build(projectId, buildId, auth);
    return (await this.repository.listActive(buildId)).map(serializePreviewLink);
  }
  async revoke(projectId: string, buildId: string, linkId: string, auth: ProjectAuthContext): Promise<void> {
    await this.build(projectId, buildId, auth, true);
    if (auth.mode !== 'oidc') throw new ForbiddenException();
    const actorUserId = await this.projects.findUserId(auth);
    if (!actorUserId) throw new ForbiddenException();
    await this.limiter.consume('preview-revoke', auth.issuer, auth.subject);
    await this.repository.revoke(buildId, linkId, { projectId, actorUserId });
  }
}
export function serializePreviewLink(row: Awaited<ReturnType<PreviewLinkRepository['listActive']>>[number]) {
  return PreviewLinkSchema.parse({ ...row, createdAt: row.createdAt.toISOString(), expiresAt: row.expiresAt.toISOString(),
    revokedAt: row.revokedAt?.toISOString() ?? null, lastAccessedAt: row.lastAccessedAt?.toISOString() ?? null });
}
