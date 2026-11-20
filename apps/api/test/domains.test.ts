import 'reflect-metadata';
import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ForbiddenException, Module, NotFoundException, UnauthorizedException, type INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { DomainRepository, DeployConflictError, type DomainRow, type DomainOperationRow } from '@forgekit/db';
import { canAccessProject, type ProjectPermission } from '@forgekit/identity-core';
import { DomainsController } from '../src/domains.controller';
import { DomainsService } from '../src/domains.service';
import { DomainQueueService } from '../src/domain-queue.service';
import { DatabaseService } from '../src/database.service';
import { ProjectsService } from '../src/projects.service';
import { InvitationRateLimiter } from '../src/invitation-rate-limiter';
import { ProjectApiGuard } from '../src/project-api.guard';
import { AuthService } from '../src/auth.service';
const projectId = randomUUID(), targetId = randomUUID(), actorId = randomUUID(), now = new Date();
const domain: DomainRow = { id: randomUUID(), projectId, deployTargetId: targetId, hostname: 'site.example', verificationToken: 'a'.repeat(64), claimedHostname: null,
  status: 'pending_dns', tlsMode: 'internal', verifiedAt: null, lastCheckedAt: null, certificateExpiresAt: null, certificateFingerprint: null, errorCode: null, createdAt: now, updatedAt: now };
const op: DomainOperationRow = { id: randomUUID(), projectId, deployTargetId: targetId, domainId: domain.id, actorUserId: actorId,
  action: 'verify', status: 'pending', errorCode: null, finishedAt: null, createdAt: now, updatedAt: now };
const create = vi.spyOn(DomainRepository.prototype, 'create'), requestOp = vi.spyOn(DomainRepository.prototype, 'request');
const list = vi.spyOn(DomainRepository.prototype, 'list'), operation = vi.spyOn(DomainRepository.prototype, 'operation');
const enqueue = vi.fn(), requireConfigured = vi.fn(), consume = vi.fn();
@Module({ controllers: [DomainsController], providers: [DomainsService, ProjectApiGuard,
  { provide: DatabaseService, useValue: { db: {} } },
  { provide: ProjectsService, useValue: {
    findUserId: async () => actorId,
    findById: async (id: string, auth: { subject: string }, permission: ProjectPermission) => {
      if (id !== projectId || auth.subject === 'outsider') throw new NotFoundException();
      if (!canAccessProject(auth.subject, permission)) throw new ForbiddenException(); return { id };
    },
  } }, { provide: DomainQueueService, useValue: { enqueue, requireConfigured } },
  { provide: InvitationRateLimiter, useValue: { consume } },
  { provide: AuthService, useValue: { authenticate: async (header?: string) => {
    const subject = header?.replace('Bearer ', ''); if (!subject) throw new UnauthorizedException(); return { issuer: 'https://issuer.example', subject };
  } } },
] }) class TestApp {}
let app: INestApplication, base: string;
const request = (path: string, method = 'GET', body?: unknown, role: string | null = 'owner') => fetch(base + path, { method,
  headers: { ...(role ? { authorization: 'Bearer ' + role } : {}), ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
beforeAll(async () => {
  vi.stubEnv('AUTH_MODE', 'oidc'); vi.stubEnv('NODE_ENV', 'test'); vi.stubEnv('OIDC_ISSUER', 'https://issuer.example');
  vi.stubEnv('OIDC_API_AUDIENCE', 'forgekit-api'); vi.stubEnv('OIDC_JWKS_URL', 'https://issuer.example/jwks');
  vi.stubEnv('FORGEKIT_DEPLOY_ENCRYPTION_KEY', randomBytes(32).toString('hex')); vi.stubEnv('FORGEKIT_DOMAIN_TLS_MODE', 'internal');
  app = await NestFactory.create(TestApp, { logger: false }); await app.listen(0, '127.0.0.1'); base = `${await app.getUrl()}/api/v1/projects/${projectId}`;
});
afterAll(async () => { await app?.close(); vi.restoreAllMocks(); vi.unstubAllEnvs(); });
beforeEach(() => {
  vi.clearAllMocks(); create.mockResolvedValue(domain); requestOp.mockResolvedValue(op); list.mockResolvedValue([domain]); operation.mockResolvedValue(op);
  enqueue.mockResolvedValue(undefined);
});
describe('B13 project-authorized APIs', () => {
  it('denies anonymous/local identities, viewer writes, and cross-project access', async () => {
    const input = { hostname: domain.hostname, deployTargetId: targetId };
    for (const [path, method, body] of [['/domains', 'POST', input], [`/domains/${domain.id}/verify`, 'POST', undefined],
      [`/domains/${domain.id}/refresh`, 'POST', undefined], [`/domains/${domain.id}`, 'DELETE', undefined]] as const) {
      expect((await request(path, method, body, null)).status).toBe(401);
      expect((await request(path, method, body, 'viewer')).status).toBe(403);
      expect((await request(path, method, body, 'outsider')).status).toBe(404);
    }
    await expect(app.get(DomainsService).list(projectId, { mode: 'local' })).rejects.toBeInstanceOf(ForbiddenException);
    expect(create).not.toHaveBeenCalled(); expect(enqueue).not.toHaveBeenCalled();
    operation.mockResolvedValueOnce({ ...op, projectId: randomUUID() });
    expect((await request('/domain-operations/' + op.id)).status).toBe(404);
  });
  it('normalizes input, displays DNS instructions, and keeps internal claim fields out of responses', async () => {
    const response = await request('/domains', 'POST', { hostname: 'SITE.Example', deployTargetId: targetId }, 'editor');
    expect(response.status).toBe(201); expect(response.headers.get('cache-control')).toBe('no-store');
    expect(create).toHaveBeenCalledWith(projectId, targetId, 'site.example', actorId, 'internal');
    const text = await response.text(); expect(text).toContain('_forgekit-challenge.site.example'); expect(text).toContain('forgekit-domain=');
    expect(text).not.toContain('claimedHostname'); expect(text).not.toContain('verificationToken');
    expect((await request('/domains', 'GET', undefined, 'viewer')).status).toBe(200);
  });
  it.each(['domain_certificate_invalid', 'domain_health_failed'])('preserves failed availability and historical certificate in responses: %s', async errorCode => {
    const certificateExpiresAt = new Date('2099-12-20T00:00:00Z');
    list.mockResolvedValueOnce([{ ...domain, status: 'failed', verifiedAt: now, claimedHostname: domain.hostname,
      certificateExpiresAt, certificateFingerprint: 'c'.repeat(64), errorCode }]);
    const response = await request('/domains');
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual([expect.objectContaining({ status: 'failed', errorCode,
      certificateExpiresAt: certificateExpiresAt.toISOString(), certificateFingerprint: 'c'.repeat(64) })]);
  });
  it('rejects config/header injection, issuer overrides and invalid state with stable HTTP errors', async () => {
    for (const hostname of ['https://site.example', 'site.example\r\nX: bad', '*.site.example', 'site.example { tls internal }']) {
      expect((await request('/domains', 'POST', { hostname, deployTargetId: targetId })).status).toBe(400);
    }
    expect((await request('/domains', 'POST', { hostname: 'site.example', deployTargetId: targetId, tlsMode: 'production' })).status).toBe(400);
    expect((await request(`/domains/${domain.id}/verify`, 'POST', { command: 'id' })).status).toBe(400);
    create.mockRejectedValueOnce(new DeployConflictError());
    expect((await request('/domains', 'POST', { hostname: 'site.example', deployTargetId: targetId })).status).toBe(409);
  });
  it('queues identifier-only verify/refresh/remove operations and rate-limits writes', async () => {
    for (const [method, suffix, action] of [['POST', '/verify', 'verify'], ['POST', '/refresh', 'refresh'], ['DELETE', '', 'remove']] as const) {
      const response = await request('/domains/' + domain.id + suffix, method);
      expect(response.status).toBe(method === 'POST' ? 201 : 200);
      expect(requestOp).toHaveBeenLastCalledWith(projectId, domain.id, action, actorId);
      expect(enqueue).toHaveBeenLastCalledWith(op.id);
    }
    expect(consume).toHaveBeenCalledTimes(3);
  });
});
