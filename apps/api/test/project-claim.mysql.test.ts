import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { projectMemberAudit, projectMemberships, projects as projectTable, requireDisposableTestDatabase, users } from '@forgekit/db';
import { DatabaseService } from '../src/database.service';
import { ProjectsService } from '../src/projects.service';
import { claimUnownedProject, listUnownedProjects, OPERATOR_CLAIM_ACTOR } from '../src/project-claim';

describe.skipIf(process.env.FORGEKIT_DB_INTEGRATION !== '1')('legacy project claim on real MySQL', () => {
  it('claims a member-less project only once, explicitly, with audit', async () => {
    requireDisposableTestDatabase(process.env);
    const database = new DatabaseService();
    const projects = new ProjectsService(database);
    const runId = randomUUID();
    const slug = `legacy-${runId.slice(0, 8)}`;
    const issuer = 'https://forgekit-claim.example';
    const owner = { mode: 'oidc' as const, issuer, subject: `${runId}-owner` };
    const other = { mode: 'oidc' as const, issuer, subject: `${runId}-other` };
    let projectId: string | null = null;
    try {
      // Local mode creates a project without members, exactly like pre-OIDC data.
      const created = await projects.create({ name: slug, template: 'vue-web', features: [] }, { mode: 'local' });
      projectId = created.id;
      expect((await listUnownedProjects(database.db)).some((row) => row.slug === slug)).toBe(true);
      await expect(projects.findBySlug(slug, owner)).rejects.toMatchObject({ status: 404 });

      // An identity that never signed in cannot be targeted (prevents typos granting nobody/somebody else).
      await expect(claimUnownedProject(database.db, { slug, issuer, subject: owner.subject }, { apply: true })).rejects.toThrow('尚无 YKForgeKit 账户');
      const ownerId = await projects.ensureUser(owner);
      await projects.ensureUser(other);
      // Subject comparison is exact: case and surrounding whitespace are significant.
      await expect(claimUnownedProject(database.db, { slug, issuer, subject: owner.subject.toUpperCase() }, { apply: true })).rejects.toThrow();
      await expect(claimUnownedProject(database.db, { slug, issuer, subject: ` ${owner.subject}` }, { apply: true })).rejects.toThrow();

      const dryRun = await claimUnownedProject(database.db, { slug, issuer, subject: owner.subject }, { apply: false });
      expect(dryRun).toMatchObject({ applied: false, slug, userId: ownerId });
      expect(await database.db.select().from(projectMemberships).where(eq(projectMemberships.projectId, created.id))).toHaveLength(0);

      const attempts = await Promise.allSettled([
        claimUnownedProject(database.db, { slug, issuer, subject: owner.subject }, { apply: true }),
        claimUnownedProject(database.db, { slug, issuer, subject: other.subject }, { apply: true }),
      ]);
      expect(attempts.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
      const members = await database.db.select().from(projectMemberships).where(eq(projectMemberships.projectId, created.id));
      expect(members).toHaveLength(1);
      expect(members[0]?.role).toBe('owner');
      const winner = members[0]!.userId === ownerId ? owner : other;
      expect((await projects.findBySlug(slug, winner)).id).toBe(created.id);
      const audit = await database.db.select().from(projectMemberAudit).where(eq(projectMemberAudit.projectId, created.id));
      expect(audit).toEqual([expect.objectContaining({ actorUserId: OPERATOR_CLAIM_ACTOR, previousRole: 'none', nextRole: 'owner' })]);
      expect((await listUnownedProjects(database.db)).some((row) => row.slug === slug)).toBe(false);
      await expect(claimUnownedProject(database.db, { slug, issuer, subject: owner.subject }, { apply: true })).rejects.toThrow('已有成员');
      await expect(claimUnownedProject(database.db, { slug: `missing-${runId}`, issuer, subject: owner.subject }, { apply: false })).rejects.toThrow('不存在');
    } finally {
      if (projectId) await database.db.delete(projectTable).where(eq(projectTable.id, projectId));
      for (const auth of [owner, other]) {
        const id = await projects.findUserId(auth);
        if (id) await database.db.delete(users).where(eq(users.id, id));
      }
      await database.onModuleDestroy();
    }
  }, 30_000);
});
