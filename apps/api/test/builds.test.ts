import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ForbiddenException, HttpException, Module, NotFoundException, UnauthorizedException, type INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { BuildRepository, BuildLogRepository, BuildTransitionError } from '@forgekit/db';
import { canAccessProject, type ProjectPermission } from '@forgekit/identity-core';
import { BuildsController } from '../src/builds.controller';
import { BuildsService } from '../src/builds.service';
import { BuildQueueService, resolveBuildRedisConfig } from '../src/build-queue.service';
import { ProjectsService } from '../src/projects.service';
import { DatabaseService } from '../src/database.service';
import { InvitationRateLimiter } from '../src/invitation-rate-limiter';
import { ProjectApiGuard } from '../src/project-api.guard';
import { AuthService } from '../src/auth.service';

const projectId = randomUUID(), buildId = randomUUID(), actorId = randomUUID();
const now = new Date();
const initial = { id: buildId, projectId, triggeredBy: actorId, template: 'vue-web', sourceRef: 'sources/snapshot.tar',
  number: 1, status: 'queued' as const, queuedAt: now, startedAt: null, finishedAt: null, createdAt: now, updatedAt: now,
  exitCode: null, errorMessage: null, artifactKey: null, artifactSize: null, artifactSha256: null, logStorageKey: null, runnerInfo: null };
const enqueue = vi.fn(), configured = vi.fn(), consume = vi.fn();
const create = vi.spyOn(BuildRepository.prototype, 'create');
const get = vi.spyOn(BuildRepository.prototype, 'get');
const list = vi.spyOn(BuildRepository.prototype, 'listByProject');
const update = vi.spyOn(BuildRepository.prototype, 'updateStatus');
const logs = vi.spyOn(BuildLogRepository.prototype, 'listSince');
const projects = {
  findUserId: vi.fn(async () => actorId),
  findById: vi.fn(async (id: string, auth: { subject: string }, permission: ProjectPermission) => {
    if (id !== projectId || auth.subject === 'outsider') throw new NotFoundException();
    if (!canAccessProject(auth.subject, permission)) throw new ForbiddenException();
    return { id, template: 'vue-web' };
  }),
};
@Module({ controllers: [BuildsController], providers: [BuildsService, ProjectApiGuard,
  { provide: DatabaseService, useValue: { db: {} } }, { provide: ProjectsService, useValue: projects },
  { provide: BuildQueueService, useValue: { enqueue, requireConfigured: configured } },
  { provide: InvitationRateLimiter, useValue: { consume } },
  { provide: AuthService, useValue: { authenticate: async (header?: string) => {
    const subject = header?.replace('Bearer ', '');
    if (!subject || !['owner', 'editor', 'viewer', 'outsider'].includes(subject)) throw new UnauthorizedException();
    return { issuer: 'https://issuer.example', subject };
  } } },
] })
class TestApp {}

let app: INestApplication, base: string;
async function request(path = '', role: string | null = 'owner', method = 'GET', body?: unknown) {
  return fetch(`${base}/api/v1/projects/${projectId}/builds${path}`, { method,
    headers: { ...(role ? { authorization: `Bearer ${role}` } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
}
beforeAll(async () => {
  vi.stubEnv('AUTH_MODE', 'oidc'); vi.stubEnv('NODE_ENV', 'test');
  vi.stubEnv('OIDC_ISSUER', 'https://issuer.example'); vi.stubEnv('OIDC_API_AUDIENCE', 'forgekit-api');
  vi.stubEnv('OIDC_JWKS_URL', 'https://issuer.example/jwks');
  app = await NestFactory.create(TestApp, { logger: false }); await app.listen(0, '127.0.0.1');
  base = await app.getUrl();
});
afterAll(async () => { await app?.close(); vi.restoreAllMocks(); vi.unstubAllEnvs(); });
beforeEach(() => {
  vi.clearAllMocks();
  create.mockResolvedValue({ ...initial }); get.mockResolvedValue({ ...initial }); list.mockResolvedValue([{ ...initial }]);
  logs.mockResolvedValue([{ buildId, seq: 2, stream: 'stdout', content: 'done\n', ts: now }]);
  update.mockResolvedValue({ ...initial, status: 'canceled', finishedAt: now });
  enqueue.mockResolvedValue(undefined); configured.mockReturnValue(undefined); consume.mockResolvedValue(undefined);
});

describe('build HTTP endpoints', () => {
  it('requires authentication on every route', async () => {
    for (const [path, method, body] of [['', 'GET'], ['', 'POST', { sourceRef: 'snapshot' }],
      [`/${buildId}`, 'GET'], [`/${buildId}/logs`, 'GET'], [`/${buildId}/cancel`, 'POST']] as const) {
      expect((await request(path, null, method, body)).status).toBe(401);
    }
  });
  it.each(['owner', 'editor'])('%s can trigger, with trusted template/actor and atomic audit', async (role) => {
    const response = await request('', role, 'POST', { sourceRef: 'snapshot' });
    expect(response.status).toBe(201);
    expect(create).toHaveBeenCalledWith({ projectId, template: 'vue-web', triggeredBy: actorId, sourceRef: 'snapshot' }, true);
    expect(enqueue).toHaveBeenCalledWith(buildId);
    expect(consume).toHaveBeenCalledWith('build-trigger', 'https://issuer.example', role);
  });
  it('viewer can read builds and paginated persisted logs', async () => {
    expect((await request('?beforeNumber=12&limit=2', 'viewer')).status).toBe(200);
    expect(list).toHaveBeenCalledWith(projectId, { beforeNumber: 12, limit: 2 });
    const response = await request(`/${buildId}`, 'viewer'); expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ id: buildId, queuedAt: now.toISOString() });
    expect((await request(`/${buildId}/logs?seq=1&limit=1`, 'viewer')).status).toBe(200);
    expect(logs).toHaveBeenCalledWith(buildId, 1, 1);
  });
  it('viewer cannot trigger or cancel and outsiders cannot access any build route', async () => {
    expect((await request('', 'viewer', 'POST', { sourceRef: 'snapshot' })).status).toBe(403);
    expect((await request(`/${buildId}/cancel`, 'viewer', 'POST')).status).toBe(403);
    for (const [path, method, body] of [['', 'GET'], ['', 'POST', { sourceRef: 'snapshot' }],
      [`/${buildId}`, 'GET'], [`/${buildId}/logs`, 'GET'], [`/${buildId}/cancel`, 'POST']] as const) {
      expect((await request(path, 'outsider', method, body)).status).toBe(404);
    }
    expect(create).not.toHaveBeenCalled(); expect(update).not.toHaveBeenCalled();
  });
  it('does not expose a build belonging to another project', async () => {
    get.mockResolvedValue({ ...initial, projectId: randomUUID() });
    expect((await request(`/${buildId}`)).status).toBe(404);
    expect((await request(`/${buildId}/logs`)).status).toBe(404);
    expect((await request(`/${buildId}/cancel`, 'owner', 'POST')).status).toBe(404);
    expect(logs).not.toHaveBeenCalled(); expect(update).not.toHaveBeenCalled();
  });
  it('validates body, UUIDs and cursor bounds', async () => {
    for (const body of [{}, { sourceRef: '' }, { sourceRef: 2 }, { sourceRef: 'x', template: 'shell' }, { sourceRef: 'x'.repeat(1025) }]) {
      expect((await request('', 'owner', 'POST', body)).status).toBe(400);
    }
    for (const path of ['/bad-id', '?limit=0', '?beforeNumber=-1', '?extra=x', `/${buildId}/logs?seq=-1`,
      `/${buildId}/logs?limit=1001`, `/${buildId}/logs?seq=1&seq=2`]) {
      expect((await request(path)).status).toBe(400);
    }
    expect((await request(`/${buildId}/cancel`, 'owner', 'POST', { status: 'succeeded' })).status).toBe(400);
    expect(create).not.toHaveBeenCalled();
  });
  it('cancels queued and running builds via guarded, audited transitions', async () => {
    for (const status of ['queued', 'running'] as const) {
      get.mockResolvedValue({ ...initial, status });
      expect((await request(`/${buildId}/cancel`, 'editor', 'POST')).status).toBe(201);
      expect(update).toHaveBeenLastCalledWith(buildId, status, 'canceled', {}, actorId);
    }
  });
  it('handles cancellation racing dequeue, and rejects other terminal states', async () => {
    get.mockResolvedValueOnce({ ...initial }).mockResolvedValueOnce({ ...initial, status: 'running' });
    update.mockRejectedValueOnce(new BuildTransitionError());
    expect((await request(`/${buildId}/cancel`, 'owner', 'POST')).status).toBe(201);
    expect(update).toHaveBeenLastCalledWith(buildId, 'running', 'canceled', {}, actorId);
    get.mockResolvedValue({ ...initial, status: 'succeeded' });
    expect((await request(`/${buildId}/cancel`, 'owner', 'POST')).status).toBe(409);
  });
  it('returns 503 before creating a row when Redis is not configured', async () => {
    configured.mockImplementationOnce(() => { throw new HttpException('REDIS_URL', 503); });
    expect((await request('', 'owner', 'POST', { sourceRef: 'snapshot' })).status).toBe(503);
    expect(create).not.toHaveBeenCalled();
  });
  it('marks dispatch failure using CAS and reports 503', async () => {
    enqueue.mockRejectedValueOnce(new HttpException('queue unavailable', 503));
    expect((await request('', 'owner', 'POST', { sourceRef: 'snapshot' })).status).toBe(503);
    expect(update).toHaveBeenCalledWith(buildId, 'queued', 'failed', { errorMessage: 'queue_enqueue_failed' });
  });
  it('applies shared identity rate limits before mutation', async () => {
    consume.mockRejectedValueOnce(new HttpException('quota', 429));
    expect((await request('', 'owner', 'POST', { sourceRef: 'snapshot' })).status).toBe(429);
    expect(create).not.toHaveBeenCalled();
    consume.mockRejectedValueOnce(new HttpException('quota', 429));
    expect((await request(`/${buildId}/cancel`, 'owner', 'POST')).status).toBe(429);
    expect(update).not.toHaveBeenCalled();
  });
  it('local mode cannot mutate builds', async () => {
    const service = app.get(BuildsService);
    await expect(service.trigger(projectId, 'snapshot', { mode: 'local' })).rejects.toBeInstanceOf(ForbiddenException);
    await expect(service.cancel(projectId, buildId, { mode: 'local' })).rejects.toBeInstanceOf(ForbiddenException);
  });
});

describe('API Redis configuration', () => {
  it('allows startup without Redis, rejects malformed configured values', () => {
    expect(resolveBuildRedisConfig({})).toBeNull();
    expect(() => resolveBuildRedisConfig({ REDIS_URL: 'https://localhost' })).toThrow();
    expect(resolveBuildRedisConfig({ REDIS_URL: 'redis://localhost/15' })).toMatchObject({ db: 15, maxRetriesPerRequest: 1 });
  });
});
