import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import type { ServerResponse } from 'node:http';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ForbiddenException, HttpException, Module, NotFoundException, UnauthorizedException, type INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { BuildLogRepository } from '@forgekit/db';
import type { Build } from '@forgekit/contracts';
import { BuildStreamsController, streamCursor } from '../src/build-streams.controller';
import { BuildStreamsService } from '../src/build-streams.service';
import { BuildStreamTickets, type StreamIdentity } from '../src/build-stream-tickets';
import { BuildsService } from '../src/builds.service';
import { ProjectApiGuard } from '../src/project-api.guard';
import { AuthService } from '../src/auth.service';
import { DatabaseService } from '../src/database.service';
import { CappedBuildLogs, redactBuildLog } from '../../worker/src/build-logs';
import { RepositoryLogSink } from '../../worker/src/runner';

const redis = vi.hoisted(() => ({ data: new Map<string, { value: string; expires: number }>() }));
vi.mock('ioredis', () => ({ Redis: class {
  status = 'wait'; on() {} disconnect() {} async connect() { this.status = 'ready'; }
  async set(key: string, value: string, _px: string, ttl: number) { redis.data.set(key, { value, expires: Date.now() + ttl }); }
  async getdel(key: string) { const row = redis.data.get(key); redis.data.delete(key); return row && row.expires > Date.now() ? row.value : null; }
} }));
const projectId = randomUUID(), buildId = randomUUID();
const now = new Date();
const terminal: Build = { id: buildId, projectId, triggeredBy: randomUUID(), number: 1, template: 'vue-web', sourceRef: 'template:vue-web', status: 'succeeded', queuedAt: now.toISOString(), startedAt: now.toISOString(), finishedAt: now.toISOString(), createdAt: now.toISOString(), updatedAt: now.toISOString(), exitCode: 0, errorMessage: null, artifactKey: null, artifactSize: null, artifactSha256: null, logStorageKey: null, runnerInfo: null, diagnosis: null };
const get = vi.fn(async (_pid: string, _bid: string, _auth: StreamIdentity['auth']): Promise<Build> => terminal);
const logs = vi.spyOn(BuildLogRepository.prototype, 'listSince');
const high = vi.spyOn(BuildLogRepository.prototype, 'highestSeq');
const auth = { mode: 'oidc' as const, issuer: 'https://issuer.example', subject: 'viewer' };
const identity = (): StreamIdentity => ({ projectId, buildId, auth, expires: Date.now() + 60_000 });
@Module({ controllers: [BuildStreamsController], providers: [BuildStreamsService, BuildStreamTickets, ProjectApiGuard,
  { provide: BuildsService, useValue: { get } }, { provide: DatabaseService, useValue: { db: {} } },
  { provide: AuthService, useValue: { authenticate: async (header?: string) => {
    if (!header?.startsWith('Bearer ')) throw new UnauthorizedException();
    return { issuer: auth.issuer, subject: header.slice(7) };
  } } },
] }) class TestApp {}
let app: INestApplication, base: string;
beforeAll(async () => {
  vi.stubEnv('AUTH_MODE', 'oidc'); vi.stubEnv('NODE_ENV', 'test'); vi.stubEnv('REDIS_URL', 'redis://127.0.0.1:6379/15');
  vi.stubEnv('OIDC_ISSUER', auth.issuer); vi.stubEnv('OIDC_API_AUDIENCE', 'forgekit-api'); vi.stubEnv('OIDC_JWKS_URL', `${auth.issuer}/jwks`);
  app = await NestFactory.create(TestApp, { logger: false }); await app.listen(0, '127.0.0.1');
  base = `${await app.getUrl()}/api/v1/projects/${projectId}/builds/${buildId}`;
});
afterAll(async () => { await app?.close(); vi.restoreAllMocks(); vi.unstubAllEnvs(); });
beforeEach(() => {
  vi.useRealTimers(); redis.data.clear(); vi.clearAllMocks();
  get.mockImplementation(async (pid, bid, context) => {
    if (pid !== projectId || bid !== buildId || (context.mode === 'oidc' && context.subject === 'outsider')) throw new NotFoundException();
    return terminal;
  });
  logs.mockImplementation(async (_id, seq = 0) => [1, 2, 3].filter(n => n > seq).map(seq => ({ buildId, seq, stream: 'stdout', content: `行${seq}\n`, ts: now })));
  high.mockResolvedValue(3);
});
async function ticket(role = 'viewer') {
  const response = await fetch(`${base}/log-stream-ticket`, { method: 'POST', headers: { authorization: `Bearer ${role}` } });
  expect(response.status).toBe(201); expect(response.headers.get('cache-control')).toBe('no-store');
  return (await response.json() as { ticket: string }).ticket;
}
describe('SSE HTTP endpoint', () => {
  it('B14 redacts stdout/stderr before persistence and actual HTTP SSE replay', async () => {
    const secret = 'b14-build-stream-fixture-secret';
    const stored: Awaited<ReturnType<BuildLogRepository['listSince']>> = [];
    const append = vi.fn(async (input: Parameters<BuildLogRepository['append']>[0]) => {
      expect(input.content).not.toContain(secret);
      const row = { ...input, seq: stored.length + 1, ts: now }; stored.push(row); return row;
    });
    const sink = new RepositoryLogSink(buildId, { append }, new AbortController().signal);
    const capped = new CappedBuildLogs(sink, 10000, value => redactBuildLog(value, [secret]));
    async function* output() { yield Buffer.from(secret.slice(0, 9)); yield Buffer.from(secret.slice(9) + '\n'); }
    await capped.consume('stdout', output()); await capped.consume('stderr', output());
    logs.mockImplementation(async (_id, seq = 0) => stored.filter(row => row.seq > seq)); high.mockResolvedValue(stored.length);
    const response = await fetch(`${base}/logs/stream?ticket=${await ticket()}`);
    const streamed = await response.text();
    expect(streamed).toContain('[REDACTED]'); expect(streamed).toContain('event: end'); expect(streamed).not.toContain(secret);
    expect(JSON.stringify([...redis.data.values()])).not.toContain(secret);
  });
  it('ticket needs Bearer; stream needs a one-time bound ticket, never a Bearer query token', async () => {
    expect((await fetch(`${base}/log-stream-ticket`, { method: 'POST' })).status).toBe(401);
    expect((await fetch(`${base}/logs/stream?access_token=secret`)).status).toBe(401);
    const value = await ticket();
    expect(redis.data.keys().next().value).not.toContain(value);
    const response = await fetch(`${base}/logs/stream?ticket=${value}`);
    expect(response.status).toBe(200); expect(response.headers.get('content-type')).toContain('text/event-stream');
    expect(response.headers.get('x-accel-buffering')).toBe('no');
    const text = await response.text(); expect(text).not.toContain(value); expect(text).not.toContain('secret');
    expect(text).toContain('event: end'); expect(text).toContain('"lastSeq":3');
    expect((await fetch(`${base}/logs/stream?ticket=${value}`)).status).toBe(401);
  });
  it('reauthorizes membership, rejects cross-build tickets and hides outsiders', async () => {
    expect((await fetch(`${base}/log-stream-ticket`, { method: 'POST', headers: { authorization: 'Bearer outsider' } })).status).toBe(404);
    const value = await ticket(); get.mockRejectedValueOnce(new NotFoundException());
    expect((await fetch(`${base}/logs/stream?ticket=${value}`)).status).toBe(404);
    const other = await ticket(); expect((await fetch(`${base.replace(buildId, randomUUID())}/logs/stream?ticket=${other}`)).status).toBe(401);
  });
  it('Last-Event-ID precedes after and only log events have ids; terminal replay closes', async () => {
    const value = await ticket();
    const response = await fetch(`${base}/logs/stream?ticket=${value}&after=0`, { headers: { 'Last-Event-ID': '2' } });
    const text = await response.text(); expect(text).toContain('id: 3\n'); expect(text).not.toContain('id: 1\n');
    const frames = text.trim().split('\n\n');
    expect(frames.filter(f => f.includes('\nid:'))).toHaveLength(1);
    expect(frames.at(-1)).toContain('event: end'); expect(frames.at(-2)).toContain('event: status');
    const log = frames.find(f => f.startsWith('event: log'))!;
    expect(log).not.toContain('buildId'); expect(log).toContain('\\n');
  });

  it('returns explicit forbidden/unavailable handshake errors without leaking low-level details', async () => {
    const forbidden = await ticket(); get.mockRejectedValueOnce(new ForbiddenException());
    expect((await fetch(`${base}/logs/stream?ticket=${forbidden}`)).status).toBe(403);
    const unavailable = await ticket(); get.mockRejectedValueOnce(new Error('database_password=secret'));
    const response = await fetch(`${base}/logs/stream?ticket=${unavailable}`);
    expect(response.status).toBe(503); expect(await response.text()).not.toContain('secret');
  });
  it('ends an empty terminal snapshot at zero and accepts the after query', async () => {
    high.mockResolvedValue(0); logs.mockResolvedValue([]);
    const response = await fetch(`${base}/logs/stream?ticket=${await ticket()}&after=0`);
    const text = await response.text(); expect(text).not.toContain('event: log'); expect(text).toContain('"lastSeq":0');
  });
  it('redacts request credential metadata before rejecting a handshake', async () => {
    const controller = app.get(BuildStreamsController);
    const req = { headers: {}, url: '/logs/stream?%74icket=private&ticket=private&after=0', originalUrl: '/logs/stream?ticket=private' };
    await expect(controller.stream(projectId, buildId, { ticket: 'private' }, req as Parameters<BuildStreamsController['stream']>[3], new Response().node)).rejects.toMatchObject({ status: 401 });
    expect(req.url).toBe('/logs/stream'); expect(req.originalUrl).not.toContain('private');
  });
  it('local mode permits read streaming without tickets and forbids ticket issuance', async () => {
    vi.stubEnv('AUTH_MODE', 'local');
    const local = await NestFactory.create(TestApp, { logger: false });
    try {
      await local.listen(0, '127.0.0.1');
      const url = `${await local.getUrl()}/api/v1/projects/${projectId}/builds/${buildId}`;
      const response = await fetch(`${url}/logs/stream?after=2`);
      expect(response.status).toBe(200); const text = await response.text();
      expect(text).toContain('id: 3'); expect(text).not.toContain('id: 2');
      expect((await fetch(`${url}/log-stream-ticket`, { method: 'POST' })).status).toBe(403);
    } finally { await local.close(); vi.stubEnv('AUTH_MODE', 'oidc'); }
  });
  it('validates decimal uint32 cursors before streaming, including header precedence', async () => {
    for (const input of ['-1', '1.1', '1e2', '4294967296', '', '1&after=2']) {
      expect((await fetch(`${base}/logs/stream?after=${input}`)).status).toBe(400);
    }
    expect((await fetch(`${base}/logs/stream?after=1`, { headers: { 'Last-Event-ID': 'bad' } })).status).toBe(400);
    expect(streamCursor('2', 'bad')).toBe(2); expect(streamCursor(undefined, undefined)).toBe(0);
  });
});
class Response extends EventEmitter {
  headersSent = false; destroyed = false; writableNeedDrain = false;
  frames: string[] = []; block = false;
  writeHead() { this.headersSent = true; } flushHeaders() {}
  write(frame: string) { this.frames.push(frame); this.writableNeedDrain = this.block; return !this.block; }
  end() { this.emit('close'); } destroy() { this.destroyed = true; this.emit('close'); return this; }
  get node() { return this as unknown as ServerResponse; }
}
describe('bounded SSE pump', () => {
  it('replays more than 500 chunks and excludes post-terminal append from captured H', async () => {
    high.mockResolvedValue(601);
    logs.mockImplementation(async (_id, seq = 0, limit = 500) => Array.from({ length: 602 }, (_, i) => i + 1).filter(n => n > seq).slice(0, limit).map(seq => ({ buildId, seq, stream: 'system', content: 'x', ts: now })));
    const response = new Response(); await app.get(BuildStreamsService).open(identity(), 0, response.node);
    expect(response.frames.filter(f => f.startsWith('event: log'))).toHaveLength(601);
    expect(response.frames.at(-1)).toContain('"lastSeq":601'); expect(high).toHaveBeenCalledOnce();
    expect(response.listenerCount('close')).toBe(0);
  });
  it('joins persisted replay to live DB writes and finishes after terminal status', async () => {
    vi.useFakeTimers(); get.mockResolvedValue({ ...terminal, status: 'running', finishedAt: null });
    const response = new Response(); const work = app.get(BuildStreamsService).open(identity(), 0, response.node);
    await vi.advanceTimersByTimeAsync(0); expect(response.frames.join('')).toContain('id: 3');
    get.mockResolvedValue(terminal); high.mockResolvedValue(4);
    logs.mockImplementation(async (_id, seq = 0) => seq < 4 ? [{ buildId, seq: 4, stream: 'stderr', content: 'last', ts: now }] : []);
    await vi.advanceTimersByTimeAsync(500); await work;
    expect(response.frames.join('')).toContain('id: 4'); expect(response.frames.at(-1)).toContain('"lastSeq":4');
  });
  it('pauses DB delivery on backpressure and cleans up on disconnect', async () => {
    vi.useFakeTimers(); const response = new Response(); response.block = true;
    const work = app.get(BuildStreamsService).open(identity(), 0, response.node);
    await vi.advanceTimersByTimeAsync(0); expect(logs).not.toHaveBeenCalled(); expect(response.frames).toHaveLength(1);
    response.destroy(); await work;
    expect(response.listenerCount('drain')).toBe(0); expect(vi.getTimerCount()).toBe(0);
  });
  it('destroys readers stalled for five seconds', async () => {
    vi.useFakeTimers(); const response = new Response(); response.block = true;
    const work = app.get(BuildStreamsService).open(identity(), 0, response.node);
    await vi.advanceTimersByTimeAsync(5000); await work;
    expect(response.destroyed).toBe(true); expect(logs).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
  });
  it('resumes delivery after a drain without buffering further frames', async () => {
    vi.useFakeTimers(); const response = new Response(); response.block = true;
    const work = app.get(BuildStreamsService).open(identity(), 0, response.node);
    await vi.advanceTimersByTimeAsync(0); expect(response.frames).toHaveLength(1);
    response.block = false; response.writableNeedDrain = false; response.emit('drain'); await work;
    expect(response.frames.at(-1)).toContain('event: end'); expect(response.listenerCount('drain')).toBe(0);
  });
  it('heartbeats without ids, expires connections and rechecks revoked access', async () => {
    vi.useFakeTimers(); get.mockResolvedValue({ ...terminal, status: 'running', finishedAt: null }); logs.mockResolvedValue([]);
    const response = new Response(); const work = app.get(BuildStreamsService).open({ ...identity(), expires: Date.now() + 16_000 }, 0, response.node);
    await vi.advanceTimersByTimeAsync(16_000); await work;
    expect(response.frames).toContain(': heartbeat\n\n'); expect(response.frames.at(-1)).toContain('ticket_expired');
    const denied = new Response(); const pending = app.get(BuildStreamsService).open(identity(), 0, denied.node);
    await vi.advanceTimersByTimeAsync(0); get.mockRejectedValue(new NotFoundException());
    await vi.advanceTimersByTimeAsync(500); await pending; expect(denied.frames.at(-1)).toContain('access_revoked');
  });
  it('limits identity connections and releases slots after disconnect', async () => {
    vi.useFakeTimers(); get.mockResolvedValue({ ...terminal, status: 'running', finishedAt: null }); logs.mockResolvedValue([]);
    const responses = Array.from({ length: 4 }, () => new Response());
    const service = app.get(BuildStreamsService); const pending = responses.map(r => service.open(identity(), 0, r.node));
    await vi.advanceTimersByTimeAsync(0);
    await expect(service.open(identity(), 0, new Response().node)).rejects.toMatchObject({ status: 429 });
    responses.forEach(r => r.destroy()); await Promise.all(pending);
    get.mockResolvedValue(terminal); high.mockResolvedValue(0); await service.open(identity(), 0, new Response().node);
  });
});
describe('shared single-use ticket adapter', () => {
  it('reports missing Redis as a fixed 503 without exposing a token', async () => {
    vi.stubEnv('REDIS_URL', ''); const service = new BuildStreamTickets();
    try { await expect(service.issue(projectId, buildId, auth)).rejects.toMatchObject({ status: 503 }); }
    finally { service.onModuleDestroy(); vi.stubEnv('REDIS_URL', 'redis://127.0.0.1:6379/15'); }
  });
  it('consumes atomically across service instances, rejects expired and local issuance', async () => {
    vi.useFakeTimers(); const a = new BuildStreamTickets(), b = new BuildStreamTickets();
    const value = await a.issue(projectId, buildId, auth);
    const results = await Promise.allSettled([a.take(value.ticket, projectId, buildId), b.take(value.ticket, projectId, buildId)]);
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    const expired = await a.issue(projectId, buildId, auth); await vi.advanceTimersByTimeAsync(60_001);
    await expect(b.take(expired.ticket, projectId, buildId)).rejects.toBeInstanceOf(UnauthorizedException);
    await expect(a.issue(projectId, buildId, { mode: 'local' })).rejects.toBeInstanceOf(ForbiddenException);
    a.onModuleDestroy(); b.onModuleDestroy();
  });
});
