import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { request } from 'node:http';
import { describe, expect, it, vi } from 'vitest';
import { Module, UnauthorizedException, type INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { migrate } from 'drizzle-orm/mysql2/migrator';
import { and, eq, inArray } from 'drizzle-orm';
import { LocalFsArtifactStore } from '@forgekit/artifact-store';
import { createDatabaseClient, requireDisposableTestDatabase, BuildRepository, PreviewLinkRepository, projects, users,
  externalIdentities, projectMemberships, previewLinks, previewLinkAudit, invitationRateBuckets } from '@forgekit/db';
import { PreviewLinksController } from '../src/preview-links.controller';
import { PreviewLinksService } from '../src/preview-links.service';
import { PreviewArtifactsService } from '../src/preview-artifacts.service';
import { createPreviewServer } from '../src/preview-server';
import { generatePreviewToken, hashPreviewToken } from '../src/preview-tokens';
import { DatabaseService } from '../src/database.service';
import { ProjectsService } from '../src/projects.service';
import { IdentityAccountsService } from '../src/identity-accounts.service';
import { InvitationRateLimiter, invitationBucketKey } from '../src/invitation-rate-limiter';
import { ProjectApiGuard } from '../src/project-api.guard';
import { AuthService } from '../src/auth.service';

describe.skipIf(process.env.FORGEKIT_PREVIEW_INTEGRATION !== '1')('B11 MySQL + fixture artifact + HTTP preview E2E', () => {
  it('creates via API, reads index and assets, expires/revokes, throttles access and commits audits atomically', async () => {
    const client = createDatabaseClient(requireDisposableTestDatabase(process.env));
    const root = await mkdtemp(join(tmpdir(), 'forgekit-preview-e2e-'));
    const projectId = randomUUID(), ownerId = randomUUID(), editorId = randomUUID(), viewerId = randomUUID();
    const issuer = `https://b11-${projectId}.example`;
    vi.stubEnv('AUTH_MODE', 'oidc'); vi.stubEnv('NODE_ENV', 'test'); vi.stubEnv('OIDC_ISSUER', issuer);
    vi.stubEnv('OIDC_API_AUDIENCE', 'forgekit-api'); vi.stubEnv('OIDC_JWKS_URL', `${issuer}/jwks`);
    vi.stubEnv('FORGEKIT_PREVIEW_BASE_URL', 'http://preview.localhost:3002');
    vi.stubEnv('FORGEKIT_ARTIFACT_DIR', join(root, 'artifacts'));
    const links = new PreviewLinkRepository(client.db), builds = new BuildRepository(client.db);
    const store = new LocalFsArtifactStore(join(root, 'artifacts'));
    const log = vi.fn();
    const preview = createPreviewServer({ base: new URL(process.env.FORGEKIT_PREVIEW_BASE_URL!), links, builds, artifacts: store, log });
    let app: INestApplication | undefined;
    @Module({ controllers: [PreviewLinksController], providers: [PreviewLinksService, PreviewArtifactsService, ProjectsService, IdentityAccountsService, InvitationRateLimiter, ProjectApiGuard,
      { provide: DatabaseService, useValue: { db: client.db } },
      { provide: AuthService, useValue: { authenticate: async (header?: string) => {
        const subject = header?.replace('Bearer ', '');
        if (!subject || ![ownerId, editorId, viewerId].includes(subject)) throw new UnauthorizedException();
        return { issuer, subject };
      } } },
    ] }) class TestApp {}
    try {
      await migrate(client.db, { migrationsFolder: resolve(process.cwd(), '../../packages/db/drizzle') });
      for (const [id, role] of [[ownerId, 'owner'], [editorId, 'editor'], [viewerId, 'viewer']] as const) {
        await client.db.insert(users).values({ id, displayName: 'B11 integration' });
        await client.db.insert(externalIdentities).values({ userId: id, issuer, subject: id });
        if (role === 'owner') await client.db.insert(projects).values({ id: projectId, slug: `b11-${projectId}`, name: 'B11', features: [] });
        await client.db.insert(projectMemberships).values({ projectId, userId: id, role });
      }
      const build = await builds.create({ projectId, triggeredBy: ownerId, template: 'vue-web', sourceRef: 'template:vue-web' });
      const source = join(root, 'source'); await mkdir(join(source, 'assets'), { recursive: true });
      await writeFile(join(source, 'index.html'), '<!doctype html><script src="/assets/app.js"></script><p>B11 fixture</p>');
      await writeFile(join(source, 'assets/app.js'), 'window.fixture=true;');
      const artifact = await store.put(build.id, source, new AbortController().signal);
      await builds.updateStatus(build.id, 'queued', 'running');
      app = await NestFactory.create(TestApp, { logger: false }); await app.listen(0, '127.0.0.1');
      const endpoint = `${await app.getUrl()}/api/v1/projects/${projectId}/builds/${build.id}/preview-links`;
      const headers = (id: string) => ({ authorization: `Bearer ${id}`, 'content-type': 'application/json' });
      const create = (id = ownerId, body = {}) => fetch(endpoint, { method: 'POST', headers: headers(id), body: JSON.stringify(body) });
      expect((await create()).status).toBe(409);
      await builds.updateStatus(build.id, 'running', 'succeeded', { artifactKey: artifact.key, artifactSize: artifact.size, artifactSha256: artifact.sha256, exitCode: 0 });
      expect((await create(viewerId)).status).toBe(403);
      expect((await create(ownerId, { ttlSeconds: 299 })).status).toBe(400);
      const created = await create(); expect(created.status).toBe(201);
      const payload = await created.json() as { token: string; url: string; previewLink: { id: string } };
      const id = payload.previewLink.id;
      const [persisted] = await client.db.select().from(previewLinks).where(eq(previewLinks.id, id));
      expect(persisted!.tokenHash).toBe(hashPreviewToken(payload.token)); expect(persisted).not.toHaveProperty('token');
      const listed = await fetch(endpoint, { headers: headers(viewerId) }); expect(listed.status).toBe(200);
      const listedText = await listed.text(); expect(listedText).toContain(id);
      for (const secret of [payload.token, payload.url, persisted!.tokenHash]) expect(listedText).not.toContain(secret);
      await new Promise<void>(resolve => preview.listen(0, '127.0.0.1', resolve));
      const port = (preview.address() as { port: number }).port;
      async function read(url = payload.url, path = '/') {
        return new Promise<{ status: number; body: string }>((resolve, reject) => {
          const req = request({ host: '127.0.0.1', port, path, headers: { host: new URL(url).host } }, response => {
            const chunks: Buffer[] = []; response.on('data', chunk => chunks.push(Buffer.from(chunk)));
            response.on('end', () => resolve({ status: response.statusCode!, body: Buffer.concat(chunks).toString() }));
          }); req.on('error', reject); req.end();
        });
      }
      expect(await read()).toMatchObject({ status: 200, body: expect.stringContaining('B11 fixture') });
      expect(await read(payload.url, '/assets/app.js')).toEqual({ status: 200, body: 'window.fixture=true;' });
      const touched = await links.findValidByHash(persisted!.tokenHash); expect(touched!.lastAccessedAt).toBeInstanceOf(Date);
      await read(); expect((await links.findValidByHash(persisted!.tokenHash))!.lastAccessedAt).toEqual(touched!.lastAccessedAt);
      await client.db.update(previewLinks).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(previewLinks.id, id));
      expect((await read()).status).toBe(404); expect(await links.listActive(build.id)).toEqual([]);
      const second = await (await create(editorId)).json() as typeof payload;
      expect((await read(second.url)).status).toBe(200);
      expect((await fetch(`${endpoint}/${second.previewLink.id}`, { method: 'DELETE', headers: headers(viewerId) })).status).toBe(403);
      for (let i = 0; i < 2; ++i) expect((await fetch(`${endpoint}/${second.previewLink.id}`, { method: 'DELETE', headers: headers(ownerId) })).status).toBe(204);
      expect((await read(second.url)).status).toBe(404);
      const audit = await client.db.select().from(previewLinkAudit).where(eq(previewLinkAudit.projectId, projectId));
      expect(audit.filter(row => row.action === 'created')).toHaveLength(2);
      expect(audit.filter(row => row.action === 'revoked')).toHaveLength(1);
      expect(audit.find(row => row.action === 'revoked')).toMatchObject({ previewLinkId: second.previewLink.id, actorUserId: ownerId });
      const digest = generatePreviewToken().tokenHash;
      await expect(links.create({ buildId: build.id, createdBy: ownerId, tokenHash: digest }, { projectId, actorUserId: 'x'.repeat(37) })).rejects.toThrow();
      expect(await links.findValidByHash(digest)).toBeNull(); // Audit failure rolls back token creation.
      const rollbackHash = generatePreviewToken().tokenHash;
      const rollbackLink = await links.create({ buildId: build.id, createdBy: ownerId, tokenHash: rollbackHash });
      await expect(links.revoke(build.id, rollbackLink.id, { projectId, actorUserId: 'x'.repeat(37) })).rejects.toThrow();
      expect(await links.findValidByHash(rollbackHash)).not.toBeNull(); // Failed revoke audit leaves access intact.
      await client.db.insert(invitationRateBuckets).values({ key: invitationBucketKey('preview-create', issuer, ownerId), attempts: 30 })
        .onDuplicateKeyUpdate({ set: { attempts: 30 } });
      expect((await create()).status).toBe(429);
      const logs = JSON.stringify(log.mock.calls);
      for (const secret of [payload.token, payload.url, second.token, new URL(payload.url).host]) expect(logs).not.toContain(secret);
      // Removing a real membership immediately blocks management, even with a valid identity.
      await client.db.delete(projectMemberships).where(and(eq(projectMemberships.projectId, projectId), eq(projectMemberships.userId, editorId)));
      expect((await create(editorId)).status).toBe(404);
    } finally {
      try {
        await app?.close();
        await new Promise<void>((resolve, reject) => preview.close(error => error && error.message !== 'Server is not running.' ? reject(error) : resolve()));
        const keys = [ownerId, editorId, viewerId].flatMap(subject => ['preview-create', 'preview-revoke'].map(type => invitationBucketKey(type as 'preview-create' | 'preview-revoke', issuer, subject)));
        await client.db.delete(invitationRateBuckets).where(inArray(invitationRateBuckets.key, keys));
        await client.db.delete(projects).where(eq(projects.id, projectId));
        await client.db.delete(users).where(inArray(users.id, [ownerId, editorId, viewerId]));
      } finally { await client.close(); await rm(root, { recursive: true, force: true }); vi.unstubAllEnvs(); }
    }
  }, 30_000);
});
