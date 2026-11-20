import 'reflect-metadata';
import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ForbiddenException, HttpException, Module, NotFoundException, UnauthorizedException, type INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { EnvironmentVariableRepository, decryptVariable, type VariableRow } from '@forgekit/db';
import { canAccessProject, type ProjectPermission } from '@forgekit/identity-core';
import { EnvironmentVariablesController } from '../src/environment-variables.controller';
import { EnvironmentVariablesService } from '../src/environment-variables.service';
import { DatabaseService } from '../src/database.service';
import { ProjectsService } from '../src/projects.service';
import { InvitationRateLimiter } from '../src/invitation-rate-limiter';
import { ProjectApiGuard } from '../src/project-api.guard';
import { AuthService } from '../src/auth.service';
import { configureJsonBodyParser } from '../src/json-body-parser';
const pid = randomUUID(), eid = randomUUID(), actor = randomUUID(), key = randomBytes(32), secret = 'b14-api-secret-value';
const row: VariableRow = { projectId: pid, environmentId: eid, name: 'TOKEN', kind: 'secret', plainValue: null,
  encryptedValue: 'v1.ciphertext-never-returned', updatedBy: actor, updatedAt: new Date() };
const save = vi.spyOn(EnvironmentVariableRepository.prototype, 'save'), list = vi.spyOn(EnvironmentVariableRepository.prototype, 'list');
const environments = vi.spyOn(EnvironmentVariableRepository.prototype, 'environments'), remove = vi.spyOn(EnvironmentVariableRepository.prototype, 'remove');
const consume = vi.fn();
@Module({ controllers: [EnvironmentVariablesController], providers: [EnvironmentVariablesService, ProjectApiGuard,
  { provide: DatabaseService, useValue: { db: {} } },
  { provide: ProjectsService, useValue: { findUserId: async () => actor,
    findById: async (id: string, auth: { subject: string }, permission: ProjectPermission) => {
      if (id !== pid || auth.subject === 'outsider') throw new NotFoundException();
      if (!canAccessProject(auth.subject, permission)) throw new ForbiddenException(); return { id };
    } } },
  { provide: InvitationRateLimiter, useValue: { consume } },
  { provide: AuthService, useValue: { authenticate: async (header?: string) => {
    const subject = header?.replace('Bearer ', ''); if (!subject) throw new UnauthorizedException(); return { issuer: 'https://issuer.example', subject };
  } } },
] }) class TestApp {}
let app: INestApplication, base: string;
const request = (method = 'GET', body?: unknown, role: string | null = 'owner', path = '/preview/variables/TOKEN') => fetch(base + path, { method,
  headers: { ...(role ? { authorization: 'Bearer ' + role } : {}), ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
beforeAll(async () => {
  vi.stubEnv('AUTH_MODE', 'oidc'); vi.stubEnv('NODE_ENV', 'test'); vi.stubEnv('OIDC_ISSUER', 'https://issuer.example');
  vi.stubEnv('OIDC_API_AUDIENCE', 'forgekit-api'); vi.stubEnv('OIDC_JWKS_URL', 'https://issuer.example/jwks');
  vi.stubEnv('FORGEKIT_DEPLOY_ENCRYPTION_KEY', key.toString('hex'));
  const application = await NestFactory.create<NestExpressApplication>(TestApp, { logger: false });
  configureJsonBodyParser(application);
  app = application; await app.listen(0, '127.0.0.1'); base = `${await app.getUrl()}/api/v1/projects/${pid}/environments`;
});
afterAll(async () => { await app.close(); vi.restoreAllMocks(); vi.unstubAllEnvs(); });
beforeEach(() => {
  vi.clearAllMocks(); save.mockResolvedValue(row); list.mockResolvedValue([row, { ...row, name: 'URL', kind: 'plain', plainValue: 'visible' }]);
  environments.mockResolvedValue([]); remove.mockResolvedValue(undefined); consume.mockResolvedValue(undefined);
});
describe('B14 API', () => {
  it('denies anonymous, viewer writes, outsiders, unknown roles and local mode', async () => {
    const input = { kind: 'secret', value: secret };
    expect((await request('PUT', input, null)).status).toBe(401);
    for (const method of ['PUT', 'DELETE']) {
      expect((await request(method, method === 'PUT' ? input : undefined, 'viewer')).status).toBe(403);
      expect((await request(method, method === 'PUT' ? input : undefined, 'outsider')).status).toBe(404);
      expect((await request(method, method === 'PUT' ? input : undefined, 'unknown')).status).toBe(403);
    }
    await expect(app.get(EnvironmentVariablesService).list(pid, 'preview', { mode: 'local' })).rejects.toBeInstanceOf(ForbiddenException);
    expect(save).not.toHaveBeenCalled(); expect(remove).not.toHaveBeenCalled();
  });
  it('permits editors and never returns a secret on writes or viewer lists', async () => {
    save.mockImplementationOnce(async (projectId, _env, name, input, _actor, encrypt) => {
      const blob = encrypt(input.value, eid);
      expect(blob).not.toContain(secret); expect(decryptVariable(blob, key, projectId, eid, name).toString()).toBe(secret);
      return { ...row, encryptedValue: blob };
    });
    const response = await request('PUT', { kind: 'secret', value: secret }, 'editor');
    expect(response.status).toBe(200); expect(await response.json()).toEqual({ name: 'TOKEN', kind: 'secret', updatedAt: row.updatedAt.toISOString(), updatedBy: actor });
    expect(response.headers.get('cache-control')).toBe('no-store');
    const values = await (await request('GET', undefined, 'viewer', '/preview/variables')).json();
    expect(values[1].value).toBe('visible'); expect(values[0].value).toBeUndefined();
    expect(JSON.stringify(values)).not.toMatch(/ciphertext|encryptedValue|b14-api-secret/);
    expect(consume).toHaveBeenCalledWith('variable-write', 'https://issuer.example', 'editor');
    const single = await (await request('GET', undefined, 'viewer')).json();
    expect(single.kind).toBe('secret'); expect(single.value).toBeUndefined();
    expect(JSON.stringify(single)).not.toMatch(/ciphertext|encryptedValue/);
    expect((await request('GET', undefined, 'viewer', '/preview/variables/MISSING')).status).toBe(404);
  });
  it('requires explicit replacement on kind conversion and rejects invalid input without echo', async () => {
    for (const body of [{ kind: 'plain' }, { kind: 'secret', value: '' }, { kind: 'secret', value: secret, encryptedValue: 'blob' }, { kind: 'plain', value: 'nul\0value' }]) {
      const response = await request('PUT', body); expect(response.status).toBe(400);
      const text = await response.text(); expect(text).not.toContain(secret);
      expect(JSON.parse(text)).toEqual({ statusCode: 400, message: '构建请求参数无效。', error: 'Bad Request' });
    }
    expect((await request('PUT', { kind: 'secret', value: secret }, 'owner', '/preview/variables/FORGEKIT_DEPLOY_ENCRYPTION_KEY')).status).toBe(400);
    save.mockResolvedValueOnce({ ...row, kind: 'plain', plainValue: 'replacement', encryptedValue: null });
    const response = await request('PUT', { kind: 'plain', value: 'replacement' });
    expect((await response.json()).value).toBe('replacement');
    expect((await request('DELETE')).status).toBe(204); expect(remove).toHaveBeenCalledWith(pid, 'preview', 'TOKEN', actor);
  });
  it('rejects malformed JSON without echoing submitted secrets', async () => {
    const submittedSecret = 'S3cr3t';
    for (const body of [
      `{"kind":"secret","value": ${submittedSecret}}`,
      `{"kind":"secret","value":"${submittedSecret}",}`,
      `"${submittedSecret}"`,
    ]) {
      const response = await fetch(base + '/preview/variables/TOKEN', { method: 'PUT',
        headers: { authorization: 'Bearer owner', 'content-type': 'application/json' }, body });
      expect(response.status).toBe(400);
      const text = await response.text();
      expect(text).not.toContain(submittedSecret); expect(text).not.toContain(body);
      expect(JSON.parse(text)).toEqual({ statusCode: 400, message: '请求体不是有效 JSON', error: 'Bad Request' });
    }
    expect(save).not.toHaveBeenCalled(); expect(consume).not.toHaveBeenCalled();
  });
  it('enforces the identity write rate limiter', async () => {
    consume.mockRejectedValueOnce(new HttpException('请求过于频繁', 429));
    expect((await request('PUT', { kind: 'secret', value: secret })).status).toBe(429);
    expect(save).not.toHaveBeenCalled();
  });
  it('maps driver errors without leaking SQL parameters and fails closed without encryption', async () => {
    save.mockRejectedValueOnce(new Error('SQL parameters: ' + secret));
    const response = await request('PUT', { kind: 'secret', value: secret }); expect(response.status).toBe(503); expect(await response.text()).not.toContain(secret);
    vi.stubEnv('FORGEKIT_DEPLOY_ENCRYPTION_KEY', '');
    expect((await request('PUT', { kind: 'secret', value: secret })).status).toBe(503);
    vi.stubEnv('FORGEKIT_DEPLOY_ENCRYPTION_KEY', key.toString('hex'));
    expect(await (await request('GET', undefined, 'viewer', '')).json()).toEqual([{ name: 'preview' }, { name: 'production' }]);
  });
});
