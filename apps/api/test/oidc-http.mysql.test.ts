import { randomUUID, createPrivateKey, createPublicKey, generateKeyPairSync, sign } from 'node:crypto';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { createServer as createHttpsServer, type Server as HttpsServer } from 'node:https';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { once } from 'node:events';
import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { projects as projectTable, requireDisposableTestDatabase, users } from '@forgekit/db';
import { DatabaseService } from '../src/database.service';
import { ProjectsService } from '../src/projects.service';

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('无法分配 HTTP 测试端口。');
  await new Promise<void>((done) => server.close(() => done()));
  return address.port;
}

function jwt(privateKey: ReturnType<typeof createPrivateKey>, issuer: string, subject: string, audience = 'forgekit-api', expiresIn = 300): string {
  const now = Math.floor(Date.now() / 1000);
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const unsigned = `${encode({ alg: 'RS256', typ: 'JWT', kid: 'forgekit-e2e' })}.${encode({ iss: issuer, aud: audience, sub: subject, iat: now, exp: now + expiresIn })}`;
  return `${unsigned}.${sign('RSA-SHA256', Buffer.from(unsigned), privateKey).toString('base64url')}`;
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

describe.skipIf(process.env.FORGEKIT_DB_INTEGRATION !== '1')('OIDC signed-token to NestJS HTTP integration', () => {
  it('verifies remote JWKS and project-level authorization over real HTTP and MySQL', async () => {
    requireDisposableTestDatabase(process.env);
    const folder = mkdtempSync(join(tmpdir(), 'forgekit-oidc-'));
    const keyPath = join(folder, 'tls.key');
    const certPath = join(folder, 'tls.crt');
    const database = new DatabaseService();
    const projects = new ProjectsService(database);
    const runId = randomUUID();
    const slug = `oidc-${runId}`;
    let projectId: string | null = null;
    let https: HttpsServer | null = null;
    let api: ChildProcess | null = null;
    let ownerIssuer: string | null = null;
    try {
      // Ephemeral TLS certificate; private keys never enter the repository.
      execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
        '-keyout', keyPath, '-out', certPath, '-subj', '/CN=127.0.0.1', '-addext', 'subjectAltName=IP:127.0.0.1'], { stdio: 'ignore' });
      const key = readFileSync(keyPath);
      const cert = readFileSync(certPath);
      const signingKey = createPrivateKey(key);
      const jwk = createPublicKey(signingKey).export({ format: 'jwk' });
      const jwks = JSON.stringify({ keys: [{ ...jwk, kid: 'forgekit-e2e', alg: 'RS256', use: 'sig' }] });
      https = createHttpsServer({ key, cert }, (request, response) => {
        if (request.url !== '/jwks') { response.writeHead(404).end(); return; }
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(jwks);
      });
      https.listen(0, '127.0.0.1');
      await once(https, 'listening');
      const address = https.address();
      if (!address || typeof address === 'string') throw new Error('无法获取测试 JWKS 端口。');
      const issuer = `https://127.0.0.1:${address.port}/issuer`;
      ownerIssuer = issuer;
      const owner = { mode: 'oidc' as const, issuer, subject: `${runId}-owner` };
      const viewer = { mode: 'oidc' as const, issuer, subject: `${runId}-viewer` };
      const project = await projects.create({ name: slug, template: 'vue-web', features: [] }, owner);
      projectId = project.id;

      const port = await freePort();
      const base = `http://127.0.0.1:${port}`;
      api = spawn(process.execPath, [resolve(process.cwd(), 'dist/main.js')], {
        cwd: process.cwd(), stdio: 'ignore',
        env: { ...process.env, NODE_ENV: 'test', AUTH_MODE: 'oidc', API_HOST: '127.0.0.1', PORT: String(port),
          OIDC_ISSUER: issuer, OIDC_API_AUDIENCE: 'forgekit-api', OIDC_JWKS_URL: `https://127.0.0.1:${address.port}/jwks`,
          NODE_EXTRA_CA_CERTS: certPath },
      });
      await waitForApi(base, api);

      const ownerToken = jwt(signingKey, issuer, owner.subject);
      const viewerToken = jwt(signingKey, issuer, viewer.subject);
      const headers = (token: string) => ({ Authorization: `Bearer ${token}` });
      const get = (path: string, token?: string) => fetch(`${base}${path}`, token ? { headers: headers(token) } : {});
      expect((await get('/api/v1/auth/whoami')).status).toBe(401);
      const whoami = await get('/api/v1/auth/whoami', ownerToken);
      expect(whoami.status).toBe(200);
      expect(await whoami.json()).toEqual({ issuer, subject: owner.subject });
      expect((await get('/api/v1/auth/whoami', jwt(signingKey, issuer, owner.subject, 'wrong-api'))).status).toBe(401);
      expect((await get('/api/v1/auth/whoami', jwt(signingKey, issuer, owner.subject, 'forgekit-api', -60))).status).toBe(401);
      expect((await get('/api/v1/auth/whoami', jwt(createPrivateKey(generateOtherKey()), issuer, owner.subject))).status).toBe(401);

      // Enrollment needs a valid bearer token and grants no project membership.
      expect((await fetch(`${base}/api/v1/auth/account`, { method: 'POST' })).status).toBe(401);
      const enroll = () => fetch(`${base}/api/v1/auth/account`, { method: 'POST', headers: headers(viewerToken) });
      const enrolled = await enroll();
      expect(enrolled.status).toBe(201);
      const account = await enrolled.json() as { id: string };
      expect(account.id).toBeTruthy();
      expect(enrolled.headers.get('content-type')).toContain('application/json');
      expect((await (await enroll()).json() as { id: string }).id).toBe(account.id);

      const ownerProjects = await get('/api/v1/projects', ownerToken);
      expect(ownerProjects.status).toBe(200);
      expect((await ownerProjects.json() as Array<{ slug: string }>).some((entry) => entry.slug === slug)).toBe(true);
      expect((await get(`/api/v1/projects/${slug}`, viewerToken)).status).toBe(404);

      const invite = await fetch(`${base}/api/v1/projects/${slug}/invitations`, {
        method: 'POST', headers: { ...headers(ownerToken), 'Content-Type': 'application/json' }, body: JSON.stringify({ role: 'viewer' }),
      });
      expect(invite.status).toBe(201);
      const invitation = await invite.json() as { code: string };
      const redeem = await fetch(`${base}/api/v1/invitations/redeem`, {
        method: 'POST', headers: { ...headers(viewerToken), 'Content-Type': 'application/json' }, body: JSON.stringify({ code: invitation.code }),
      });
      expect(redeem.status).toBe(201);
      expect((await get(`/api/v1/projects/${slug}`, viewerToken)).status).toBe(200);
      const deny = await fetch(`${base}/api/v1/projects/${slug}/invitations`, {
        method: 'POST', headers: { ...headers(viewerToken), 'Content-Type': 'application/json' }, body: JSON.stringify({ role: 'editor' }),
      });
      expect(deny.status).toBe(403);
    } finally {
      try {
        if (api && api.exitCode === null && api.signalCode === null) {
          api.kill('SIGTERM');
          await Promise.race([once(api, 'exit'), new Promise((done) => setTimeout(done, 2000))]);
          if (api.exitCode === null && api.signalCode === null) api.kill('SIGKILL');
        }
        if (https) await new Promise<void>((done) => https!.close(() => done()));
        if (projectId) await database.db.delete(projectTable).where(eq(projectTable.id, projectId));
        if (ownerIssuer) {
          for (const name of ['owner', 'viewer']) {
            const id = await projects.findUserId({ mode: 'oidc', issuer: ownerIssuer, subject: `${runId}-${name}` });
            if (id) await database.db.delete(users).where(eq(users.id, id));
          }
        }
      } finally {
        await database.onModuleDestroy();
        rmSync(folder, { recursive: true, force: true });
      }
    }
  }, 40_000);
});

function generateOtherKey(): string {
  // A fresh unrelated signing key makes an otherwise well-formed forged token.
  return generateKeyPairSync('rsa', { modulusLength: 2048, publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' } }).privateKey;
}
