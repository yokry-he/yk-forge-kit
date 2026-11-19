import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ForbiddenException, HttpException, Module, NotFoundException, UnauthorizedException, type INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { BuildRepository, PreviewLinkRepository } from '@forgekit/db';
import { canAccessProject, type ProjectPermission } from '@forgekit/identity-core';
import { PreviewLinksController } from '../src/preview-links.controller';
import { PreviewLinksService } from '../src/preview-links.service';
import { PreviewArtifactsService } from '../src/preview-artifacts.service';
import { ProjectsService } from '../src/projects.service';
import { DatabaseService } from '../src/database.service';
import { InvitationRateLimiter } from '../src/invitation-rate-limiter';
import { ProjectApiGuard } from '../src/project-api.guard';
import { AuthService } from '../src/auth.service';
import { hashPreviewToken } from '../src/preview-tokens';
import { previewHost } from '../src/preview-config';

const projectId = randomUUID(), buildId = randomUUID(), actorId = randomUUID(), linkId = randomUUID();
const now = new Date();
const initial = { id: buildId, projectId, triggeredBy: actorId, template: 'vue-web', sourceRef: 'template:vue-web',
  number: 1, status: 'succeeded' as const, queuedAt: now, startedAt: now, finishedAt: now, createdAt: now, updatedAt: now,
  exitCode: 0, errorMessage: null, artifactKey: `${buildId}/${randomUUID()}`, artifactSize: 100, artifactSha256: 'a'.repeat(64), logStorageKey: null, runnerInfo: null };
const row = { id: linkId, buildId, createdBy: actorId, createdAt: now, expiresAt: new Date(now.getTime() + 86400000), revokedAt: null, lastAccessedAt: null };
const get = vi.spyOn(BuildRepository.prototype, 'get'), create = vi.spyOn(PreviewLinkRepository.prototype, 'create');
const list = vi.spyOn(PreviewLinkRepository.prototype, 'listActive'), revoke = vi.spyOn(PreviewLinkRepository.prototype, 'revoke');
const consume = vi.fn(), requireIndex = vi.fn(); const baseUrl = new URL('http://preview.localhost:3002');
const projects = {
  findUserId: vi.fn(async () => actorId),
  findById: vi.fn(async (id: string, auth: { subject: string }, permission: ProjectPermission) => {
    if (id !== projectId || auth.subject === 'outsider') throw new NotFoundException();
    if (!canAccessProject(auth.subject, permission)) throw new ForbiddenException();
    return { id, template: 'vue-web' };
  }),
};
@Module({ controllers: [PreviewLinksController], providers: [PreviewLinksService, ProjectApiGuard,
  { provide: DatabaseService, useValue: { db: {} } }, { provide: ProjectsService, useValue: projects },
  { provide: PreviewArtifactsService, useValue: { base: baseUrl, requireIndex } },
  { provide: InvitationRateLimiter, useValue: { consume } },
  { provide: AuthService, useValue: { authenticate: async (header?: string) => {
    const subject = header?.replace('Bearer ', '');
    if (!subject || !['owner', 'editor', 'viewer', 'outsider'].includes(subject)) throw new UnauthorizedException();
    return { issuer: 'https://issuer.example', subject };
  } } },
] }) class TestApp {}
let app: INestApplication, base: string;
async function request(role: string | null = 'owner', method = 'GET', body?: unknown, suffix = '') {
  return fetch(`${base}/api/v1/projects/${projectId}/builds/${buildId}/preview-links${suffix}`, { method,
    headers: { ...(role ? { authorization: `Bearer ${role}` } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
}
beforeAll(async () => {
  vi.stubEnv('AUTH_MODE', 'oidc'); vi.stubEnv('NODE_ENV', 'test'); vi.stubEnv('OIDC_ISSUER', 'https://issuer.example');
  vi.stubEnv('OIDC_API_AUDIENCE', 'forgekit-api'); vi.stubEnv('OIDC_JWKS_URL', 'https://issuer.example/jwks');
  app = await NestFactory.create(TestApp, { logger: false }); await app.listen(0, '127.0.0.1'); base = await app.getUrl();
});
afterAll(async () => { await app?.close(); vi.restoreAllMocks(); vi.unstubAllEnvs(); });
beforeEach(() => {
  vi.clearAllMocks(); get.mockResolvedValue({ ...initial }); create.mockResolvedValue({ ...row }); list.mockResolvedValue([{ ...row }]);
  revoke.mockResolvedValue(true); consume.mockResolvedValue(undefined); requireIndex.mockResolvedValue(undefined);
});
describe('B11 preview link HTTP API', () => {
  it('requires authentication on all routes', async () => {
    for (const [method, suffix] of [['GET', ''], ['POST', ''], ['DELETE', `/${linkId}`]]) expect((await request(null, method, undefined, suffix)).status).toBe(401);
  });
  it.each(['owner', 'editor'])('%s creates a once-only token with hash persistence, default TTL and audit context', async role => {
    const response = await request(role, 'POST', {}); expect(response.status).toBe(201);
    expect(response.headers.get('cache-control')).toBe('no-store');
    const body = await response.json() as { token: string; url: string; previewLink: { id: string } };
    expect(body.token).toMatch(/^[A-Za-z0-9_-]{43}$/); expect(body.previewLink.id).toBe(linkId);
    expect(create).toHaveBeenCalledWith({ buildId, createdBy: actorId, ttlSeconds: 86400, tokenHash: hashPreviewToken(body.token) }, { projectId, actorUserId: actorId });
    expect(JSON.stringify(create.mock.calls)).not.toContain(body.token);
    expect(previewHost(baseUrl, new URL(body.url).host)).toEqual({ token: body.token });
    expect(consume).toHaveBeenCalledWith('preview-create', 'https://issuer.example', role);
    expect(requireIndex).toHaveBeenCalledWith(initial.artifactKey);
  });
  it('allows viewer metadata reads but denies mutations; outsiders see 404', async () => {
    const response = await request('viewer'); expect(response.status).toBe(200);
    const text = await response.text(); expect(text).toContain(linkId);
    for (const key of ['token', 'tokenHash', 'url']) expect(text).not.toContain(`"${key}"`);
    expect((await request('viewer', 'POST', {})).status).toBe(403);
    expect((await request('viewer', 'DELETE', undefined, `/${linkId}`)).status).toBe(403);
    for (const [method, suffix] of [['GET', ''], ['POST', ''], ['DELETE', `/${linkId}`]]) expect((await request('outsider', method, undefined, suffix)).status).toBe(404);
    expect(create).not.toHaveBeenCalled(); expect(revoke).not.toHaveBeenCalled();
  });
  it('validates strict TTL bounds, identifiers and permits both boundary TTLs', async () => {
    for (const body of [{ ttlSeconds: 299 }, { ttlSeconds: 604801 }, { ttlSeconds: 300.5 }, { ttlSeconds: '300' }, { ttlSeconds: 300, token: 'x' }]) {
      expect((await request('owner', 'POST', body)).status).toBe(400);
    }
    expect(create).not.toHaveBeenCalled();
    for (const ttlSeconds of [300, 604800]) expect((await request('owner', 'POST', { ttlSeconds })).status).toBe(201);
    expect((await request('owner', 'DELETE', undefined, '/bad-id')).status).toBe(400);
  });
  it('requires succeeded builds and available artifacts, including noop builds', async () => {
    for (const status of ['queued', 'running', 'failed', 'canceled'] as const) {
      get.mockResolvedValue({ ...initial, status }); expect((await request('owner', 'POST', {})).status).toBe(409);
    }
    get.mockResolvedValue({ ...initial, artifactKey: null }); expect((await request('owner', 'POST', {})).status).toBe(409);
    expect(create).not.toHaveBeenCalled();
    get.mockResolvedValue({ ...initial }); requireIndex.mockRejectedValueOnce(new HttpException('unavailable', 503));
    expect((await request('owner', 'POST', {})).status).toBe(503); expect(create).not.toHaveBeenCalled();
  });
  it('scopes all operations to the authorized project and build', async () => {
    get.mockResolvedValue({ ...initial, projectId: randomUUID() });
    for (const [method, suffix] of [['GET', ''], ['POST', ''], ['DELETE', `/${linkId}`]]) expect((await request('owner', method, method === 'POST' ? {} : undefined, suffix)).status).toBe(404);
    expect(create).not.toHaveBeenCalled(); expect(revoke).not.toHaveBeenCalled(); expect(list).not.toHaveBeenCalled();
  });
  it('revokes idempotently with scoped atomic audit and identity rate limits', async () => {
    expect((await request('editor', 'DELETE', undefined, `/${linkId}`)).status).toBe(204);
    expect(revoke).toHaveBeenCalledWith(buildId, linkId, { projectId, actorUserId: actorId });
    expect(consume).toHaveBeenCalledWith('preview-revoke', 'https://issuer.example', 'editor');
    revoke.mockResolvedValueOnce(false); expect((await request('editor', 'DELETE', undefined, `/${linkId}`)).status).toBe(204);
    consume.mockRejectedValueOnce(new HttpException('quota', 429));
    expect((await request('owner', 'POST', {})).status).toBe(429); expect(create).not.toHaveBeenCalled();
  });
  it('blocks local identities on reads and writes', async () => {
    const service = app.get(PreviewLinksService);
    await expect(service.create(projectId, buildId, {}, { mode: 'local' })).rejects.toBeInstanceOf(ForbiddenException);
    await expect(service.list(projectId, buildId, { mode: 'local' })).rejects.toBeInstanceOf(ForbiddenException);
    await expect(service.revoke(projectId, buildId, linkId, { mode: 'local' })).rejects.toBeInstanceOf(ForbiddenException);
  });
});
