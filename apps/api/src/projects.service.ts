import { randomUUID } from 'node:crypto';
import { ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { externalIdentities, projectMemberships, projects, users } from '@forgekit/db';
import { canAccessProject, type ProjectPermission } from '@forgekit/identity-core';
import { DatabaseService } from './database.service';
import type { ProjectAuthContext } from './project-auth-context';

export interface CreateProjectInput {
  name: string;
  template: 'vue-web';
  features: Array<'theme' | 'router' | 'pinia'>;
}

/** MySQL's default collation may be case-insensitive; OIDC identities are case-sensitive. */
function subjectMatches(auth: Extract<ProjectAuthContext, { mode: 'oidc' }>) {
  return and(
    sql`BINARY ${externalIdentities.issuer} = BINARY ${auth.issuer}`,
    sql`BINARY ${externalIdentities.subject} = BINARY ${auth.subject}`,
  );
}

@Injectable()
export class ProjectsService {
  constructor(private readonly database: DatabaseService) {}

  async create(input: CreateProjectInput, auth: ProjectAuthContext) {
    const db = this.database.db;
    const ownerId = auth.mode === 'oidc' ? await this.ensureUser(auth) : null;
    try {
      await db.transaction(async (tx) => {
        const projectId = randomUUID();
        await tx.insert(projects).values({
          id: projectId, slug: input.name, name: input.name,
          template: input.template, features: input.features,
        });
        if (ownerId) await tx.insert(projectMemberships).values({ projectId, userId: ownerId, role: 'owner' });
      });
    } catch (error) {
      // mysql2 errors may be wrapped by Drizzle. Only translate the known unique constraint error.
      if (hasMysqlCode(error, 'ER_DUP_ENTRY')) throw new ConflictException('项目名称已存在。');
      throw error;
    }
    return this.findBySlug(input.name, auth);
  }

  async list(auth: ProjectAuthContext) {
    const db = this.database.db;
    if (auth.mode === 'local') {
      return db.select().from(projects).orderBy(desc(projects.createdAt), desc(projects.id)).limit(50);
    }
    const rows = await db.select({ project: projects }).from(projects)
      .innerJoin(projectMemberships, eq(projectMemberships.projectId, projects.id))
      .innerJoin(externalIdentities, eq(externalIdentities.userId, projectMemberships.userId))
      .where(and(subjectMatches(auth), inArray(projectMemberships.role, ['owner', 'editor', 'viewer'])))
      .orderBy(desc(projects.createdAt), desc(projects.id)).limit(50);
    return rows.map((row) => row.project);
  }

  async findBySlug(slug: string, auth: ProjectAuthContext, permission: ProjectPermission = 'project:read') {
    const db = this.database.db;
    if (auth.mode === 'local') {
      const [project] = await db.select().from(projects).where(eq(projects.slug, slug)).limit(1);
      if (!project) throw new NotFoundException('项目不存在。');
      return project;
    }
    const [row] = await db.select({ project: projects, role: projectMemberships.role }).from(projects)
      .innerJoin(projectMemberships, eq(projectMemberships.projectId, projects.id))
      .innerJoin(externalIdentities, eq(externalIdentities.userId, projectMemberships.userId))
      .where(and(eq(projects.slug, slug), subjectMatches(auth))).limit(1);
    if (!row) throw new NotFoundException('项目不存在或无权访问。');
    if (!canAccessProject(row.role, permission)) throw new ForbiddenException('当前项目角色无权执行此操作。');
    return row.project;
  }

  async findUserId(auth: Extract<ProjectAuthContext, { mode: 'oidc' }>): Promise<string | null> {
    const [identity] = await this.database.db.select({ userId: externalIdentities.userId }).from(externalIdentities)
      .where(subjectMatches(auth)).limit(1);
    return identity?.userId ?? null;
  }

  async ensureUser(auth: Extract<ProjectAuthContext, { mode: 'oidc' }>): Promise<string> {
    const db = this.database.db;
    const existing = await this.findUserId(auth);
    if (existing) return existing;
    const userId = randomUUID();
    try {
      await db.transaction(async (tx) => {
        await tx.insert(users).values({ id: userId, displayName: 'ForgeKit 用户' });
        await tx.insert(externalIdentities).values({ userId, issuer: auth.issuer, subject: auth.subject });
      });
      return userId;
    } catch (error) {
      if (!hasMysqlCode(error, 'ER_DUP_ENTRY')) throw error;
      const concurrent = await this.findUserId(auth);
      if (concurrent) return concurrent;
      // A case-folding collision is not permission to reuse a different identity.
      throw new ConflictException('身份标识冲突，请联系管理员检查数据库排序规则。');
    }
  }
}

function hasMysqlCode(error: unknown, code: string): boolean {
  if (!error || typeof error !== 'object') return false;
  const value = error as { code?: unknown; cause?: unknown };
  return value.code === code || (value.cause !== error && hasMysqlCode(value.cause, code));
}
