import 'reflect-metadata';
import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ForbiddenException, HttpException, Module, NotFoundException, UnauthorizedException, type INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { RuntimeLogRepository, RuntimeLogLimitError, DeployConflictError, DeployNotFoundError, type RuntimeLogRow } from '@forgekit/db';
import { RuntimeLogInputSchema } from '@forgekit/contracts';
import { canAccessProject, type ProjectPermission } from '@forgekit/identity-core';
import { RuntimeLogsController } from '../src/runtime-logs.controller';
import { RuntimeLogsService } from '../src/runtime-logs.service';
import { RuntimeLogQueueService } from '../src/runtime-log-queue.service';
import { DatabaseService } from '../src/database.service';
import { ProjectsService } from '../src/projects.service';
import { InvitationRateLimiter } from '../src/invitation-rate-limiter';
import { ProjectApiGuard } from '../src/project-api.guard';
import { AuthService } from '../src/auth.service';
const projectId = randomUUID(), id = randomUUID(), actor = randomUUID(), now = new Date();
const input = RuntimeLogInputSchema.parse({ domainId: id, source: 'caddy-access' });
const row: RuntimeLogRow = { id, projectId, domainId: id, deployTargetId: id, actorUserId: actor, hostHash: 'a'.repeat(64),
  input, status: 'pending', errorCode: null, bytes: 0, lastSeq: 0, leaseOwner: null, leaseUntil: new Date(now.getTime() + 15000), createdAt: now, expiresAt: new Date(now.getTime() + 60000) };
const create = vi.spyOn(RuntimeLogRepository.prototype, 'create'), get = vi.spyOn(RuntimeLogRepository.prototype, 'get'), finish = vi.spyOn(RuntimeLogRepository.prototype, 'finish');
const list = vi.spyOn(RuntimeLogRepository.prototype, 'listSince');
const enqueue = vi.fn(), requireConfigured = vi.fn(), consume = vi.fn();
@Module({ controllers: [RuntimeLogsController], providers: [RuntimeLogsService, ProjectApiGuard,
  { provide: DatabaseService, useValue: { db: {} } },
  { provide: ProjectsService, useValue: {
    findUserId: async () => actor,
    findById: async (pid: string, auth: { subject: string }, permission: ProjectPermission) => {
      if (pid !== projectId || auth.subject === 'outsider') throw new NotFoundException();
      if (!canAccessProject(auth.subject, permission)) throw new ForbiddenException(); return { id: pid };
    },
  } }, { provide: RuntimeLogQueueService, useValue: { enqueue, requireConfigured } },
  { provide: InvitationRateLimiter, useValue: { consume } },
  { provide: AuthService, useValue: { authenticate: async (header?: string) => {
    const subject = header?.replace('Bearer ', ''); if (!subject) throw new UnauthorizedException(); return { issuer: 'https://issuer.example', subject };
  } } },
] }) class TestApp {}
let app: INestApplication, base: string;
const request = (path = '', method = 'GET', body?: unknown, role: string | null = 'viewer') => fetch(base + path, { method,
  headers: { ...(role ? { authorization: 'Bearer ' + role } : {}), ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
beforeAll(async () => {
  vi.stubEnv('AUTH_MODE', 'oidc'); vi.stubEnv('NODE_ENV', 'test'); vi.stubEnv('OIDC_ISSUER', 'https://issuer.example');
  vi.stubEnv('OIDC_API_AUDIENCE', 'forgekit-api'); vi.stubEnv('OIDC_JWKS_URL', 'https://issuer.example/jwks');
  vi.stubEnv('FORGEKIT_DEPLOY_ENCRYPTION_KEY', randomBytes(32).toString('hex'));
  app = await NestFactory.create(TestApp, { logger: false }); await app.listen(0, '127.0.0.1'); base = `${await app.getUrl()}/api/v1/projects/${projectId}/runtime-log-sessions`;
});
afterAll(async () => { await app?.close(); vi.restoreAllMocks(); vi.unstubAllEnvs(); });
beforeEach(() => {
  vi.clearAllMocks(); create.mockResolvedValue(row); get.mockResolvedValue(row); finish.mockResolvedValue(undefined); list.mockResolvedValue([]);
  enqueue.mockResolvedValue(undefined); consume.mockResolvedValue(undefined);
});
describe('B15 default-deny runtime log APIs', () => {
  it('allows viewer/editor/owner reads and session starts; denies unknown, local, anonymous and outsiders', async () => {
    for (const role of ['owner', 'editor', 'viewer']) expect((await request('', 'POST', input, role)).status).toBe(201);
    for (const [role, status] of [[null, 401], ['outsider', 404], ['unknown', 403]] as const) expect((await request('', 'POST', input, role)).status).toBe(status);
    await expect(app.get(RuntimeLogsService).create(projectId, input, { mode: 'local' })).rejects.toBeInstanceOf(ForbiddenException);
    get.mockResolvedValueOnce({ ...row, projectId: randomUUID() }); expect((await request('/' + id)).status).toBe(404);
    get.mockResolvedValueOnce({ ...row, actorUserId: randomUUID() }); expect((await request('/' + id)).status).toBe(404);
  });
  it('serializes explicit public fields, queues identifiers only and rate-limits starts/polls/cancel', async () => {
    const response = await request('', 'POST', input);
    expect(response.headers.get('cache-control')).toBe('no-store');
    const data = await response.json();
    expect(Object.keys(data).sort()).toEqual(['id', 'projectId', 'domainId', 'deployTargetId', 'source', 'status', 'errorCode', 'createdAt', 'expiresAt'].sort());
    expect(enqueue).toHaveBeenCalledWith(id); expect(consume).toHaveBeenCalledWith('runtime-start', 'https://issuer.example', 'viewer');
    expect((await request('/' + id + '/logs?seq=0&limit=200')).status).toBe(200);
    expect(consume).toHaveBeenLastCalledWith('runtime-poll', 'https://issuer.example', 'viewer');
    expect((await request('/' + id, 'DELETE')).status).toBe(204); expect(finish).toHaveBeenCalledWith(id, 'canceled');
    consume.mockRejectedValueOnce(new HttpException('rate limit', 429)); expect((await request('', 'POST', input)).status).toBe(429);
  });
  it('rejects user paths, commands and unknown fields before any worker/SSH work', async () => {
    for (const value of [{ ...input, source: '../../etc/passwd' }, { ...input, path: '/etc/passwd' }, { ...input, lines: 1001 }, { ...input, command: 'id' }]) {
      expect((await request('', 'POST', value)).status).toBe(400);
    }
    expect(create).not.toHaveBeenCalled(); expect(enqueue).not.toHaveBeenCalled();
  });
  it('maps admission, state and DB errors to safe errors; failed enqueue closes the session', async () => {
    for (const [error, status] of [[new RuntimeLogLimitError(), 429], [new DeployConflictError(), 409], [new DeployNotFoundError(), 404], [new Error('password=hidden'), 503]] as const) {
      create.mockRejectedValueOnce(error); const response = await request('', 'POST', input);
      expect(response.status).toBe(status); expect(await response.text()).not.toContain('hidden');
    }
    enqueue.mockRejectedValueOnce(new Error('token=hidden'));
    expect((await request('', 'POST', input)).status).toBe(503); expect(finish).toHaveBeenCalledWith(id, 'failed', 'runtime_queue_failed');
  });
});
