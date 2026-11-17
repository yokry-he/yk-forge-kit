import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import { projectMemberAudit, projectMemberships, users } from '@forgekit/db';
import { canManageMembership, type ProjectRole } from '@forgekit/identity-core';
import { DatabaseService } from './database.service';
import type { ProjectAuthContext } from './project-auth-context';
import { ProjectsService } from './projects.service';

@Injectable()
export class ProjectMembersService {
  constructor(private readonly database: DatabaseService, private readonly projects: ProjectsService) {}

  private async currentUserId(auth: ProjectAuthContext): Promise<string | null> {
    if (auth.mode === 'local') return null;
    return this.projects.findUserId(auth);
  }

  async list(slug: string, auth: ProjectAuthContext) {
    const project = await this.projects.findBySlug(slug, auth, 'member:read');
    const members = await this.database.db.select({
      userId: projectMemberships.userId,
      displayName: users.displayName,
      role: projectMemberships.role,
      joinedAt: projectMemberships.createdAt,
    }).from(projectMemberships).innerJoin(users, eq(users.id, projectMemberships.userId))
      .where(eq(projectMemberships.projectId, project.id));
    const actorId = await this.currentUserId(auth);
    return { members, currentUserId: actorId, currentRole: members.find((member) => member.userId === actorId)?.role ?? null };
  }

  async updateRole(slug: string, targetUserId: string, role: 'editor' | 'viewer', auth: ProjectAuthContext) {
    if (auth.mode === 'local') throw new ForbiddenException('成员角色调整需要已验证的 OIDC 身份。');
    const project = await this.projects.findBySlug(slug, auth, 'member:manage');
    const actorId = await this.currentUserId(auth);
    if (!actorId || actorId === targetUserId) throw new ForbiddenException('不能修改自己的项目角色。');
    const db = this.database.db;
    return db.transaction(async (tx) => {
      const where = and(eq(projectMemberships.projectId, project.id), eq(projectMemberships.userId, targetUserId));
      const [existing] = await tx.select({ role: projectMemberships.role }).from(projectMemberships)
        .where(where).limit(1).for('update');
      if (!existing) throw new NotFoundException('项目成员不存在。');
      if (!canManageMembership('owner', existing.role as ProjectRole, false)) {
        throw new ForbiddenException('不能修改 Owner 角色。');
      }
      if (existing.role === role) return { userId: targetUserId, role };
      await tx.update(projectMemberships).set({ role }).where(where);
      await tx.insert(projectMemberAudit).values({
        projectId: project.id, actorUserId: actorId, targetUserId,
        previousRole: existing.role, nextRole: role,
      });
      return { userId: targetUserId, role };
    });
  }
}
