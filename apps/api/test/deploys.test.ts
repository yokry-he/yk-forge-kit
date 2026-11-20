import 'reflect-metadata';
import { generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ForbiddenException, Module, NotFoundException, UnauthorizedException, type INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { DeployRepository, DeployConflictError, decryptDeployKey, type DeploymentRow, type DeployTargetRow } from '@forgekit/db';
import { canAccessProject, type ProjectPermission } from '@forgekit/identity-core';
import { DeploysController } from '../src/deploys.controller';
import { DeploysService } from '../src/deploys.service';
import { DeployQueueService } from '../src/deploy-queue.service';
import { DatabaseService } from '../src/database.service';
import { ProjectsService } from '../src/projects.service';
import { InvitationRateLimiter } from '../src/invitation-rate-limiter';
import { ProjectApiGuard } from '../src/project-api.guard';
import { AuthService } from '../src/auth.service';
const projectId = randomUUID(), targetId = randomUUID(), actorId = randomUUID(), buildId = randomUUID();
const now = new Date(), key = randomBytes(32);
const privateKey = generateKeyPairSync('ed25519').privateKey.export({ format: 'pem', type: 'pkcs8' }).toString();
const input = { name: '站点', host: 'example.com', port: 22, username: 'deploy', hostKey: 'ssh-ed25519 AAAA', basePath: '/srv/forgekit', retention: 5 };
const target: DeployTargetRow = { ...input, id: targetId, projectId, kind: 'ssh', encryptedPrivateKey: 'encrypted-secret', currentReleaseId: null,
  disabledAt: null, createdBy: actorId, createdAt: now, updatedAt: now };
const job: DeploymentRow = { id: randomUUID(), projectId, buildId, deployTargetId: targetId, environmentId: randomUUID(), status: 'pending', action: 'deploy',
  releaseId: randomUUID(), rollbackOf: null, triggeredBy: actorId, retained: false, errorMessage: null, startedAt: null, finishedAt: null, createdAt: now, updatedAt: now };
const save = vi.spyOn(DeployRepository.prototype, 'saveTarget'), getTarget = vi.spyOn(DeployRepository.prototype, 'target');
const listTargets = vi.spyOn(DeployRepository.prototype, 'listTargets'), remove = vi.spyOn(DeployRepository.prototype, 'removeTarget');
const create = vi.spyOn(DeployRepository.prototype, 'create'), get = vi.spyOn(DeployRepository.prototype, 'get'), transition = vi.spyOn(DeployRepository.prototype, 'transition');
const enqueue = vi.fn(), requireConfigured = vi.fn(), consume = vi.fn();
@Module({ controllers: [DeploysController], providers: [DeploysService, ProjectApiGuard,
  { provide: DatabaseService, useValue: { db: {} } },
  { provide: ProjectsService, useValue: {
    findUserId: async () => actorId,
    findById: async (id: string, auth: { subject: string }, permission: ProjectPermission) => {
      if (id !== projectId || auth.subject === 'outsider') throw new NotFoundException();
      if (!canAccessProject(auth.subject, permission)) throw new ForbiddenException(); return { id };
    },
  } }, { provide: DeployQueueService, useValue: { enqueue, requireConfigured } },
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
  vi.stubEnv('FORGEKIT_DEPLOY_ENCRYPTION_KEY', key.toString('hex'));
  app = await NestFactory.create(TestApp, { logger: false }); await app.listen(0, '127.0.0.1'); base = `${await app.getUrl()}/api/v1/projects/${projectId}`;
});
afterAll(async () => { await app.close(); vi.restoreAllMocks(); vi.unstubAllEnvs(); });
beforeEach(() => {
  vi.clearAllMocks(); save.mockResolvedValue(undefined); getTarget.mockResolvedValue(target); listTargets.mockResolvedValue([target]);
  remove.mockResolvedValue(undefined); create.mockResolvedValue(job); get.mockResolvedValue(job); transition.mockResolvedValue(undefined);
  enqueue.mockResolvedValue(undefined); requireConfigured.mockReturnValue(undefined);
});
describe('B12 authorized deploy APIs', () => {
  it('authenticates, denies viewer mutations and local identities, and hides outsiders', async () => {
    for (const [path, method, body] of [['/deploy-targets', 'POST', { ...input, privateKey }], ['/deployments', 'POST', { buildId, deployTargetId: targetId }], [`/deployments/${job.id}/rollback`, 'POST', undefined]] as const) {
      expect((await request(path, method, body, null)).status).toBe(401);
      expect((await request(path, method, body, 'viewer')).status).toBe(403);
      expect((await request(path, method, body, 'outsider')).status).toBe(404);
    }
    await expect(app.get(DeploysService).listTargets(projectId, { mode: 'local' })).rejects.toBeInstanceOf(ForbiddenException);
    expect(save).not.toHaveBeenCalled(); expect(enqueue).not.toHaveBeenCalled();
  });
  it('encrypts private keys with per-target AAD and never serializes keys or blobs', async () => {
    const response = await request('/deploy-targets', 'POST', { ...input, privateKey }, 'editor'); expect(response.status).toBe(201);
    const call = save.mock.calls[0]!;
    expect(decryptDeployKey(call[4]!, key, projectId, call[1]).toString()).toBe(privateKey);
    for (const path of ['/deploy-targets']) {
      const text = await (await request(path, 'GET', undefined, 'viewer')).text();
      expect(text).not.toContain('encrypted-secret'); expect(text).not.toContain('PrivateKey'); expect(text).not.toContain(privateKey);
    }
    expect(await response.text()).not.toContain('encrypted-secret'); expect(response.headers.get('cache-control')).toBe('no-store');
  });
  it('edits without replacing a key and permits target removal without deleting history', async () => {
    expect((await request('/deploy-targets/' + targetId, 'PATCH', input)).status).toBe(200);
    expect(save.mock.calls[0]![4]).toBeUndefined();
    expect((await request('/deploy-targets/' + targetId, 'DELETE')).status).toBe(204);
    expect(remove).toHaveBeenCalledWith(projectId, targetId, actorId);
  });
  it('rejects bad input, missing encryption, busy targets and cross-project records', async () => {
    for (const body of [{ ...input, hostKey: '', privateKey }, { ...input, username: 'root', privateKey }, { ...input, privateKey: 'raw-invalid-secret' }]) expect((await request('/deploy-targets', 'POST', body)).status).toBe(400);
    save.mockRejectedValueOnce(new DeployConflictError()); expect((await request('/deploy-targets/' + targetId, 'PATCH', input)).status).toBe(409);
    vi.stubEnv('FORGEKIT_DEPLOY_ENCRYPTION_KEY', '');
    expect((await request('/deploy-targets', 'POST', { ...input, privateKey })).status).toBe(503);
    vi.stubEnv('FORGEKIT_DEPLOY_ENCRYPTION_KEY', key.toString('hex'));
    get.mockResolvedValueOnce({ ...job, projectId: randomUUID() });
    expect((await request('/deployments/' + job.id)).status).toBe(404);
  });
  it('queues identifier-only jobs and creates a separate audited rollback operation', async () => {
    const response = await request('/deployments', 'POST', { buildId, deployTargetId: targetId }); expect(response.status).toBe(201);
    expect(create).toHaveBeenCalledWith({ projectId, buildId, deployTargetId: targetId, actor: actorId, rollbackOf: undefined });
    expect(enqueue).toHaveBeenCalledWith(job.id);
    expect((await request(`/deployments/${job.id}/rollback`, 'POST')).status).toBe(201);
    expect(create).toHaveBeenLastCalledWith({ projectId, buildId, deployTargetId: targetId, actor: actorId, rollbackOf: job.id });
    expect((await request(`/deployments/${job.id}/rollback`, 'POST', { command: 'injection' })).status).toBe(400);
    create.mockRejectedValueOnce(new DeployConflictError()); expect((await request('/deployments', 'POST', { buildId, deployTargetId: targetId })).status).toBe(409);
  });
});
