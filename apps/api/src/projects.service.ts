import { randomUUID } from 'node:crypto';
import { Inject, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { and, desc, eq, inArray } from 'drizzle-orm';
import { externalIdentities, projectMemberships, projects } from '@forgekit/db';
import { canAccessProject, type ProjectPermission } from '@forgekit/identity-core';
import { DatabaseService } from './database.service';
import type { ProjectAuthContext } from './project-auth-context';
import { IdentityAccountsService, identityMatches } from './identity-accounts.service';

import type { ProjectOptions } from '@forgekit/project-core';

export type CreateProjectInput = ProjectOptions;

@Injectable()
export class ProjectsService {
  constructor(@Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(IdentityAccountsService) private readonly identities: IdentityAccountsService = new IdentityAccountsService(database)) {}

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
      .where(and(identityMatches(auth), inArray(projectMemberships.role, ['owner', 'editor', 'viewer'])))
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
      .where(and(eq(projects.slug, slug), identityMatches(auth))).limit(1);
    if (!row) throw new NotFoundException('项目不存在或无权访问。');
    if (!canAccessProject(row.role, permission)) throw new ForbiddenException('当前项目角色无权执行此操作。');
    return row.project;
  }

  async findUserId(auth: Extract<ProjectAuthContext, { mode: 'oidc' }>): Promise<string | null> {
    return this.identities.findUserId(auth);
  }

  async ensureUser(auth: Extract<ProjectAuthContext, { mode: 'oidc' }>): Promise<string> {
    return this.identities.ensureUser(auth);
  }
}

function hasMysqlCode(error: unknown, code: string): boolean {
  if (!error || typeof error !== 'object') return false;
  const value = error as { code?: unknown; cause?: unknown };
  return value.code === code || (value.cause !== error && hasMysqlCode(value.cause, code));
}
