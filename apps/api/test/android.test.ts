import 'reflect-metadata';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ForbiddenException, Module, NotFoundException, UnauthorizedException, type INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AndroidRepository, AndroidLogRepository, decryptAndroidSigning, type AndroidConfigRow, type AndroidJobRow } from '@forgekit/db';
import { LocalFsArtifactStore } from '@forgekit/artifact-store';
import { AndroidJobInputSchema } from '@forgekit/contracts';
import { canAccessProject, type ProjectPermission } from '@forgekit/identity-core';
import { AndroidController } from '../src/android.controller';
import { AndroidService } from '../src/android.service';
import { AndroidQueueService } from '../src/android-queue.service';
import { AndroidStreamsController } from '../src/android-streams.controller';
import { AndroidStreamsService } from '../src/android-streams.service';
import { AndroidStreamTickets } from '../src/android-stream-tickets';
import { DatabaseService } from '../src/database.service';
import { ProjectsService } from '../src/projects.service';
import { InvitationRateLimiter } from '../src/invitation-rate-limiter';
import { ProjectApiGuard } from '../src/project-api.guard';
import { AuthService } from '../src/auth.service';
import { configureJsonBodyParser } from '../src/json-body-parser';
const pid = randomUUID(), jid = randomUUID(), actor = randomUUID(), key = randomBytes(32);
const settings = { packageName: 'com.example.demo', appId: '__UNI__TEST123', appKey: 'synthetic-appkey', versionName: '1.0.0', versionCode: 1 };
const signing = { keystore: 'dGVzdGtleQ==', alias: 'release', storePassword: 'store-password', keyPassword: 'key-password' };
const config: AndroidConfigRow = { projectId: pid, settings, encryptedSigning: 'ciphertext-never-return', updatedBy: actor, updatedAt: new Date() };
const input = AndroidJobInputSchema.parse({ buildType: 'release', kind: 'apk' });
const row: AndroidJobRow = { id: jid, projectId: pid, settings, source: { name: 'test', features: [] }, input, status: 'queued', triggeredBy: actor,
  createdAt: new Date(), updatedAt: new Date(), startedAt: null, finishedAt: null, errorCode: null, artifactKey: null, artifact: null };
const save = vi.spyOn(AndroidRepository.prototype, 'save'), getConfig = vi.spyOn(AndroidRepository.prototype, 'config'), remove = vi.spyOn(AndroidRepository.prototype, 'remove');
const create = vi.spyOn(AndroidRepository.prototype, 'create'), get = vi.spyOn(AndroidRepository.prototype, 'get'), list = vi.spyOn(AndroidRepository.prototype, 'list'), transition = vi.spyOn(AndroidRepository.prototype, 'transition');
const logList = vi.spyOn(AndroidLogRepository.prototype, 'listSince'), high = vi.spyOn(AndroidLogRepository.prototype, 'highestSeq');
const cancel = vi.spyOn(AndroidRepository.prototype, 'cancel');
const consume = vi.fn(), enqueue = vi.fn(), requireConfigured = vi.fn();
const tickets = { issue: vi.fn(), take: vi.fn() };
@Module({ controllers: [AndroidController, AndroidStreamsController], providers: [AndroidService, AndroidStreamsService, ProjectApiGuard,
  { provide: DatabaseService, useValue: { db: {} } },
  { provide: ProjectsService, useValue: { findUserId: async () => actor,
    findById: async (id: string, auth: { subject: string }, permission: ProjectPermission) => {
      if (id !== pid || auth.subject === 'outsider') throw new NotFoundException();
      if (!canAccessProject(auth.subject, permission)) throw new ForbiddenException(); return { id, template: 'uniapp' };
    } } },
  { provide: InvitationRateLimiter, useValue: { consume } },
  { provide: AndroidQueueService, useValue: { enqueue, requireConfigured } },
  { provide: AndroidStreamTickets, useValue: tickets },
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
  vi.stubEnv('FORGEKIT_ANDROID_IMAGE', 'forgekit-android:test');
  vi.stubEnv('FORGEKIT_DEPLOY_ENCRYPTION_KEY', key.toString('hex'));
  root = await mkdtemp(join(tmpdir(), 'b18-api-')); vi.stubEnv('FORGEKIT_ARTIFACT_DIR', join(root, 'store'));
  const source = join(root, 'qr'); await mkdir(source); await writeFile(join(source, 'app.apk'), Buffer.from([255, 216, 1, 255, 217]));
  qrKey = (await new LocalFsArtifactStore(join(root, 'store')).put(jid, source, new AbortController().signal)).key;
  const application = await NestFactory.create<NestExpressApplication>(TestApp, { logger: false }); configureJsonBodyParser(application);
  app = application; await app.listen(0, '127.0.0.1'); base = `${await app.getUrl()}/api/v1/projects/${pid}/android`;
});
afterAll(async () => { await app.close(); await rm(root, { recursive: true, force: true }); vi.restoreAllMocks(); vi.unstubAllEnvs(); });
beforeEach(() => {
  vi.clearAllMocks(); cancel.mockResolvedValue(undefined); getConfig.mockResolvedValue(config); save.mockResolvedValue(config); remove.mockResolvedValue(undefined);
  create.mockResolvedValue(row); get.mockResolvedValue(row); list.mockResolvedValue([row]); transition.mockResolvedValue(undefined);
  logList.mockResolvedValue([]); high.mockResolvedValue(0); consume.mockResolvedValue(undefined); enqueue.mockResolvedValue(undefined);
});
describe('B18 Android APIs', () => {
  it('encrypts signing as a whole; reads and audit-facing metadata never include ciphertext or signing fields', async () => {
    save.mockImplementationOnce(async (projectId, metadata, encrypted) => {
      expect(metadata).toEqual(settings); expect(encrypted).not.toContain(signing.storePassword);
      expect(JSON.parse(decryptAndroidSigning(encrypted!, key, projectId).toString())).toEqual(signing);
      return { ...config, encryptedSigning: encrypted! };
    });
    const response = await request('/config', 'PUT', { ...settings, signing });
    expect(response.status).toBe(200); expect(response.headers.get('cache-control')).toBe('no-store');
    const text = await response.text(); expect(JSON.parse(text)).toMatchObject({ hasSigning: true, settings });
    expect(text).not.toMatch(/keystore|Password|encrypted|ciphertext|release/);
    expect((await request('/config', 'GET', undefined, 'viewer')).status).toBe(200);
    expect((await request('/config', 'PUT', settings)).status).toBe(200);
    expect(save).toHaveBeenLastCalledWith(pid, settings, undefined, actor);
    expect((await request('/config', 'DELETE')).status).toBe(204);
  });
  it('uses generic validation/storage errors and never returns the submitted secrets', async () => {
    for (const value of [{ ...settings, signing: { ...signing, keystore: 'secret%' } }, { ...settings, signing: { ...signing, storePassword: 'x' } }, { ...settings, packageName: '../' }]) {
      const response = await request('/config', 'PUT', value); expect(response.status).toBe(400); expect(await response.text()).not.toContain('secret%');
    }
    save.mockRejectedValueOnce(new Error('SQL:' + signing.storePassword));
    const response = await request('/config', 'PUT', { ...settings, signing }); expect(response.status).toBe(503); expect(await response.text()).not.toContain(signing.storePassword);
  });
  it('enforces existing roles on configuration, trigger, cancel, logs, artifact and tickets', async () => {
    expect((await request('/config', 'GET', undefined, null)).status).toBe(401);
    for (const role of ['viewer', 'unknown', 'outsider']) for (const [path, method, body] of [['/config', 'PUT', settings], ['/config', 'DELETE', undefined], ['/jobs', 'POST', input], [`/jobs/${jid}/cancel`, 'POST', undefined]] as const) {
      expect((await request(path, method, body, role)).status).toBe(role === 'outsider' ? 404 : 403);
    }
    for (const path of ['/config', '/jobs', `/jobs/${jid}`, `/jobs/${jid}/logs`, `/jobs/${jid}/artifact`]) expect((await request(path, 'GET', undefined, 'outsider')).status).toBe(404);
    expect((await request(`/jobs/${jid}/log-stream-ticket`, 'POST', undefined, 'outsider')).status).toBe(404);
    expect((await request('/jobs', 'GET', undefined, 'viewer')).status).toBe(200);
  });
  it('enqueues only IDs, sanitizes queue failures and supports cancellation', async () => {
    expect((await request('/jobs', 'POST', input)).status).toBe(201); expect(create).toHaveBeenCalledWith(pid, input, actor); expect(enqueue).toHaveBeenCalledWith(jid);
    expect((await request(`/jobs/${jid}/cancel`, 'POST')).status).toBe(201); expect(cancel).toHaveBeenCalledWith(pid, jid, actor);
    enqueue.mockRejectedValueOnce(new Error(signing.storePassword)); const response = await request('/jobs', 'POST', input);
    expect(response.status).toBe(503); expect(await response.text()).not.toContain(signing.storePassword); expect(transition).toHaveBeenCalledWith(jid, 'queued', 'failed', 'android_enqueue_failed');
    vi.stubEnv('FORGEKIT_ANDROID_IMAGE', ''); expect((await request('/jobs', 'POST', input)).status).toBe(503); vi.stubEnv('FORGEKIT_ANDROID_IMAGE', 'forgekit-android:test');
  });
  it('returns artifact checksums and authenticated attachments; cross-project and missing artifacts fail closed', async () => {
    const artifact = { kind: 'apk' as const, sha256: 'a'.repeat(64), size: 5 };
    get.mockResolvedValue({ ...row, status: 'succeeded', artifactKey: qrKey, artifact });
    const detail = await request(`/jobs/${jid}`); expect(await detail.json()).toMatchObject({ settings, input, artifact });
    const response = await request(`/jobs/${jid}/artifact`, 'GET', undefined, 'viewer');
    expect(response.status).toBe(200); expect(response.headers.get('content-disposition')).toBe('attachment; filename="app.apk"'); expect(response.headers.get('cache-control')).toBe('no-store');
    expect((await response.arrayBuffer()).byteLength).toBe(5);
    get.mockResolvedValueOnce({ ...row, projectId: randomUUID() }); expect((await request(`/jobs/${jid}/artifact`)).status).toBe(404);
    get.mockResolvedValueOnce(row); expect((await request(`/jobs/${jid}/artifact`)).status).toBe(404);
  });
  it('streams persisted final logs before terminal end and issues scoped tickets', async () => {
    tickets.issue.mockResolvedValue({ ticket: 'a'.repeat(43), expiresAt: new Date(Date.now() + 60000).toISOString() });
    expect((await request(`/jobs/${jid}/log-stream-ticket`, 'POST')).status).toBe(201);
    get.mockResolvedValue({ ...row, status: 'succeeded' }); high.mockResolvedValue(1);
    logList.mockResolvedValue([{ jobId: jid, seq: 1, stream: 'system', content: 'done', ts: new Date() }]);
    tickets.take.mockResolvedValue({ projectId: pid, jobId: jid, auth: { mode: 'oidc', issuer: 'https://issuer.example', subject: 'viewer' }, expires: Date.now() + 60000 });
    const response = await request(`/jobs/${jid}/logs/stream?ticket=${'a'.repeat(43)}`); const text = await response.text();
    expect(response.status).toBe(200); expect(text).toContain('event: log'); expect(text).toContain('event: end'); expect(text.indexOf('event: log')).toBeLessThan(text.indexOf('event: end')); expect(text).not.toContain('ciphertext');
  });
});
