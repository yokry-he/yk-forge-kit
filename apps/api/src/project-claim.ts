import { and, eq, isNull, sql } from 'drizzle-orm';
import { externalIdentities, projectMemberAudit, projectMemberships, projects } from '@forgekit/db';
import type { DatabaseClient } from '@forgekit/db';

/** Audit actor recorded for operator-run claims; it is not a user ID and cannot sign in. */
export const OPERATOR_CLAIM_ACTOR = 'operator-cli';

export interface ClaimRequest { slug: string; issuer: string; subject: string }
export interface ClaimResult { applied: boolean; projectId: string; slug: string; userId: string }

export class ProjectClaimError extends Error {
  constructor(message: string) { super(message); this.name = 'ProjectClaimError'; }
}

type Db = DatabaseClient['db'];

/** Projects created before OIDC (e.g. in local mode) have no members and are unreachable for OIDC users. */
export async function listUnownedProjects(db: Db) {
  return db.select({ id: projects.id, slug: projects.slug, name: projects.name, createdAt: projects.createdAt })
    .from(projects).leftJoin(projectMemberships, eq(projectMemberships.projectId, projects.id))
    .where(isNull(projectMemberships.id)).orderBy(projects.createdAt);
}

/**
 * Explicit, operator-only claim of one member-less legacy project for one existing OIDC account.
 * Never automatic: the operator names the project and the exact issuer + subject. Without `apply`
 * the function only validates and reports. The project row is locked so concurrent claims serialize.
 */
export async function claimUnownedProject(db: Db, request: ClaimRequest, options: { apply: boolean }): Promise<ClaimResult> {
  // Issuer and subject are matched byte-for-byte exactly as the API stores them; never normalize them.
  const { slug, issuer, subject } = request;
  if (!slug || !issuer || !subject) throw new ProjectClaimError('必须同时提供 --slug、--issuer 与 --subject。');
  let issuerUrl: URL;
  try { issuerUrl = new URL(issuer); } catch { throw new ProjectClaimError('issuer 必须是完整 URL，与 API 的 OIDC_ISSUER 完全一致。'); }
  if (!['https:', 'http:'].includes(issuerUrl.protocol)) throw new ProjectClaimError('issuer 必须是 HTTP(S) URL。');

  return db.transaction(async (tx) => {
    const [project] = await tx.select({ id: projects.id, slug: projects.slug }).from(projects)
      .where(eq(projects.slug, slug)).limit(1).for('update');
    if (!project) throw new ProjectClaimError(`项目 ${slug} 不存在。`);
    const [member] = await tx.select({ id: projectMemberships.id }).from(projectMemberships)
      .where(eq(projectMemberships.projectId, project.id)).limit(1);
    if (member) throw new ProjectClaimError(`项目 ${slug} 已有成员，不能认领；请由现有 Owner 通过邀请码添加成员。`);
    const [identity] = await tx.select({ userId: externalIdentities.userId }).from(externalIdentities)
      .where(and(sql`BINARY ${externalIdentities.issuer} = BINARY ${issuer}`, sql`BINARY ${externalIdentities.subject} = BINARY ${subject}`))
      .limit(1);
    if (!identity) {
      throw new ProjectClaimError('该 issuer + subject 尚无 YKForgeKit 账户：请先用此身份登录控制台完成账户初始化，再执行认领。');
    }
    const result = { projectId: project.id, slug: project.slug, userId: identity.userId };
    if (!options.apply) return { applied: false, ...result };
    await tx.insert(projectMemberships).values({ projectId: project.id, userId: identity.userId, role: 'owner' });
    await tx.insert(projectMemberAudit).values({ projectId: project.id, actorUserId: OPERATOR_CLAIM_ACTOR,
      targetUserId: identity.userId, previousRole: 'none', nextRole: 'owner' });
    return { applied: true, ...result };
  });
}
