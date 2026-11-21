import 'reflect-metadata';
import { createPrivateKey, generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ForbiddenException, Module, NotFoundException, UnauthorizedException, type INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AlipayRepository, AlipayLogRepository, AlipayConflictError, decryptAlipayKey, type AlipayConfigRow, type AlipayJobRow } from '@forgekit/db';
import { LocalFsArtifactStore } from '@forgekit/artifact-store';
import { AlipayJobInputSchema } from '@forgekit/contracts';
import { canAccessProject, type ProjectPermission } from '@forgekit/identity-core';
import { AlipayController } from '../src/alipay.controller';
import { AlipayService } from '../src/alipay.service';
import { AlipayQueueService } from '../src/alipay-queue.service';
import { AlipayStreamsController } from '../src/alipay-streams.controller';
import { AlipayStreamsService } from '../src/alipay-streams.service';
import { AlipayStreamTickets } from '../src/alipay-stream-tickets';
import { DatabaseService } from '../src/database.service';
import { ProjectsService } from '../src/projects.service';
import { InvitationRateLimiter } from '../src/invitation-rate-limiter';
import { ProjectApiGuard } from '../src/project-api.guard';
import { AuthService } from '../src/auth.service';
import { configureJsonBodyParser } from '../src/json-body-parser';
const pid = randomUUID(), bid = randomUUID(), jid = randomUUID(), actor = randomUUID(), key = randomBytes(32);
// Ephemeral test key, never a Alipay account key; no calls to Alipay.
const privateKey = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ format: 'pem', type: 'pkcs8' }).toString();
const config: AlipayConfigRow = { projectId: pid, appId: '0000000000000000', encryptedPrivateKey: 'ciphertext-never-return', toolId: 'synthetic-tool', updatedBy: actor, updatedAt: new Date() };
const input = AlipayJobInputSchema.parse({ buildId: bid, version: '1.0.0', action: 'upload_preview' });
const row: AlipayJobRow = { id: jid, projectId: pid, buildId: bid, appId: config.appId, toolId: config.toolId, input, status: 'queued', triggeredBy: actor,
  createdAt: new Date(), updatedAt: new Date(), startedAt: null, finishedAt: null, errorCode: null, qrArtifactKey: null };
const save = vi.spyOn(AlipayRepository.prototype, 'save'), getConfig = vi.spyOn(AlipayRepository.prototype, 'config'), remove = vi.spyOn(AlipayRepository.prototype, 'remove');
const create = vi.spyOn(AlipayRepository.prototype, 'create'), get = vi.spyOn(AlipayRepository.prototype, 'get'), list = vi.spyOn(AlipayRepository.prototype, 'list'), transition = vi.spyOn(AlipayRepository.prototype, 'transition');
const logList = vi.spyOn(AlipayLogRepository.prototype, 'listSince'), high = vi.spyOn(AlipayLogRepository.prototype, 'highestSeq');
let projectTemplate = 'uniapp';
const consume = vi.fn(), enqueue = vi.fn(), requireConfigured = vi.fn();
const tickets = { issue: vi.fn(), take: vi.fn() };
@Module({ controllers: [AlipayController, AlipayStreamsController], providers: [AlipayService, AlipayStreamsService, ProjectApiGuard,
  { provide: DatabaseService, useValue: { db: {} } },
  { provide: ProjectsService, useValue: { findUserId: async () => actor,
    findById: async (id: string, auth: { subject: string }, permission: ProjectPermission) => {
      if (id !== pid || auth.subject === 'outsider') throw new NotFoundException();
      if (!canAccessProject(auth.subject, permission)) throw new ForbiddenException(); return { id, template: projectTemplate };
    } } },
  { provide: InvitationRateLimiter, useValue: { consume } },
  { provide: AlipayQueueService, useValue: { enqueue, requireConfigured } },
  { provide: AlipayStreamTickets, useValue: tickets },
  { provide: AuthService, useValue: { authenticate: async (header?: string) => {
    const subject = header?.replace('Bearer ', ''); if (!subject) throw new UnauthorizedException(); return { issuer: 'https://issuer.example', subject };
  } } },
] }) class TestApp {}
let app: INestApplication, base: string, root: string, qrKey: string;
const request = (path = '/config', method = 'GET', body?: unknown, role: string | null = 'owner') => fetch(base + path, { method,
  headers: { ...(role ? { authorization: 'Bearer ' + role } : {}), ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
beforeAll(async () => {
  vi.stubEnv('AUTH_MODE', 'oidc'); vi.stubEnv('NODE_ENV', 'test'); vi.stubEnv('OIDC_ISSUER', 'https://issuer.example');
  vi.stubEnv('OIDC_API_AUDIENCE', 'forgekit-api'); vi.stubEnv('OIDC_JWKS_URL', 'https://issuer.example/jwks');
  vi.stubEnv('FORGEKIT_DEPLOY_ENCRYPTION_KEY', key.toString('hex'));
  root = await mkdtemp(join(tmpdir(), 'b20-api-')); vi.stubEnv('FORGEKIT_ARTIFACT_DIR', join(root, 'store'));
  const source = join(root, 'qr'); await mkdir(source); await writeFile(join(source, 'qrcode.img'), Buffer.from([255, 216, 1, 255, 217]));
  qrKey = (await new LocalFsArtifactStore(join(root, 'store')).put(jid, source, new AbortController().signal)).key;
  const application = await NestFactory.create<NestExpressApplication>(TestApp, { logger: false }); configureJsonBodyParser(application);
  app = application; await app.listen(0, '127.0.0.1'); base = `${await app.getUrl()}/api/v1/projects/${pid}/alipay`;
});
afterAll(async () => { await app.close(); await rm(root, { recursive: true, force: true }); vi.restoreAllMocks(); vi.unstubAllEnvs(); });
beforeEach(() => {
  projectTemplate = 'uniapp'; vi.clearAllMocks(); getConfig.mockResolvedValue(config); save.mockResolvedValue(config); remove.mockResolvedValue(undefined);
  create.mockResolvedValue(row); get.mockResolvedValue(row); list.mockResolvedValue([row]); transition.mockResolvedValue(undefined);
  logList.mockResolvedValue([]); high.mockResolvedValue(0); consume.mockResolvedValue(undefined); enqueue.mockResolvedValue(undefined);
});
describe('B20 Alipay API', () => {
  it('encrypts submitted private key and exposes only write-only metadata', async () => {
    save.mockImplementationOnce(async (projectId, metadata, encrypted) => {
      expect(metadata).not.toHaveProperty('privateKey'); expect(encrypted).not.toContain(privateKey);
      expect(decryptAlipayKey(encrypted!, key, projectId).toString()).toBe(privateKey); return { ...config, encryptedPrivateKey: encrypted! };
    });
    const response = await request('/config', 'PUT', { appId: config.appId, toolId: config.toolId, privateKey }); expect(response.status).toBe(200);
    const text = await response.text(); expect(text).not.toMatch(/BEGIN|encrypted|ciphertext/); expect(JSON.parse(text).hasPrivateKey).toBe(true);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await (await request('/config', 'GET', undefined, 'viewer')).json()).toMatchObject({ hasPrivateKey: true, appId: config.appId });
    expect((await request('/config', 'PUT', { appId: config.appId, toolId: config.toolId })).status).toBe(200);
    expect(save).toHaveBeenLastCalledWith(pid, { appId: config.appId, toolId: 'synthetic-tool' }, undefined, actor);
    expect((await request('/config', 'DELETE')).status).toBe(204); expect(remove).toHaveBeenCalledWith(pid, actor);
  });
  it('normalizes PKCS1 RSA to the in-memory PKCS8 form expected by minidev', async () => {
    const pkcs1 = createPrivateKey(privateKey).export({ format: 'pem', type: 'pkcs1' }).toString();
    save.mockImplementationOnce(async (projectId, metadata, encrypted) => {
      const normalized = decryptAlipayKey(encrypted!, key, projectId).toString();
      expect(normalized).toBe(privateKey); expect(normalized).not.toContain('RSA PRIVATE KEY');
      expect(metadata).not.toHaveProperty('privateKey'); return { ...config, encryptedPrivateKey: encrypted! };
    });
    const response = await request('/config', 'PUT', { appId: config.appId, toolId: config.toolId, privateKey: pkcs1 });
    expect(response.status).toBe(200); expect(await response.text()).not.toContain('BEGIN');
  });
  it('rejects invalid config and raw database/crypto errors without echoing credentials', async () => {
    const invalid = await request('/config', 'PUT', { appId: config.appId, toolId: config.toolId, privateKey: 'INVALID'.repeat(30) });
    expect(invalid.status).toBe(400); expect(await invalid.text()).not.toContain('INVALID');
    save.mockRejectedValueOnce(new Error('SQL:' + privateKey));
    const response = await request('/config', 'PUT', { appId: config.appId, toolId: config.toolId, privateKey }); expect(response.status).toBe(503); expect(await response.text()).not.toContain('BEGIN');
    vi.stubEnv('FORGEKIT_DEPLOY_ENCRYPTION_KEY', '');
    expect((await request('/config', 'PUT', { appId: config.appId, toolId: config.toolId, privateKey })).status).toBe(503);
    vi.stubEnv('FORGEKIT_DEPLOY_ENCRYPTION_KEY', key.toString('hex'));
  });
  it('checks permitted project membership for configs, jobs, logs, QR and stream tickets', async () => {
    expect((await request('/config', 'GET', undefined, null)).status).toBe(401);
    for (const role of ['viewer', 'unknown', 'outsider']) {
      for (const [path, method, body] of [['/config', 'PUT', { appId: config.appId, toolId: config.toolId, privateKey }], ['/config', 'DELETE', undefined], ['/jobs', 'POST', input]] as const) {
        expect((await request(path, method, body, role)).status).toBe(role === 'outsider' ? 404 : 403);
      }
    }
    for (const path of ['/config', '/jobs', `/jobs/${jid}`, `/jobs/${jid}/logs`, `/jobs/${jid}/qr`]) expect((await request(path, 'GET', undefined, 'outsider')).status).toBe(404);
    expect((await request(`/jobs/${jid}/log-stream-ticket`, 'POST', undefined, 'outsider')).status).toBe(404);
    await expect(app.get(AlipayService).config(pid, { mode: 'local' })).rejects.toBeInstanceOf(ForbiddenException);
    expect(enqueue).not.toHaveBeenCalled(); expect(save).not.toHaveBeenCalled();
  });
  it('returns clear 4xx on missing build/config, rejects invalid targets, and enqueues only validated jobs', async () => {
    create.mockRejectedValueOnce(new AlipayConflictError());
    expect((await request('/jobs', 'POST', input)).status).toBe(409); expect(enqueue).not.toHaveBeenCalled();
    expect((await request('/jobs', 'POST', { ...input, target: 'publish' })).status).toBe(400); expect(enqueue).not.toHaveBeenCalled();
    expect((await request('/jobs', 'POST', input, 'editor')).status).toBe(201); expect(enqueue).toHaveBeenCalledWith(jid);
    enqueue.mockRejectedValueOnce(new Error(privateKey));
    const response = await request('/jobs', 'POST', input); expect(response.status).toBe(503); expect(await response.text()).not.toContain('BEGIN');
    expect(transition).toHaveBeenCalledWith(jid, 'queued', 'failed', 'alipay_enqueue_failed');
  });
  it('rejects non-uniapp projects before accessing configuration or enqueuing', async () => {
    projectTemplate = 'vue-web';
    expect((await request('/config')).status).toBe(400);
    expect((await request('/jobs', 'POST', input)).status).toBe(400);
    expect(create).not.toHaveBeenCalled(); expect(enqueue).not.toHaveBeenCalled();
  });
  it('serves persisted QR privately to project members and rejects cross-project/unfinished jobs', async () => {
    expect((await request(`/jobs/${jid}/qr`)).status).toBe(404);
    get.mockResolvedValue({ ...row, status: 'succeeded', qrArtifactKey: qrKey });
    const response = await request(`/jobs/${jid}/qr`, 'GET', undefined, 'viewer');
    expect(response.status).toBe(200); expect(response.headers.get('content-type')).toContain('image/jpeg');
    expect(response.headers.get('cache-control')).toBe('no-store'); expect(Buffer.from(await response.arrayBuffer())).toEqual(Buffer.from([255, 216, 1, 255, 217]));
    get.mockResolvedValueOnce({ ...row, projectId: randomUUID() }); expect((await request(`/jobs/${jid}`)).status).toBe(404);
  });
  it('streams persisted redacted logs with terminal high-water and ticket auth', async () => {
    get.mockResolvedValue({ ...row, status: 'succeeded', startedAt: new Date(), finishedAt: new Date() });
    const event = { jobId: jid, seq: 1, stream: 'system' as const, content: '[REDACTED]\n', ts: new Date() };
    high.mockResolvedValue(1); logList.mockResolvedValue([event]);
    tickets.take.mockResolvedValue({ projectId: pid, jobId: jid, auth: { mode: 'oidc', issuer: 'https://issuer.example', subject: 'viewer' }, expires: Date.now() + 60000 });
    const response = await request(`/jobs/${jid}/logs/stream?ticket=synthetic-ticket`);
    expect(response.status).toBe(200); const text = await response.text(); expect(text).toContain('event: log\nid: 1'); expect(text).toContain('event: end');
    expect(text).not.toContain(privateKey); expect(text).not.toContain('synthetic-ticket'); expect(text).toContain('[REDACTED]');
    tickets.take.mockRejectedValueOnce(new UnauthorizedException()); expect((await request(`/jobs/${jid}/logs/stream?ticket=invalid`)).status).toBe(401);
    get.mockResolvedValueOnce({ ...row, projectId: randomUUID() }); expect((await request(`/jobs/${jid}/logs`)).status).toBe(404);
  });
});
