import 'reflect-metadata';
import { randomBytes, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
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
import { EnvironmentVariableRepository, encryptVariable, BuildRepository, DeployRepository, createDatabaseClient, requireDisposableTestDatabase, deployTargets, deployLogChunks,
  deployAudit, domains, runtimeLogChunks, RuntimeLogRepository, projects, users, externalIdentities, projectMemberships, invitationRateBuckets } from '@forgekit/db';
import type { Deployment, DeployTarget, RuntimeLogSession } from '@forgekit/contracts';
import { DeploysController } from '../src/deploys.controller';
import { DeploysService } from '../src/deploys.service';
import { DeployQueueService } from '../src/deploy-queue.service';
import { DeployStreamTickets } from '../src/deploy-stream-tickets';
import { DeployStreamsController } from '../src/deploy-streams.controller';
import { DeployStreamsService } from '../src/deploy-streams.service';
import { DatabaseService } from '../src/database.service';
import { ProjectsService } from '../src/projects.service';
import { IdentityAccountsService } from '../src/identity-accounts.service';
import { InvitationRateLimiter, invitationBucketKey } from '../src/invitation-rate-limiter';
import { ProjectApiGuard } from '../src/project-api.guard';
import { AuthService } from '../src/auth.service';
import { RuntimeLogsController } from '../src/runtime-logs.controller';
import { RuntimeLogsService } from '../src/runtime-logs.service';
import { RuntimeLogQueueService } from '../src/runtime-log-queue.service';
import { RuntimeStreamTickets } from '../src/runtime-stream-tickets';
import { RuntimeStreamsController } from '../src/runtime-streams.controller';
import { RuntimeStreamsService } from '../src/runtime-streams.service';
import { startRuntimeLogWorker } from '../../worker/src/runtime-log-worker';
import { startDeployWorker } from '../../worker/src/deploy-worker';
import { resolveWorkerConfig } from '../../worker/src/config';

const docker = (...args: string[]) => execFileSync('docker', args, { encoding: 'utf8', timeout: 20000, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
describe.skipIf(process.env.FORGEKIT_SSH_DEPLOY_INTEGRATION !== '1')('B12 API + MySQL + Redis + Docker sshd', () => {
  it('encrypts targets, queues static deploys, streams logs, rolls back and enforces retention and pins', async () => {
    const client = createDatabaseClient(requireDisposableTestDatabase(process.env));
    const work = await mkdtemp(join(tmpdir(), 'forgekit-b12-e2e-'));
    const container = 'forgekit-b12-' + randomUUID();
    const projectId = randomUUID(), ownerId = randomUUID(), editorId = randomUUID(), viewerId = randomUUID();
    const issuer = `https://b12-${projectId}.example`;
    vi.stubEnv('AUTH_MODE', 'oidc'); vi.stubEnv('NODE_ENV', 'test'); vi.stubEnv('OIDC_ISSUER', issuer);
    vi.stubEnv('OIDC_API_AUDIENCE', 'forgekit-api'); vi.stubEnv('OIDC_JWKS_URL', issuer + '/jwks');
    vi.stubEnv('FORGEKIT_DEPLOY_ENCRYPTION_KEY', randomBytes(32).toString('hex'));
    vi.stubEnv('FORGEKIT_ARTIFACT_DIR', join(work, 'artifacts'));
    const builds = new BuildRepository(client.db), repository = new DeployRepository(client.db);
    let app: INestApplication | undefined, worker: Awaited<ReturnType<typeof startDeployWorker>> | undefined;
    let runtimeWorker: Awaited<ReturnType<typeof startRuntimeLogWorker>> | undefined;
    const events: Record<string, unknown>[] = [];
    @Module({ controllers: [RuntimeLogsController, RuntimeStreamsController, DeploysController, DeployStreamsController], providers: [RuntimeLogsService, RuntimeLogQueueService, RuntimeStreamTickets, RuntimeStreamsService, DeploysService, DeployQueueService, DeployStreamTickets, DeployStreamsService,
      ProjectsService, IdentityAccountsService, InvitationRateLimiter, ProjectApiGuard,
      { provide: DatabaseService, useValue: { db: client.db } },
      { provide: AuthService, useValue: { authenticate: async (header?: string) => {
        const subject = header?.replace('Bearer ', '');
        if (![ownerId, editorId, viewerId].includes(subject ?? '')) throw new UnauthorizedException();
        return { issuer, subject: subject! };
      } } },
    ] }) class TestApp {}
    try {
      await migrate(client.db, { migrationsFolder: resolve(process.cwd(), '../../packages/db/drizzle') });
      for (const [id, role] of [[ownerId, 'owner'], [editorId, 'editor'], [viewerId, 'viewer']] as const) {
        await client.db.insert(users).values({ id, displayName: 'B12 test' });
        await client.db.insert(externalIdentities).values({ userId: id, issuer, subject: id });
        if (role === 'owner') await client.db.insert(projects).values({ id: projectId, slug: 'b12-' + projectId, name: 'B12', features: [] });
        await client.db.insert(projectMemberships).values({ projectId, userId: id, role });
      }
      const keyPath = join(work, 'identity');
      execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', keyPath]);
      const privateKey = await readFile(keyPath, 'utf8');
      docker('run', '-d', '--name', container, '-p', '127.0.0.1::22', process.env.FORGEKIT_SSH_TEST_IMAGE ?? 'forgekit-sshd-test:b12');
      docker('cp', keyPath + '.pub', container + ':/tmp/key.pub');
      docker('exec', container, 'install', '-o', 'deploy', '-g', 'deploy', '-m', '600', '/tmp/key.pub', '/home/deploy/.ssh/authorized_keys');
      let hostKey = '';
      for (let attempt = 0; attempt < 40; attempt++) {
        try { hostKey = docker('exec', container, 'cat', '/etc/ssh/ssh_host_ed25519_key.pub').split(' ').slice(0, 2).join(' '); break; }
        catch { await delay(250); }
      }
      if (!hostKey) throw new Error('fake_sshd_not_ready');
      const bindings = JSON.parse(docker('inspect', '--format', '{{json .NetworkSettings.Ports}}', container)) as Record<string, Array<{ HostPort: string }>>;
      const port = Number(bindings['22/tcp']![0]!.HostPort);
      app = await NestFactory.create(TestApp, { logger: false }); await app.listen(0, '127.0.0.1');
      const base = `${await app.getUrl()}/api/v1/projects/${projectId}`;
      const request = (path: string, method = 'GET', body?: unknown, actor = ownerId) => fetch(base + path, { method,
        headers: { authorization: 'Bearer ' + actor, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      const input = { name: '本地 sshd', host: '127.0.0.1', port, username: 'deploy', hostKey, basePath: '/srv/forgekit', retention: 2, privateKey };
      expect((await request('/deploy-targets', 'POST', input, viewerId)).status).toBe(403);
      const response = await request('/deploy-targets', 'POST', input, editorId); expect(response.status).toBe(201);
      const target = await response.json() as DeployTarget;
      expect(JSON.stringify(target)).not.toContain('PRIVATE KEY');
      const [stored] = await client.db.select().from(deployTargets).where(eq(deployTargets.id, target.id));
      expect(stored!.encryptedPrivateKey?.startsWith('v1.')).toBe(true);
      expect(stored!.encryptedPrivateKey).not.toContain(privateKey);
      const { privateKey: _key, ...metadata } = input;
      expect((await request('/deploy-targets/' + target.id, 'PATCH', { ...metadata, name: '更新名称' })).status).toBe(200);
      expect((await repository.target(projectId, target.id))!.encryptedPrivateKey).toBe(stored!.encryptedPrivateKey);
      const source = join(work, 'source'); await mkdir(join(source, 'assets'), { recursive: true });
      const store = new LocalFsArtifactStore(join(work, 'artifacts'));
      async function successfulBuild(text: string) {
        const build = await builds.create({ projectId, triggeredBy: ownerId, template: 'vue-web', sourceRef: 'template:vue-web' });
        await writeFile(join(source, 'index.html'), '<html>' + text + '</html>');
        await writeFile(join(source, 'assets/app.js'), 'window.fixture=true');
        const artifact = await store.put(build.id, source, new AbortController().signal);
        await builds.updateStatus(build.id, 'queued', 'running');
        await builds.updateStatus(build.id, 'running', 'succeeded', { artifactKey: artifact.key, artifactSha256: artifact.sha256, artifactSize: artifact.size, exitCode: 0 });
        return build;
      }
      const build1 = await successfulBuild('release one');
      expect((await request('/deployments', 'POST', { buildId: build1.id, deployTargetId: target.id }, viewerId)).status).toBe(403);
      const firstResponse = await request('/deployments', 'POST', { buildId: build1.id, deployTargetId: target.id }); expect(firstResponse.status).toBe(201);
      const first = await firstResponse.json() as Deployment;
      expect((await request('/deployments', 'POST', { buildId: build1.id, deployTargetId: target.id })).status).toBe(409);
      expect((await request('/deploy-targets/' + target.id, 'DELETE')).status).toBe(409);
      const b14Secret = 'b14-ssh-fixture-secret';
      const b14Variable = await new EnvironmentVariableRepository(client.db).save(projectId, 'production', 'APP_TOKEN', { kind: 'secret', value: b14Secret }, ownerId,
        (value, eid) => encryptVariable(value, Buffer.from(process.env.FORGEKIT_DEPLOY_ENCRYPTION_KEY!, 'hex'), projectId, eid, 'APP_TOKEN'));
      worker = await startDeployWorker(client, resolveWorkerConfig(process.env), process.env, event => { events.push(event); });
      async function finish(id: string, expected = 'succeeded') {
        for (let attempt = 0; attempt < 200; attempt++) {
          const row = await repository.get(id);
          if (row && !['pending', 'running'].includes(row.status)) { expect(row.errorMessage).toBeNull(); expect(row.status).toBe(expected); return row; }
          await delay(100);
        }
        throw new Error('deploy_did_not_finish');
      }
      await finish(first.id);
      const remoteRoot = `/srv/forgekit/forgekit-${projectId}-${target.id}`;
      const readCurrent = () => docker('exec', container, 'cat', remoteRoot + '/current/index.html');
      expect(docker('exec', container, 'readlink', remoteRoot + '/current')).toBe('releases/' + first.releaseId);
      expect(readCurrent()).toContain('release one');
      const envPath = remoteRoot + '/environments/' + first.releaseId + '/.env';
      expect(docker('exec', container, 'stat', '-c', '%a', envPath)).toBe('600');
      expect(docker('exec', container, 'cat', envPath)).toBe("APP_TOKEN='" + b14Secret + "'");
      expect(docker('exec', container, 'ls', '-a', remoteRoot + '/current')).not.toContain('.forgekit-env');
      expect(docker('exec', container, 'cat', remoteRoot + '/current/assets/app.js')).toBe('window.fixture=true');
      const ticketResponse = await request(`/deployments/${first.id}/log-stream-ticket`, 'POST', undefined, viewerId);
      const ticket = await ticketResponse.json() as { ticket: string };
      const stream = await fetch(`${base}/deployments/${first.id}/logs/stream?ticket=${ticket.ticket}`, { signal: AbortSignal.timeout(5000) });
      const streamed = await stream.text(); expect(streamed).toContain('event: log'); expect(streamed).toContain('event: end');
      expect(streamed).not.toContain(privateKey); expect(streamed).not.toContain(b14Secret);
      expect((await fetch(`${base}/deployments/${first.id}/logs/stream?ticket=${ticket.ticket}`)).status).toBe(401);
      // B15: seed deterministic per-site Caddy files on the disposable SSH host (no systemd required).
      const domainId = randomUUID();
      await client.db.insert(domains).values({ id: domainId, projectId, deployTargetId: target.id, hostname: `site-${domainId}.b15.test`,
        claimedHostname: `site-${domainId}.b15.test`, verificationToken: 'a'.repeat(64), status: 'active', verifiedAt: new Date(), tlsMode: 'internal' });
      const logDir = `/srv/forgekit/.forgekit-caddy/logs/${domainId}`;
      const seed = (file: string, text: string, append = false) => docker('exec', '-u', 'deploy', container, 'python3', '-c',
        'import pathlib,sys; p=pathlib.Path(sys.argv[1]); p.parent.mkdir(parents=True,exist_ok=True); f=p.open(sys.argv[3]); f.write(sys.argv[2]); f.close()',
        logDir + '/' + file + '.jsonl', text, append ? 'a' : 'w');
      seed('access', JSON.stringify({ ts: Date.now() / 1000, level: 'info', msg: 'recent ' + b14Secret + ' ' + b14Variable.encryptedValue }) + '\n');
      seed('error', JSON.stringify({ ts: Date.now() / 1000, level: 'error', msg: 'request failed' }) + '\n');
      runtimeWorker = await startRuntimeLogWorker(client, resolveWorkerConfig(process.env), process.env, event => { events.push(event); });
      const runtimeInput = { domainId, source: 'caddy-access', lines: 200 };
      expect((await request('/runtime-log-sessions', 'POST', { ...runtimeInput, source: '../../etc/passwd' }, viewerId)).status).toBe(400);
      expect((await request('/runtime-log-sessions', 'POST', { ...runtimeInput, path: '/etc/passwd' }, viewerId)).status).toBe(400);
      const runtimeResponse = await request('/runtime-log-sessions', 'POST', runtimeInput, viewerId); expect(runtimeResponse.status).toBe(201);
      const runtime = await runtimeResponse.json() as RuntimeLogSession;
      const runtimeTicket = await (await request(`/runtime-log-sessions/${runtime.id}/log-stream-ticket`, 'POST', undefined, viewerId)).json() as { ticket: string };
      const runtimeStream = await fetch(`${base}/runtime-log-sessions/${runtime.id}/logs/stream?ticket=${runtimeTicket.ticket}`, { signal: AbortSignal.timeout(15000) });
      expect(runtimeStream.status).toBe(200);
      const reader = runtimeStream.body!.getReader(), decoder = new TextDecoder();
      let runtimeText = '';
      async function until(marker: string) {
        while (!runtimeText.includes(marker)) {
          const part = await reader.read(); if (part.done) throw new Error('runtime_stream_ended_early');
          runtimeText += decoder.decode(part.value, { stream: true });
        }
      }
      await until('recent [REDACTED]');
      seed('access', JSON.stringify({ ts: Date.now() / 1000, level: 'info', msg: 'live-follow ' + b14Secret }) + '\n', true);
      await until('live-follow [REDACTED]');
      expect(runtimeText).toContain('event: log'); expect(runtimeText).not.toContain(b14Secret); expect(runtimeText).not.toContain(privateKey);
      expect(runtimeText).not.toContain(process.env.FORGEKIT_DEPLOY_ENCRYPTION_KEY!);
      expect(runtimeText).not.toContain(b14Variable.encryptedValue!);
      expect((await request(`/runtime-log-sessions/${runtime.id}`, 'DELETE', undefined, viewerId)).status).toBe(204);
      await until('event: end'); await reader.cancel();
      const runtimeRows = await client.db.select().from(runtimeLogChunks).where(eq(runtimeLogChunks.sessionId, runtime.id));
      expect(JSON.stringify(runtimeRows)).toContain('[REDACTED]'); expect(JSON.stringify(runtimeRows)).not.toContain(b14Secret); expect(JSON.stringify(runtimeRows)).not.toContain(b14Variable.encryptedValue!);
      expect((await new RuntimeLogRepository(client.db).get(runtime.id))?.status).toBe('canceled');
      expect(JSON.stringify(events)).not.toContain(b14Secret);
      await runtimeWorker.close(); runtimeWorker = undefined;
      await client.db.delete(domains).where(eq(domains.id, domainId));
      const build2 = await successfulBuild('release two');
      const second = await (await request('/deployments', 'POST', { buildId: build2.id, deployTargetId: target.id })).json() as Deployment;
      await finish(second.id); expect(readCurrent()).toContain('release two');
      expect((await request(`/deployments/${first.id}/rollback`, 'POST', undefined, viewerId)).status).toBe(403);
      const rolled = await (await request(`/deployments/${first.id}/rollback`, 'POST', undefined, editorId)).json() as Deployment;
      await finish(rolled.id, 'rolled_back'); expect(readCurrent()).toContain('release one');
      expect((await repository.get(rolled.id))!.rollbackOf).toBe(first.id);
      const third = await (await request('/deployments', 'POST', { buildId: build2.id, deployTargetId: target.id })).json() as Deployment;
      await finish(third.id);
      expect(docker('exec', container, 'ls', '-1', remoteRoot + '/releases').split('\n').sort()).toEqual([third.releaseId, second.releaseId].sort());
      expect((await request(`/deployments/${first.id}/rollback`, 'POST')).status).toBe(409);
      // A different valid public key must fail before any release writes/symlink change.
      const wrongPin = (await readFile(keyPath + '.pub', 'utf8')).trim().split(' ').slice(0, 2).join(' ');
      expect((await request('/deploy-targets/' + target.id, 'PATCH', { ...metadata, hostKey: wrongPin })).status).toBe(200);
      const failed = await (await request('/deployments', 'POST', { buildId: build1.id, deployTargetId: target.id })).json() as Deployment;
      let failedRow;
      for (let attempt = 0; attempt < 150; attempt++) { failedRow = await repository.get(failed.id); if (failedRow?.status === 'failed') break; await delay(100); }
      expect(failedRow).toMatchObject({ status: 'failed', errorMessage: 'ssh_host_key_mismatch' });
      expect(docker('exec', container, 'readlink', remoteRoot + '/current')).toBe('releases/' + third.releaseId);
      const logs = await client.db.select().from(deployLogChunks).where(eq(deployLogChunks.deploymentId, failed.id));
      expect(logs.map(row => row.seq)).toEqual(logs.map((_, index) => index + 1));
      expect(JSON.stringify(logs)).not.toContain(privateKey); expect(JSON.stringify(events)).not.toContain(privateKey);
      const audits = await client.db.select().from(deployAudit).where(eq(deployAudit.projectId, projectId));
      expect(audits.some(row => row.action === 'rollback' && row.deploymentId === rolled.id)).toBe(true);
      expect((await request('/deploy-targets/' + target.id, 'DELETE')).status).toBe(204);
      expect((await repository.target(projectId, target.id))!.encryptedPrivateKey).toBeNull();
      expect((await repository.list(projectId)).length).toBeGreaterThan(0);
    } finally {
      try {
        await runtimeWorker?.close(); await worker?.close(); await app?.close();
        try { docker('rm', '-f', container); } catch { /* Startup may have failed before container creation. */ }
        await client.db.delete(projects).where(eq(projects.id, projectId));
        await client.db.delete(users).where(inArray(users.id, [ownerId, editorId, viewerId]));
        await client.db.delete(invitationRateBuckets).where(inArray(invitationRateBuckets.key,
          [ownerId, editorId, viewerId].flatMap(id => ['deploy-write', 'runtime-start', 'runtime-poll'].map(type => invitationBucketKey(type as 'deploy-write' | 'runtime-start' | 'runtime-poll', issuer, id)))));
      } finally { await client.close(); await rm(work, { recursive: true, force: true }); vi.unstubAllEnvs(); }
    }
  }, 120000);
});
