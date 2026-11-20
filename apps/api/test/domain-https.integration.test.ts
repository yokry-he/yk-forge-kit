import 'reflect-metadata';
import { randomBytes, randomUUID } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { describe, expect, it, vi } from 'vitest';
import { Module, UnauthorizedException, type INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { migrate } from 'drizzle-orm/mysql2/migrator';
import { eq, inArray } from 'drizzle-orm';
import { LocalFsArtifactStore } from '@forgekit/artifact-store';
import { BuildRepository, DeployRepository, DomainRepository, createDatabaseClient, requireDisposableTestDatabase,
  domains, projects, users, externalIdentities, projectMemberships, invitationRateBuckets, domainLogChunks } from '@forgekit/db';
import type { Deployment, DeployTarget, Domain, DomainOperation } from '@forgekit/contracts';
import { DeploysController } from '../src/deploys.controller';
import { DeploysService } from '../src/deploys.service';
import { DeployQueueService } from '../src/deploy-queue.service';
import { DomainsController } from '../src/domains.controller';
import { DomainsService } from '../src/domains.service';
import { DomainQueueService } from '../src/domain-queue.service';
import { DomainStreamTickets } from '../src/domain-stream-tickets';
import { DomainStreamsController } from '../src/domain-streams.controller';
import { DomainStreamsService } from '../src/domain-streams.service';
import { DatabaseService } from '../src/database.service';
import { ProjectsService } from '../src/projects.service';
import { IdentityAccountsService } from '../src/identity-accounts.service';
import { InvitationRateLimiter, invitationBucketKey } from '../src/invitation-rate-limiter';
import { ProjectApiGuard } from '../src/project-api.guard';
import { AuthService } from '../src/auth.service';
import { startDeployWorker } from '../../worker/src/deploy-worker';
import { startDomainWorker } from '../../worker/src/domain-worker';
import { resolveWorkerConfig } from '../../worker/src/config';
import { startDomainDnsFixture } from './domain-dns-fixture';
const docker = (...args: string[]) => execFileSync('docker', args, { encoding: 'utf8', timeout: 20000, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
describe.skipIf(process.env.FORGEKIT_DOMAIN_HTTPS_INTEGRATION !== '1')('B13 API + MySQL + Redis + Docker sshd/Caddy + local DNS', () => {
  it('verifies ownership, issues offline certificates, streams logs, refreshes renewals, rolls back failures and removes safely', async () => {
    const client = createDatabaseClient(requireDisposableTestDatabase(process.env));
    const work = await mkdtemp(join(tmpdir(), 'forgekit-b13-e2e-')), container = 'forgekit-b13-' + randomUUID();
    const projectId = randomUUID(), ownerId = randomUUID(), editorId = randomUUID(), viewerId = randomUUID();
    const issuer = `https://b13-${projectId}.example`;
    vi.stubEnv('AUTH_MODE', 'oidc'); vi.stubEnv('NODE_ENV', 'test'); vi.stubEnv('OIDC_ISSUER', issuer); vi.stubEnv('OIDC_API_AUDIENCE', 'forgekit-api');
    vi.stubEnv('OIDC_JWKS_URL', issuer + '/jwks'); vi.stubEnv('FORGEKIT_DEPLOY_ENCRYPTION_KEY', randomBytes(32).toString('hex'));
    vi.stubEnv('FORGEKIT_ARTIFACT_DIR', join(work, 'artifacts')); vi.stubEnv('FORGEKIT_DOMAIN_TLS_MODE', 'internal');
    let dns: Awaited<ReturnType<typeof startDomainDnsFixture>> | undefined;
    const deployRepo = new DeployRepository(client.db), domainRepo = new DomainRepository(client.db), builds = new BuildRepository(client.db);
    let app: INestApplication | undefined, deployWorker: Awaited<ReturnType<typeof startDeployWorker>> | undefined,
      domainWorker: Awaited<ReturnType<typeof startDomainWorker>> | undefined;
    let containerStarted = false;
    const events: Record<string, unknown>[] = [];
    @Module({ controllers: [DeploysController, DomainsController, DomainStreamsController], providers: [DeploysService, DeployQueueService,
      DomainsService, DomainQueueService, DomainStreamTickets, DomainStreamsService, ProjectsService, IdentityAccountsService, InvitationRateLimiter, ProjectApiGuard,
      { provide: DatabaseService, useValue: { db: client.db } }, { provide: AuthService, useValue: { authenticate: async (header?: string) => {
        const subject = header?.replace('Bearer ', '');
        if (![ownerId, editorId, viewerId].includes(subject ?? '')) throw new UnauthorizedException();
        return { issuer, subject: subject! };
      } } },
    ] }) class TestApp {}
    try {
      dns = await startDomainDnsFixture();
      await migrate(client.db, { migrationsFolder: resolve(process.cwd(), '../../packages/db/drizzle') });
      for (const [id, role] of [[ownerId, 'owner'], [editorId, 'editor'], [viewerId, 'viewer']] as const) {
        await client.db.insert(users).values({ id, displayName: 'B13 test' });
        await client.db.insert(externalIdentities).values({ userId: id, issuer, subject: id });
        if (role === 'owner') await client.db.insert(projects).values({ id: projectId, slug: 'b13-' + projectId, name: 'B13', features: [] });
        await client.db.insert(projectMemberships).values({ projectId, userId: id, role });
      }
      const keyPath = join(work, 'identity'); execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', keyPath]);
      const privateKey = await readFile(keyPath, 'utf8');
      docker('run', '-d', '--name', container, '--sysctl', 'net.ipv4.ip_unprivileged_port_start=0', '-p', '127.0.0.1::22', '-p', '127.0.0.1::443',
        process.env.FORGEKIT_HTTPS_TEST_IMAGE ?? 'forgekit-https-test:b13');
      containerStarted = true;
      docker('cp', keyPath + '.pub', container + ':/tmp/key.pub');
      docker('exec', container, 'install', '-o', 'deploy', '-g', 'deploy', '-m', '600', '/tmp/key.pub', '/home/deploy/.ssh/authorized_keys');
      let hostKey = '';
      for (let i = 0; i < 80; i++) {
        try { hostKey = docker('exec', container, 'cat', '/etc/ssh/ssh_host_ed25519_key.pub').split(' ').slice(0, 2).join(' ');
          docker('exec', container, 'test', '-S', '/srv/forgekit/.forgekit-caddy/admin.sock'); break;
        } catch { hostKey = ''; await delay(100); }
      }
      if (!hostKey) throw new Error('https_sshd_not_ready');
      const bindings = JSON.parse(docker('inspect', '--format', '{{json .NetworkSettings.Ports}}', container)) as Record<string, Array<{ HostPort: string }>>;
      const port = Number(bindings['22/tcp']![0]!.HostPort), httpsPort = bindings['443/tcp']![0]!.HostPort;
      app = await NestFactory.create(TestApp, { logger: false }); await app.listen(0, '127.0.0.1');
      const base = `${await app.getUrl()}/api/v1/projects/${projectId}`;
      const request = (path: string, method = 'GET', body?: unknown, actor = ownerId) => fetch(base + path, { method,
        headers: { authorization: 'Bearer ' + actor, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(5000) });
      const targetResponse = await request('/deploy-targets', 'POST', { name: '本地 HTTPS 主机', host: '127.0.0.1', port, username: 'deploy', hostKey,
        basePath: '/srv/forgekit', retention: 2, privateKey });
      expect(targetResponse.status).toBe(201); const target = await targetResponse.json() as DeployTarget;
      const source = join(work, 'source'); await mkdir(source); await writeFile(join(source, 'index.html'), '<html>B13 real HTTPS</html>');
      const build = await builds.create({ projectId, triggeredBy: ownerId, template: 'vue-web', sourceRef: 'template:vue-web' });
      const artifact = await new LocalFsArtifactStore(join(work, 'artifacts')).put(build.id, source, new AbortController().signal);
      await builds.updateStatus(build.id, 'queued', 'running');
      await builds.updateStatus(build.id, 'running', 'succeeded', { artifactKey: artifact.key, artifactSha256: artifact.sha256, artifactSize: artifact.size, exitCode: 0 });
      const deployment = await (await request('/deployments', 'POST', { buildId: build.id, deployTargetId: target.id })).json() as Deployment;
      deployWorker = await startDeployWorker(client, resolveWorkerConfig(process.env), process.env, event => events.push(event));
      for (let i = 0; i < 200; i++) { const row = await deployRepo.get(deployment.id); if (row?.status === 'succeeded') break; if (row?.status === 'failed') throw new Error(row.errorMessage ?? 'deploy_failed'); await delay(100); }
      expect((await deployRepo.get(deployment.id))?.status).toBe('succeeded');
      const hostname = 'site.b13.test';
      const input = { hostname, deployTargetId: target.id };
      expect((await request('/domains', 'POST', input, viewerId)).status).toBe(403);
      expect((await request('/domains', 'POST', { ...input, hostname: 'site.b13.test\r\nBad: yes' })).status).toBe(400);
      const response = await request('/domains', 'POST', input, editorId); expect(response.status).toBe(201);
      const domain = await response.json() as Domain;
      expect(domain.tlsMode).toBe('internal'); expect(domain.status).toBe('pending_dns');
      const opResponse = await request(`/domains/${domain.id}/verify`, 'POST'); expect(opResponse.status).toBe(201);
      const pending = await opResponse.json() as DomainOperation;
      expect((await request('/deploy-targets/' + target.id, 'DELETE')).status).toBe(409);
      expect((await request('/deployments', 'POST', { buildId: build.id, deployTargetId: target.id })).status).toBe(409);
      domainWorker = await startDomainWorker(client, resolveWorkerConfig(process.env), process.env, event => events.push(event), dns.verifier);
      async function finish(id: string, expected = 'succeeded', errorCode: string | null = null) {
        for (let i = 0; i < 300; i++) {
          const row = await domainRepo.operation(id);
          if (row && !['pending', 'running'].includes(row.status)) { expect(row.errorCode).toBe(errorCode); expect(row.status).toBe(expected); return row; }
          await delay(100);
        }
        throw new Error('domain_operation_timeout');
      }
      const invoke = async (action: 'verify' | 'refresh' | 'remove', id = domain.id) => {
        const response = await request(`/domains/${id}` + (action === 'remove' ? '' : '/' + action), action === 'remove' ? 'DELETE' : 'POST');
        expect(response.status).toBe(action === 'remove' ? 200 : 201); return await response.json() as DomainOperation;
      };
      await finish(pending.id, 'failed', 'domain_dns_pending');
      expect((await domainRepo.get(domain.id))?.claimedHostname).toBeNull();
      dns.records.set(hostname, { address: '127.0.0.1' });
      dns.records.set(domain.verificationName, { txt: 'forgekit-domain=wrong-tenant' });
      await finish((await invoke('verify')).id, 'failed', 'domain_dns_pending');
      dns.records.set(domain.verificationName, { txt: domain.verificationValue });
      const verified = await invoke('verify'); await finish(verified.id);
      const active = (await domainRepo.get(domain.id))!;
      expect(active.status).toBe('active'); expect(active.certificateExpiresAt!.getTime()).toBeGreaterThan(Date.now()); expect(active.certificateFingerprint).toMatch(/^[a-f0-9]{64}$/);
      // Client trusts only this fixture's CA, while SNI and hostname checks remain enabled.
      // docker cp preserves 0600 and uses the CLI user's ownership. A sudo-backed
      // Docker CLI would create a root-owned CA file that this process cannot read.
      // Export only the public certificate and create the local file as the test user.
      await writeFile(join(work, 'root.crt'), docker('exec', container, 'cat',
        '/srv/forgekit/.forgekit-caddy/data/pki/authorities/local/root.crt') + '\n', { mode: 0o600 });
      const fetchSite = () => {
        try {
          return execFileSync('curl', ['--disable', '--fail', '--silent', '--show-error', '--verbose', '--noproxy', '*',
            '--connect-timeout', '2', '--max-time', '5', '--cacert', join(work, 'root.crt'),
            '--resolve', `${hostname}:${httpsPort}:127.0.0.1`, `https://${hostname}:${httpsPort}/`],
          { encoding: 'utf8', timeout: 10000, stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 65536 });
        } catch (error) {
          const failure = error as { status?: number; signal?: string; stderr?: string };
          throw new Error(`HTTPS curl failed (exit=${failure.status}, signal=${failure.signal ?? 'none'}):\n${failure.stderr ?? ''}`);
        }
      };
      expect(fetchSite()).toContain('B13 real HTTPS');
      const configBefore = docker('exec', container, 'cat', '/srv/forgekit/.forgekit-caddy/caddy.json');
      await finish((await invoke('verify')).id); expect((await domainRepo.get(domain.id))?.certificateFingerprint).toBe(active.certificateFingerprint);
      const ticketResponse = await request(`/domain-operations/${verified.id}/log-stream-ticket`, 'POST', undefined, viewerId);
      const ticket = await ticketResponse.json() as { ticket: string };
      const stream = await fetch(`${base}/domain-operations/${verified.id}/logs/stream?ticket=${ticket.ticket}&after=1`, { signal: AbortSignal.timeout(5000) });
      const streamed = await stream.text(); expect(streamed).toContain('event: log'); expect(streamed).toContain('event: end'); expect(streamed).not.toContain('id: 1\n');
      expect((await fetch(`${base}/domain-operations/${verified.id}/logs/stream?ticket=${ticket.ticket}`)).status).toBe(401);
      // Refresh must replace stale persisted observations with the actual served certificate.
      // Keep the expired seed within MySQL TIMESTAMP's strict-mode range.
      await client.db.update(domains).set({ certificateExpiresAt: new Date('2000-01-01T00:00:00.000Z'), certificateFingerprint: '0'.repeat(64), lastCheckedAt: new Date() }).where(eq(domains.id, domain.id));
      await finish((await invoke('refresh')).id);
      const refreshed = (await domainRepo.get(domain.id))!;
      expect(refreshed.status).toBe('active');
      expect(refreshed.certificateExpiresAt).toEqual(active.certificateExpiresAt);
      expect(refreshed.certificateFingerprint).toBe(active.certificateFingerprint);
      // A missing current index fails before cutover; the previous config is retained byte-for-byte.
      const siteRoot = `/srv/forgekit/forgekit-${projectId}-${target.id}/current`;
      docker('exec', container, 'mv', siteRoot + '/index.html', siteRoot + '/saved.html');
      await finish((await invoke('verify')).id, 'failed', 'domain_release_missing');
      expect(docker('exec', container, 'cat', '/srv/forgekit/.forgekit-caddy/caddy.json')).toBe(configBefore);
      docker('exec', container, 'mv', siteRoot + '/saved.html', siteRoot + '/index.html'); expect(fetchSite()).toContain('B13 real HTTPS');
      expect((await request(`/domains/${domain.id}`, 'DELETE', undefined, viewerId)).status).toBe(403);
      expect((await request('/deploy-targets/' + target.id, 'DELETE')).status).toBe(409);
      await finish((await invoke('remove')).id);
      expect((await domainRepo.get(domain.id))?.status).toBe('revoked'); expect((await domainRepo.get(domain.id))?.claimedHostname).toBeNull();
      expect(docker('exec', container, 'cat', '/srv/forgekit/.forgekit-caddy/state.json')).not.toContain(hostname);
      expect((await request('/deploy-targets/' + target.id, 'DELETE')).status).toBe(204);
      const logs = await client.db.select().from(domainLogChunks).where(eq(domainLogChunks.operationId, verified.id));
      expect(logs.map(row => row.seq)).toEqual(logs.map((_, index) => index + 1));
      expect(JSON.stringify(logs)).not.toContain(privateKey); expect(streamed).not.toContain(privateKey); expect(JSON.stringify(events)).not.toContain(privateKey);
    } catch (error) {
      // Inspect only fixture state/ports and bounded server logs; never dump env,
      // SSH private keys, Caddy storage or database records into failure output.
      for (const args of [
        ['inspect', '--format', '{{json .State}} {{json .NetworkSettings.Ports}}', container],
        ['logs', '--tail', '80', container],
      ]) {
        const result = spawnSync('docker', args, { encoding: 'utf8', timeout: 5000,
          stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 65536 });
        console.error(`B13 fixture ${args[0]} (exit=${result.status}):`, result.stdout, result.stderr);
      }
      throw error;
    } finally {
      try {
        const closed = await Promise.allSettled([domainWorker?.close(), deployWorker?.close(), app?.close(), dns?.close()]);
        let removalError: unknown;
        try { docker('rm', '-f', container); }
        catch (error) { if (containerStarted) removalError = error; }
        try { await client.db.delete(projects).where(eq(projects.id, projectId)); }
        finally {
          try { await client.db.delete(users).where(inArray(users.id, [ownerId, editorId, viewerId])); }
          finally { await client.db.delete(invitationRateBuckets).where(inArray(invitationRateBuckets.key, [ownerId, editorId, viewerId].map(id => invitationBucketKey('deploy-write', issuer, id)))); }
        }
        const failure = closed.find(result => result.status === 'rejected');
        if (failure?.status === 'rejected') throw failure.reason;
        if (removalError) throw removalError;
      } finally {
        try { await client.close(); }
        finally {
          try { await rm(work, { recursive: true, force: true }); }
          finally { vi.unstubAllEnvs(); }
        }
      }
    }
  }, 120000);
});
