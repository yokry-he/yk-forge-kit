import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { assetInstallations, projectInvitationAudit, projectInvitations, projects as projectTable, users, requireDisposableTestDatabase } from '@forgekit/db';
import { DatabaseService } from '../src/database.service';
import { ProjectsService } from '../src/projects.service';
import { IdentityAccountsService } from '../src/identity-accounts.service';
import { ProjectMembersService } from '../src/project-members.service';
import { ProjectAssetsService } from '../src/project-assets.service';
import { InvitationRateLimiter } from '../src/invitation-rate-limiter';
import { ProjectInvitationsService } from '../src/project-invitations.service';
import type { ProjectAuthContext } from '../src/project-auth-context';

// Runs only after the separate MySQL integration job has migrated forgekit_test.
describe.skipIf(process.env.FORGEKIT_DB_INTEGRATION !== '1')('real MySQL project membership and invitations', () => {
  it('updates only a known planned version using compare-and-swap without changing install status', async () => {
    requireDisposableTestDatabase(process.env);
    const database = new DatabaseService();
    const projects = new ProjectsService(database);
    const assets = new ProjectAssetsService(database, projects);
    const id = randomUUID();
    const slug = `asset-upgrade-${id}`;
    const owner = { mode: 'oidc' as const, issuer: 'https://forgekit-integration.example', subject: `${id}-owner` };
    const outsider = { ...owner, subject: `${id}-outsider` };
    let projectId: string | null = null;
    try {
      const project = await projects.create({ name: slug, template: 'vue-web', features: [] }, owner);
      projectId = project.id;
      await assets.plan(slug, 'official.theme', '1.1.0', owner);
      const where = eq(assetInstallations.projectId, project.id);
      // Legacy registration fixture: the registry now offers 1.1.0.
      await database.db.update(assetInstallations).set({ version: '1.0.0' }).where(where);
      await expect(assets.upgradePlan(slug, 'official.theme', '1.0.0', '1.1.0', outsider)).rejects.toMatchObject({ status: 404 });
      const attempts = await Promise.allSettled([
        assets.upgradePlan(slug, 'official.theme', '1.0.0', '1.1.0', owner),
        assets.upgradePlan(slug, 'official.theme', '1.0.0', '1.1.0', owner),
      ]);
      expect(attempts.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
      expect(attempts.filter((result) => result.status === 'rejected')).toHaveLength(1);
      expect((await assets.list(slug, owner))[0]).toMatchObject({ version: '1.1.0', status: 'planned' });
      await expect(assets.upgradePlan(slug, 'official.theme', '1.0.0', '1.1.0', owner)).rejects.toMatchObject({ status: 409 });
      await database.db.update(assetInstallations).set({ version: '1.0.0', status: 'applied' }).where(where);
      await expect(assets.upgradePlan(slug, 'official.theme', '1.0.0', '1.1.0', owner)).rejects.toMatchObject({ status: 409 });
    } finally {
      try {
        if (projectId) await database.db.delete(projectTable).where(eq(projectTable.id, projectId));
        const userId = await projects.findUserId(owner);
        if (userId) await database.db.delete(users).where(eq(users.id, userId));
      } finally { await database.onModuleDestroy(); }
    }
  }, 30_000);

  it('provisions a first-login account idempotently without granting project membership', async () => {
    requireDisposableTestDatabase(process.env);
    const database = new DatabaseService();
    const accounts = new IdentityAccountsService(database);
    const projects = new ProjectsService(database, accounts);
    const issuer = 'https://forgekit-integration.example';
    const subject = `first-login-${randomUUID()}`;
    const auth = { mode: 'oidc' as const, issuer, subject };
    let userId: string | null = null;
    try {
      const [first, second] = await Promise.all([accounts.initializeAccount(auth), accounts.initializeAccount(auth)]);
      expect(first).toMatchObject({ displayName: 'YKForgeKit 用户' });
      expect(second?.id).toBe(first?.id);
      userId = first?.id ?? null;
      expect(await accounts.findUserId({ ...auth, subject: subject.toUpperCase() })).toBeNull();
      expect(await projects.list(auth)).toEqual([]);
      const updated = await accounts.updateDisplayName(auth, 'Yokry');
      expect(updated.displayName).toBe('Yokry');
      expect((await accounts.getProfile({ ...auth, subject: subject.toUpperCase() }))).toBeNull();
      expect((await accounts.getProfile(auth))?.displayName).toBe('Yokry');
    } finally {
      try { if (userId) await database.db.delete(users).where(eq(users.id, userId)); }
      finally { await database.onModuleDestroy(); }
    }
  }, 30_000);

  it('enforces role boundaries, single-use, revocation, concurrent redemption and shared quotas', async () => {
    requireDisposableTestDatabase(process.env);
    const database = new DatabaseService();
    const projects = new ProjectsService(database);
    const members = new ProjectMembersService(database, projects);
    const limiter = new InvitationRateLimiter(database);
    const invitations = new ProjectInvitationsService(database, projects, limiter);
    const runId = randomUUID();
    const slug = `integration-${runId}`;
    const issuer = 'https://forgekit-integration.example';
    const person = (name: string): Extract<ProjectAuthContext, { mode: 'oidc' }> =>
      ({ mode: 'oidc', issuer, subject: `${runId}-${name}` });
    const owner = person('owner');
    const viewer = person('viewer');
    const candidateA = person('candidate-a');
    const candidateB = person('candidate-b');
    const identities = [owner, viewer, candidateA, candidateB];
    let projectId: string | null = null;
    try {
      const project = await projects.create({ name: slug, template: 'vue-web', features: [] }, owner);
      projectId = project.id;
      await expect(projects.findBySlug(slug, viewer)).rejects.toMatchObject({ status: 404 });

      const first = await invitations.create(slug, 'viewer', owner);
      expect(first.code).toMatch(/^[A-Za-z0-9_-]{43}$/);
      const listed = await invitations.list(slug, owner);
      expect(listed).toHaveLength(1);
      expect(JSON.stringify(listed)).not.toContain(first.code);
      await expect(invitations.redeem('a'.repeat(43), viewer)).rejects.toMatchObject({ status: 404 });
      expect(await invitations.redeem(first.code, viewer)).toMatchObject({ projectSlug: slug, role: 'viewer' });
      await expect(invitations.redeem(first.code, viewer)).rejects.toMatchObject({ status: 409 });

      const viewerId = await projects.findUserId(viewer);
      expect(viewerId).toBeTruthy();
      expect((await members.list(slug, viewer)).currentRole).toBe('viewer');
      await expect(members.updateRole(slug, viewerId!, 'editor', viewer)).rejects.toMatchObject({ status: 403 });
      await members.updateRole(slug, viewerId!, 'editor', owner);
      expect((await members.list(slug, viewer)).currentRole).toBe('editor');

      const revoked = await invitations.create(slug, 'viewer', owner);
      const revokedItem = (await invitations.list(slug, owner)).find((invitation) => invitation.role === 'viewer' && !invitation.redeemedAt);
      expect(revokedItem).toBeDefined();
      await invitations.revoke(slug, revokedItem!.id, owner);
      await expect(invitations.redeem(revoked.code, candidateA)).rejects.toMatchObject({ status: 410 });

      const race = await invitations.create(slug, 'viewer', owner);
      const results = await Promise.allSettled([
        invitations.redeem(race.code, candidateA),
        invitations.redeem(race.code, candidateB),
      ]);
      expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
      expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);

      const audits = await database.db.select({ action: projectInvitationAudit.action })
        .from(projectInvitationAudit).where(eq(projectInvitationAudit.projectId, projectId));
      expect(audits.filter((event) => event.action === 'created')).toHaveLength(3);
      expect(audits.filter((event) => event.action === 'redeemed')).toHaveLength(2);
      expect(audits.filter((event) => event.action === 'revoked')).toHaveLength(1);

      // Counted in MySQL, so a second limiter instance sees the same identity bucket.
      const quotaSubject = `${runId}-quota`;
      for (let index = 0; index < 10; index++) await limiter.consume('create', issuer, quotaSubject);
      await expect(new InvitationRateLimiter(database).consume('create', issuer, quotaSubject))
        .rejects.toMatchObject({ status: 429 });
    } finally {
      try {
        if (projectId) {
          await database.db.delete(projectTable).where(eq(projectTable.id, projectId));
          // Foreign keys cascade project invitations and audit records.
          const remaining = await database.db.select().from(projectInvitations)
            .where(eq(projectInvitations.projectId, projectId));
          expect(remaining).toHaveLength(0);
        }
        for (const identity of identities) {
          const id = await projects.findUserId(identity);
          if (id) await database.db.delete(users).where(eq(users.id, id));
        }
      } finally {
        await database.onModuleDestroy();
      }
    }
  }, 40_000);
});
