import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { resolve } from 'node:path';
import { once } from 'node:events';
import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { projects as projectTable, requireDisposableTestDatabase, users } from '@forgekit/db';
import { DatabaseService } from '../src/database.service';
import { ProjectsService } from '../src/projects.service';

/**
 * Real Keycloak end-to-end test (opt-in). Requires a disposable Keycloak started from
 * infra/keycloak/forgekit-dev-realm.json plus the disposable MySQL integration database.
 * Tokens are obtained through the realm's real public client using authorization code + PKCE S256,
 * so the realm does not need password grants. Test users are created and deleted through the
 * Keycloak admin API; no credentials are committed.
 */
const enabled = process.env.FORGEKIT_DB_INTEGRATION === '1' && process.env.FORGEKIT_KEYCLOAK_E2E === '1';
const keycloakUrl = (process.env.FORGEKIT_KEYCLOAK_URL ?? 'http://127.0.0.1:18080').replace(/\/$/, '');

/** Admin credentials may only ever be sent to a disposable loopback Keycloak. */
function assertLoopbackKeycloak(url: string): void {
  const parsed = new URL(url);
  if (parsed.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(parsed.hostname) || parsed.username || parsed.password ||
      (parsed.pathname !== '/' && parsed.pathname !== '') || parsed.search || parsed.hash) {
    throw new Error('FORGEKIT_KEYCLOAK_URL 只允许本机回环的一次性 Keycloak，例如 http://127.0.0.1:18080。');
  }
}
const realm = 'forgekit-dev';
const issuer = `${keycloakUrl}/realms/${realm}`;
const clientId = 'forgekit-web';
const redirectUri = 'http://127.0.0.1:5173/auth/callback';

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('无法分配 HTTP 测试端口。');
  await new Promise<void>((done) => server.close(() => done()));
  return address.port;
}

async function waitForApi(base: string, child: ChildProcess): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (child.exitCode !== null || child.signalCode !== null) throw new Error('测试 API 提前退出。');
    try {
      const response = await fetch(`${base}/api/v1/health`, { signal: AbortSignal.timeout(500) });
      if (response.ok) return;
    } catch { /* Still starting. */ }
    await new Promise((done) => setTimeout(done, 50));
  }
  throw new Error('测试 API 启动超时。');
}

async function adminToken(): Promise<string> {
  const user = process.env.FORGEKIT_KEYCLOAK_ADMIN_USER;
  const password = process.env.FORGEKIT_KEYCLOAK_ADMIN_PASSWORD;
  if (!user || !password) throw new Error('需要 FORGEKIT_KEYCLOAK_ADMIN_USER / FORGEKIT_KEYCLOAK_ADMIN_PASSWORD（仅限一次性测试 Keycloak）。');
  assertLoopbackKeycloak(keycloakUrl);
  const response = await fetch(`${keycloakUrl}/realms/master/protocol/openid-connect/token`, {
    method: 'POST', redirect: 'error', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'password', client_id: 'admin-cli', username: user, password }),
  });
  if (!response.ok) throw new Error(`Keycloak 管理员令牌获取失败：${response.status}`);
  return ((await response.json()) as { access_token: string }).access_token;
}

async function createUser(admin: string, username: string, password: string): Promise<string> {
  const response = await fetch(`${keycloakUrl}/admin/realms/${realm}/users`, {
    method: 'POST', headers: { Authorization: `Bearer ${admin}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, email: `${username}@example.test`, emailVerified: true, firstName: 'E2E', lastName: username,
      enabled: true, requiredActions: [], credentials: [{ type: 'password', value: password, temporary: false }] }),
  });
  if (response.status !== 201) throw new Error(`创建 Keycloak 测试用户失败：${response.status}`);
  const id = response.headers.get('location')?.split('/').pop();
  if (!id) throw new Error('Keycloak 未返回测试用户 ID。');
  return id;
}

async function deleteUser(admin: string, id: string): Promise<void> {
  const response = await fetch(`${keycloakUrl}/admin/realms/${realm}/users/${id}`, { method: 'DELETE', redirect: 'error', headers: { Authorization: `Bearer ${admin}` } });
  if (response.status !== 204 && response.status !== 404) throw new Error(`删除 Keycloak 测试用户失败：${response.status}`);
}

/** Browser-equivalent authorization code + PKCE S256 login against the real realm client. */
async function login(username: string, password: string): Promise<{ accessToken: string; idToken: string }> {
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  const state = randomBytes(16).toString('base64url');
  const authorize = new URL(`${issuer}/protocol/openid-connect/auth`);
  authorize.search = new URLSearchParams({ client_id: clientId, response_type: 'code', scope: 'openid', redirect_uri: redirectUri,
    state, nonce: randomUUID(), code_challenge: challenge, code_challenge_method: 'S256' }).toString();
  const page = await fetch(authorize, { redirect: 'manual' });
  expect(page.status).toBe(200);
  const cookies = page.headers.getSetCookie().map((cookie) => cookie.split(';')[0]).join('; ');
  const html = await page.text();
  const action = /<form[^>]*id="kc-form-login"[^>]*action="([^"]+)"/.exec(html)?.[1] ?? /action="([^"]+login-actions\/authenticate[^"]*)"/.exec(html)?.[1];
  if (!action) throw new Error('未找到 Keycloak 登录表单。');
  const submitted = await fetch(action.replace(/&amp;/g, '&'), {
    method: 'POST', redirect: 'manual', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: cookies },
    body: new URLSearchParams({ username, password, credentialId: '' }),
  });
  expect(submitted.status).toBe(302);
  const callback = new URL(submitted.headers.get('location') ?? '');
  expect(`${callback.origin}${callback.pathname}`).toBe(redirectUri);
  expect(callback.searchParams.get('state')).toBe(state);
  const code = callback.searchParams.get('code');
  if (!code) throw new Error('Keycloak 未返回授权码。');
  const exchanged = await fetch(`${issuer}/protocol/openid-connect/token`, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'authorization_code', client_id: clientId, code, redirect_uri: redirectUri, code_verifier: verifier }),
  });
  expect(exchanged.status).toBe(200);
  const tokens = await exchanged.json() as { access_token: string; id_token: string };
  return { accessToken: tokens.access_token, idToken: tokens.id_token };
}

function subjectOf(token: string): string {
  return (JSON.parse(Buffer.from(token.split('.')[1] ?? '', 'base64url').toString('utf8')) as { sub: string }).sub;
}

describe.skipIf(!enabled)('real Keycloak OIDC to NestJS HTTP and MySQL', () => {
  it('logs in with PKCE, verifies Keycloak tokens and enforces project-scoped authorization', async () => {
    requireDisposableTestDatabase(process.env);
    const database = new DatabaseService();
    const projects = new ProjectsService(database);
    const runId = randomUUID().slice(0, 8);
    const slug = `keycloak-${runId}`;
    const admin = await adminToken();
    const keycloakUsers: string[] = [];
    const subjects: string[] = [];
    let api: ChildProcess | null = null;
    try {
      const password = randomBytes(18).toString('base64url');
      keycloakUsers.push(await createUser(admin, `e2e-owner-${runId}`, password));
      keycloakUsers.push(await createUser(admin, `e2e-member-${runId}`, password));
      const owner = await login(`e2e-owner-${runId}`, password);
      const member = await login(`e2e-member-${runId}`, password);
      subjects.push(subjectOf(owner.accessToken), subjectOf(member.accessToken));

      const port = await freePort();
      const base = `http://127.0.0.1:${port}`;
      api = spawn(process.execPath, [resolve(process.cwd(), 'dist/main.js')], {
        cwd: process.cwd(), stdio: 'ignore',
        env: { ...process.env, NODE_ENV: 'test', AUTH_MODE: 'oidc', API_HOST: '127.0.0.1', PORT: String(port),
          OIDC_ISSUER: issuer, OIDC_API_AUDIENCE: 'forgekit-api', OIDC_JWKS_URL: `${issuer}/protocol/openid-connect/certs`,
          OIDC_DEV_ALLOW_HTTP_LOOPBACK: 'true' },
      });
      await waitForApi(base, api);

      const auth = (token: string, json = false) => ({ Authorization: `Bearer ${token}`, ...(json ? { 'Content-Type': 'application/json' } : {}) });
      const whoami = await fetch(`${base}/api/v1/auth/whoami`, { headers: auth(owner.accessToken) });
      expect(whoami.status).toBe(200);
      expect(await whoami.json()).toEqual({ issuer, subject: subjects[0] });
      // The ID token is issued for the SPA client, not the API audience.
      expect((await fetch(`${base}/api/v1/auth/whoami`, { headers: auth(owner.idToken) })).status).toBe(401);
      const [header, payload, signature] = owner.accessToken.split('.');
      const tampered = `${header}.${payload}.${signature?.slice(0, -4)}AAAA`;
      expect((await fetch(`${base}/api/v1/auth/whoami`, { headers: auth(tampered) })).status).toBe(401);

      for (const token of [owner.accessToken, member.accessToken]) {
        expect((await fetch(`${base}/api/v1/auth/account`, { method: 'POST', headers: auth(token) })).status).toBe(201);
      }
      const created = await fetch(`${base}/api/v1/projects`, { method: 'POST', headers: auth(owner.accessToken, true),
        body: JSON.stringify({ name: slug, template: 'vue-web', features: ['router'] }) });
      expect(created.status).toBe(201);
      expect((await fetch(`${base}/api/v1/projects/${slug}`, { headers: auth(member.accessToken) })).status).toBe(404);

      const invite = await fetch(`${base}/api/v1/projects/${slug}/invitations`, { method: 'POST', headers: auth(owner.accessToken, true),
        body: JSON.stringify({ role: 'viewer' }) });
      expect(invite.status).toBe(201);
      const { code } = await invite.json() as { code: string };
      const redeemed = await fetch(`${base}/api/v1/invitations/redeem`, { method: 'POST', headers: auth(member.accessToken, true),
        body: JSON.stringify({ code }) });
      expect(redeemed.status).toBe(201);
      expect((await fetch(`${base}/api/v1/projects/${slug}`, { headers: auth(member.accessToken) })).status).toBe(200);
      const members = await fetch(`${base}/api/v1/projects/${slug}/members`, { headers: auth(member.accessToken) });
      expect(members.status).toBe(200);
      expect((await fetch(`${base}/api/v1/projects/${slug}/invitations`, { method: 'POST', headers: auth(member.accessToken, true),
        body: JSON.stringify({ role: 'editor' }) })).status).toBe(403);
    } finally {
      // Run every cleanup step independently; report failures without masking the original test error.
      const cleanupErrors: unknown[] = [];
      const attempt = async (step: () => Promise<unknown>) => { try { await step(); } catch (error) { cleanupErrors.push(error); } };
      if (api && api.exitCode === null && api.signalCode === null) {
        api.kill('SIGTERM');
        await Promise.race([once(api, 'exit'), new Promise((done) => setTimeout(done, 2000))]);
        if (api.exitCode === null && api.signalCode === null) api.kill('SIGKILL');
      }
      await attempt(() => database.db.delete(projectTable).where(eq(projectTable.slug, slug)));
      for (const subject of subjects) {
        await attempt(async () => {
          const id = await projects.findUserId({ mode: 'oidc', issuer, subject });
          if (id) await database.db.delete(users).where(eq(users.id, id));
        });
      }
      for (const id of keycloakUsers) await attempt(() => deleteUser(admin, id));
      await attempt(() => database.onModuleDestroy());
      if (cleanupErrors.length > 0) {
        console.error('Keycloak E2E 清理失败：', cleanupErrors);
        throw new AggregateError(cleanupErrors, 'Keycloak E2E 清理失败，请手动检查一次性测试环境。');
      }
    }
  }, 60_000);
});
