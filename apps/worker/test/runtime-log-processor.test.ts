import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { RuntimeLogInputSchema } from '@forgekit/contracts';
import type { RuntimeLogRow, DeployTargetRow, DomainRow } from '@forgekit/db';
import { RuntimeLogProcessor, runtimeLineMatches } from '../src/runtime-log-processor';
import { SshDeployError } from '../src/ssh-command';
const id = randomUUID(), now = new Date();
const input = RuntimeLogInputSchema.parse({ domainId: id, source: 'caddy-access' });
function fixture() {
  const row: RuntimeLogRow = { id, projectId: id, domainId: id, deployTargetId: id, actorUserId: id, hostHash: 'a'.repeat(64),
    input, status: 'running', bytes: 0, lastSeq: 0, leaseOwner: null, leaseUntil: new Date(Date.now() + 5000),
    createdAt: now, expiresAt: new Date(Date.now() + 60000), errorCode: null };
  const target = { id, projectId: id, currentReleaseId: id, disabledAt: null, encryptedPrivateKey: 'v1.cipher.fixture' } as DeployTargetRow;
  const domain = { id, projectId: id, deployTargetId: id, status: 'active', claimedHostname: 'site.example' } as DomainRow;
  const sessions = { start: vi.fn().mockResolvedValue(true), get: vi.fn().mockResolvedValue(row), append: vi.fn().mockResolvedValue(undefined), finish: vi.fn().mockResolvedValue(undefined) };
  const host = { read: vi.fn() };
  const processor = new RuntimeLogProcessor(sessions, { target: vi.fn().mockResolvedValue(target) }, { get: vi.fn().mockResolvedValue(domain) }, host,
    async () => ({ values: {}, secrets: ['private-fixture-secret'] }));
  return { row, sessions, host, processor };
}
describe('runtime filters', () => {
  it('filters JSON levels, numeric/ISO timestamps and literal keywords without regex evaluation', () => {
    const filter = { ...input, level: 'error' as const, windowMinutes: 5 as const, keyword: 'a.*$(id)' };
    const line = (ts: unknown, level = 'ERROR', msg = filter.keyword) => JSON.stringify({ ts, level, msg });
    expect(runtimeLineMatches(line(Date.now() / 1000), filter, now)).toBe(true);
    expect(runtimeLineMatches(line(now.toISOString()), filter, now)).toBe(true);
    for (const value of [line(Date.now() / 1000 - 600), line('invalid'), line(Date.now() / 1000, 'info'), line(Date.now() / 1000, 'ERROR', 'abc'), 'null', 'not json']) {
      expect(runtimeLineMatches(value, filter, now)).toBe(false);
    }
    expect(runtimeLineMatches('plain log\n', input, now)).toBe(true);
  });
});
describe('bounded trusted worker session', () => {
  it.each([{ level: 'info' }, { windowMinutes: 5 }, { level: 'info', windowMinutes: 5 }])('preserves matching JSON access logs after redaction with %j', async filter => {
    const f = fixture();
    f.row.input = RuntimeLogInputSchema.parse({ ...input, ...filter, keyword: '[REDACTED]' });
    f.host.read.mockImplementation(async (_target, _input, _secrets, line: (v: string) => Promise<void>) => {
      await line(JSON.stringify({ level: 'info', ts: now.getTime() / 1000, request: { uri: '/?token=clearly-fake-test-secret' } }) + '\n');
    });
    await f.processor.process({ sessionId: id }, id);
    const content = f.sessions.append.mock.calls.map(call => call[1] as string).join('');
    expect(content).not.toContain('clearly-fake-test-secret');
    expect(JSON.parse(content)).toEqual({ level: 'info', ts: now.getTime() / 1000, request: { uri: '/?token=[REDACTED]' } });
    expect(f.sessions.finish).toHaveBeenCalledWith(id, 'ended');
  });
  it('reuses B14 redaction before filters, chunk persistence and public streams', async () => {
    const f = fixture();
    f.host.read.mockImplementation(async (_target, _input, _secrets, line: (v: string) => Promise<void>) => {
      await line('private-fixture-secret v1.cipher.fixture token=hidden-value\n');
      await line('中文'.repeat(8000) + '\n');
    });
    await f.processor.process({ sessionId: id }, id);
    const content = f.sessions.append.mock.calls.map(call => call[1] as string).join('');
    expect(content).toContain('[REDACTED]'); expect(content).not.toContain('private-fixture-secret'); expect(content).not.toContain('v1.cipher.fixture'); expect(content).not.toContain('hidden-value');
    expect(f.sessions.append.mock.calls.every(call => Buffer.byteLength(call[1] as string) <= 16384)).toBe(true);
    expect(f.sessions.finish).toHaveBeenCalledWith(id, 'ended');
  });
  it('bounds the persisted buffer and hides raw remote exceptions', async () => {
    const f = fixture();
    f.host.read.mockImplementation(async (_target, _input, _secrets, line: (v: string) => Promise<void>) => {
      for (let i = 0; i < 1100; i++) await line('x'.repeat(1024) + '\n');
    });
    await f.processor.process({ sessionId: id }, id);
    expect(f.sessions.append.mock.calls.reduce((n, c) => n + Buffer.byteLength(c[1] as string), 0)).toBeLessThanOrEqual(1048576);
    expect(f.sessions.finish).toHaveBeenCalledWith(id, 'failed', 'runtime_read_failed');
    f.host.read.mockRejectedValueOnce(new Error('password=private-fixture-secret'));
    await f.processor.process({ sessionId: id }, id);
    expect(JSON.stringify(f.sessions.finish.mock.calls)).not.toContain('private-fixture-secret');
  });
  it('does not repeat claimed jobs; preserves fixed host-key failure codes', async () => {
    const f = fixture(); f.sessions.start.mockResolvedValueOnce(false);
    await f.processor.process({ sessionId: id }, id); expect(f.host.read).not.toHaveBeenCalled();
    f.host.read.mockRejectedValueOnce(new SshDeployError('ssh_host_key_mismatch'));
    await f.processor.process({ sessionId: id }, id);
    expect(f.sessions.finish).toHaveBeenCalledWith(id, 'failed', 'ssh_host_key_mismatch');
    await expect(f.processor.process({ sessionId: id, command: 'id' }, id)).rejects.toThrow();
  });
  it.each(['deadline', 'shutdown'] as const)('aborts the SSH read on %s without leaving timers', async reason => {
    vi.useFakeTimers();
    const f = fixture();
    f.row.expiresAt = new Date(Date.now() + 1000);
    f.host.read.mockImplementation(async (_target, _input, _secrets, _line, signal: AbortSignal) => new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true })));
    try {
      const task = f.processor.process({ sessionId: id }, id);
      await vi.advanceTimersByTimeAsync(0);
      if (reason === 'shutdown') f.processor.shutdown();
      else await vi.advanceTimersByTimeAsync(1000);
      await task; expect(vi.getTimerCount()).toBe(0);
      expect(f.sessions.finish).toHaveBeenCalledWith(id, 'ended');
    } finally { vi.useRealTimers(); }
  });
  it('aborts a remote reader after lease loss and cleans monitoring timers on shutdown', async () => {
    vi.useFakeTimers();
    const f = fixture();
    f.host.read.mockImplementation(async (_target, _input, _secrets, _line, signal: AbortSignal) => new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true })));
    const task = f.processor.process({ sessionId: id }, id);
    await vi.advanceTimersByTimeAsync(0);
    f.sessions.get.mockResolvedValue({ ...f.row, leaseUntil: new Date(Date.now() - 1000) });
    await vi.advanceTimersByTimeAsync(500); await task;
    expect(vi.getTimerCount()).toBe(0);
    vi.useRealTimers();
  });
});
