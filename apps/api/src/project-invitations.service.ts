import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { ConflictException, ForbiddenException, GoneException, Injectable, NotFoundException } from '@nestjs/common';
import { and, desc, eq } from 'drizzle-orm';
import { projectInvitationAudit, projectInvitations, projectMemberships, projects } from '@forgekit/db';
import { DatabaseService } from './database.service';
import type { ProjectAuthContext } from './project-auth-context';
import { ProjectsService } from './projects.service';
import { InvitationRateLimiter } from './invitation-rate-limiter';

const INVITATION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const tokenDigest = (token: string) => createHash('sha256').update(token, 'utf8').digest('hex');

@Injectable()
export class ProjectInvitationsService {
  constructor(private readonly database: DatabaseService, private readonly projects: ProjectsService,
    private readonly limiter: InvitationRateLimiter) {}

  async create(slug: string, role: 'editor' | 'viewer', auth: ProjectAuthContext) {
    if (auth.mode !== 'oidc') throw new ForbiddenException('项目邀请需要 OIDC 登录。');
    const project = await this.projects.findBySlug(slug, auth, 'member:manage');
    const actorId = await this.projects.findUserId(auth);
    if (!actorId) throw new ForbiddenException('当前用户身份未关联。');
    await this.limiter.consume('create', auth.issuer, auth.subject);
    const code = randomBytes(32).toString('base64url');
    const expiresAt = new Date(Date.now() + INVITATION_TTL_MS);
    const invitationId = randomUUID();
    await this.database.db.transaction(async (tx) => {
      await tx.insert(projectInvitations).values({
        id: invitationId, projectId: project.id, tokenHash: tokenDigest(code),
        role, createdByUserId: actorId, expiresAt,
      });
      await tx.insert(projectInvitationAudit).values({
        projectId: project.id, invitationId, actorUserId: actorId, action: 'created',
      });
    });
    // This is the only response containing the plaintext code; never persist or log it.
    return { code, role, expiresAt };
  }

  async list(slug: string, auth: ProjectAuthContext) {
    if (auth.mode !== 'oidc') throw new ForbiddenException('请先使用 OIDC 登录。');
    const project = await this.projects.findBySlug(slug, auth, 'member:manage');
    return this.database.db.select({
      id: projectInvitations.id, role: projectInvitations.role,
      createdAt: projectInvitations.createdAt, expiresAt: projectInvitations.expiresAt,
      redeemedAt: projectInvitations.redeemedAt, revokedAt: projectInvitations.revokedAt,
    }).from(projectInvitations).where(eq(projectInvitations.projectId, project.id))
      .orderBy(desc(projectInvitations.createdAt)).limit(50);
  }

  async revoke(slug: string, invitationId: string, auth: ProjectAuthContext) {
    if (auth.mode !== 'oidc') throw new ForbiddenException('撤销邀请需要 OIDC 登录。');
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(invitationId)) {
      throw new NotFoundException('邀请码不存在。');
    }
    const project = await this.projects.findBySlug(slug, auth, 'member:manage');
    const actorId = await this.projects.findUserId(auth);
    if (!actorId) throw new ForbiddenException('当前用户身份未关联。');
    return this.database.db.transaction(async (tx) => {
      const [invitation] = await tx.select().from(projectInvitations)
        .where(and(eq(projectInvitations.id, invitationId), eq(projectInvitations.projectId, project.id)))
        .limit(1).for('update');
      if (!invitation) throw new NotFoundException('邀请码不存在。');
      if (invitation.revokedAt) throw new ConflictException('邀请码已经撤销。');
      if (invitation.redeemedAt) throw new ConflictException('已兑换的邀请码不能撤销。');
      if (invitation.expiresAt.getTime() <= Date.now()) throw new GoneException('邀请码已过期。');
      const revokedAt = new Date();
      await tx.update(projectInvitations).set({ revokedAt, revokedByUserId: actorId })
        .where(eq(projectInvitations.id, invitationId));
      await tx.insert(projectInvitationAudit).values({
        projectId: project.id, invitationId, actorUserId: actorId, action: 'revoked',
      });
      return { id: invitationId, revokedAt };
    });
  }

  async redeem(code: string, auth: ProjectAuthContext) {
    if (auth.mode !== 'oidc') throw new ForbiddenException('只有已登录用户才能兑换邀请。');
    const hash = tokenDigest(code);
    const db = this.database.db;
    // Reject invalid/expired codes before provisioning a user identity.
    const [candidate] = await db.select({ expiresAt: projectInvitations.expiresAt, redeemedAt: projectInvitations.redeemedAt, revokedAt: projectInvitations.revokedAt })
      .from(projectInvitations).where(eq(projectInvitations.tokenHash, hash)).limit(1);
    if (!candidate) throw new NotFoundException('邀请码无效。');
    if (candidate.redeemedAt) throw new ConflictException('邀请码已被使用。');
    if (candidate.revokedAt) throw new GoneException('邀请码已撤销。');
    if (candidate.expiresAt.getTime() <= Date.now()) throw new GoneException('邀请码已过期。');
    const userId = await this.projects.ensureUser(auth);
    return db.transaction(async (tx) => {
      const [invitation] = await tx.select().from(projectInvitations)
        .where(eq(projectInvitations.tokenHash, hash)).limit(1).for('update');
      if (!invitation) throw new NotFoundException('邀请码无效。');
      if (invitation.redeemedAt) throw new ConflictException('邀请码已被使用。');
      if (invitation.revokedAt) throw new GoneException('邀请码已撤销。');
      if (invitation.expiresAt.getTime() <= Date.now()) throw new GoneException('邀请码已过期。');
      const [existing] = await tx.select({ userId: projectMemberships.userId }).from(projectMemberships)
        .where(and(eq(projectMemberships.projectId, invitation.projectId), eq(projectMemberships.userId, userId))).limit(1);
      if (existing) throw new ConflictException('你已经是该项目成员。');
      await tx.insert(projectMemberships).values({ projectId: invitation.projectId, userId, role: invitation.role });
      await tx.update(projectInvitations).set({ redeemedAt: new Date(), redeemedByUserId: userId })
        .where(eq(projectInvitations.id, invitation.id));
      await tx.insert(projectInvitationAudit).values({
        projectId: invitation.projectId, invitationId: invitation.id, actorUserId: userId, action: 'redeemed',
      });
      const [project] = await tx.select({ slug: projects.slug }).from(projects)
        .where(eq(projects.id, invitation.projectId)).limit(1);
      if (!project) throw new NotFoundException('被邀请的项目不存在。');
      return { projectSlug: project.slug, role: invitation.role };
    });
  }

  /** Called before validation so malformed redemption bodies also consume quota. */
  async limitRedemption(auth: ProjectAuthContext): Promise<void> {
    if (auth.mode !== 'oidc') throw new ForbiddenException('只有已登录用户才能兑换邀请。');
    await this.limiter.consume('redeem', auth.issuer, auth.subject);
  }
}
