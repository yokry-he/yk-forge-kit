import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DomainClaimError, type DomainRow, type DomainOperationRow, type DeployTargetRow } from '@forgekit/db';
import { DomainProcessor } from '../src/domain-processor';
import { DomainError } from '../src/domain-dns';
import { SshDeployError } from '../src/ssh-command';
const now = new Date(), domainId = randomUUID(), projectId = randomUUID(), targetId = randomUUID();
const domain: DomainRow = { id: domainId, projectId, deployTargetId: targetId, hostname: 'site.example', verificationToken: 'token', claimedHostname: null,
  status: 'pending_dns', tlsMode: 'internal', verifiedAt: null, lastCheckedAt: null, certificateExpiresAt: null, certificateFingerprint: null, errorCode: null, createdAt: now, updatedAt: now };
const op: DomainOperationRow = { id: randomUUID(), projectId, deployTargetId: targetId, domainId, actorUserId: randomUUID(), action: 'verify', status: 'pending',
  errorCode: null, finishedAt: null, createdAt: now, updatedAt: now };
const target: DeployTargetRow = { id: targetId, projectId, kind: 'ssh', name: 'host', host: '192.0.2.10', port: 22, username: 'deploy', basePath: '/srv/forgekit',
  hostKey: 'ssh-ed25519 AAAA', encryptedPrivateKey: 'secret', currentReleaseId: randomUUID(), disabledAt: null, retention: 5, createdBy: op.actorUserId, createdAt: now, updatedAt: now };
const repo = { operation: vi.fn(), get: vi.fn(), start: vi.fn(), claim: vi.fn(), update: vi.fn(), finish: vi.fn() };
const targets = { target: vi.fn() }, logs = { append: vi.fn() }, dns = { verify: vi.fn() }, host = { run: vi.fn() };
let processor: DomainProcessor;
beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(new Date('2026-11-20T00:00:00Z'));
  vi.resetAllMocks(); repo.operation.mockResolvedValue(op); repo.get.mockResolvedValue(domain); repo.start.mockResolvedValue(true); targets.target.mockResolvedValue(target);
  dns.verify.mockResolvedValue(true); host.run.mockResolvedValue({ expiresAt: new Date(Date.now() + 86400000), fingerprint: 'a'.repeat(64) });
  processor = new DomainProcessor(repo, targets, logs, dns, host);
});
afterEach(() => { vi.useRealTimers(); });
const run = () => processor.process({ operationId: op.id }, op.id);
describe('B13 domain lifecycle', () => {
  it('does no SSH or claim until DNS routing and TXT ownership both succeed', async () => {
    dns.verify.mockResolvedValue(false); await run();
    expect(repo.claim).not.toHaveBeenCalled(); expect(host.run).not.toHaveBeenCalled();
    expect(repo.finish).toHaveBeenCalledWith(op.id, 'failed', expect.objectContaining({ status: 'pending_dns', errorCode: 'domain_dns_pending' }), 'domain_dns_pending');
  });
  it('claims before issuing and persists logs before terminal status', async () => {
    await run();
    expect(repo.claim.mock.invocationCallOrder[0]).toBeLessThan(host.run.mock.invocationCallOrder[0]!);
    expect(logs.append.mock.invocationCallOrder.at(-1)).toBeLessThan(repo.finish.mock.invocationCallOrder[0]!);
    expect(repo.finish).toHaveBeenCalledWith(op.id, 'succeeded', expect.objectContaining({ status: 'active', certificateFingerprint: 'a'.repeat(64) }));
  });
  it('never overwrites another tenant claim and never logs raw errors or keys', async () => {
    repo.claim.mockRejectedValue(new DomainClaimError()); await run();
    expect(host.run).not.toHaveBeenCalled();
    expect(repo.finish).toHaveBeenCalledWith(op.id, 'failed', expect.objectContaining({ errorCode: 'domain_already_claimed' }), 'domain_already_claimed');
    repo.claim.mockResolvedValue(undefined); host.run.mockRejectedValue(new Error('PRIVATE KEY super-secret')); await run();
    expect(JSON.stringify(logs.append.mock.calls)).not.toContain('PRIVATE KEY');
    expect(JSON.stringify(logs.append.mock.calls)).not.toContain('super-secret');
  });
  it('keeps an existing active route status on reapply failure and records the error', async () => {
    repo.get.mockResolvedValue({ ...domain, status: 'active', verifiedAt: now });
    host.run.mockRejectedValue(new DomainError('domain_config_invalid')); await run();
    expect(repo.finish).toHaveBeenCalledWith(op.id, 'failed', expect.objectContaining({ status: 'active', errorCode: 'domain_config_invalid' }), 'domain_config_invalid');
  });
  it.each(['domain_certificate_invalid', 'domain_health_failed'])('marks a failed refresh unavailable while retaining the claim and certificate: %s', async code => {
    const previous: DomainRow = { ...domain, status: 'active', verifiedAt: now, claimedHostname: domain.hostname,
      certificateExpiresAt: new Date('2026-12-20T00:00:00Z'), certificateFingerprint: 'c'.repeat(64) };
    repo.operation.mockResolvedValue({ ...op, action: 'refresh' }); repo.get.mockResolvedValue(previous);
    host.run.mockRejectedValue(new DomainError(code));
    repo.finish.mockImplementation(async (_id, _status, values: Partial<DomainRow>) => Object.assign(previous, values));
    await run();
    expect(repo.finish).toHaveBeenCalledWith(op.id, 'failed', { status: 'failed', errorCode: code, lastCheckedAt: new Date() }, code);
    expect(previous).toMatchObject({ status: 'failed', claimedHostname: domain.hostname,
      certificateExpiresAt: new Date('2026-12-20T00:00:00Z'), certificateFingerprint: 'c'.repeat(64) });
    expect(dns.verify).not.toHaveBeenCalled(); expect(repo.claim).not.toHaveBeenCalled();
  });
  it.each(['ssh_command_failed', 'timeout', 'shutdown'])('recovers a failed observation on the next refresh: %s', async failure => {
    const stored: DomainRow = { ...domain, status: 'active', verifiedAt: now, claimedHostname: domain.hostname,
      certificateExpiresAt: new Date('2026-12-20T00:00:00Z'), certificateFingerprint: 'c'.repeat(64) };
    repo.operation.mockResolvedValue({ ...op, action: 'refresh' }); repo.get.mockResolvedValue(stored);
    repo.finish.mockImplementation(async (_id, _status, values: Partial<DomainRow>) => Object.assign(stored, values));
    if (failure === 'ssh_command_failed') host.run.mockRejectedValueOnce(new SshDeployError(failure));
    else host.run.mockImplementationOnce(async (_domain, _op, _target, signal: AbortSignal) => {
      if (failure === 'shutdown') processor.shutdown();
      else await vi.advanceTimersByTimeAsync(270000);
      signal.throwIfAborted();
    });
    await run();
    expect(stored.status).toBe('failed'); expect(stored.claimedHostname).toBe(domain.hostname);
    expect(stored.certificateFingerprint).toBe('c'.repeat(64));
    processor = new DomainProcessor(repo, targets, logs, dns, host);
    host.run.mockResolvedValue({ expiresAt: new Date('2026-12-21T00:00:00Z'), fingerprint: 'a'.repeat(64) });
    vi.setSystemTime(new Date('2026-11-21T00:00:01Z')); await run();
    expect(stored).toMatchObject({ status: 'active', certificateFingerprint: 'a'.repeat(64), errorCode: null });
  });
  it('refreshes expiry/fingerprint without reissuing and shows expired certificates', async () => {
    repo.operation.mockResolvedValue({ ...op, action: 'refresh' }); repo.get.mockResolvedValue({ ...domain, status: 'active', verifiedAt: now });
    const expiresAt = new Date('2000-01-01T00:00:00.000Z');
    host.run.mockResolvedValue({ expiresAt, fingerprint: 'b'.repeat(64) }); await run();
    expect(dns.verify).not.toHaveBeenCalled(); expect(repo.claim).not.toHaveBeenCalled();
    expect(repo.finish).toHaveBeenCalledWith(op.id, 'succeeded', expect.objectContaining({ status: 'expired', certificateExpiresAt: expiresAt, certificateFingerprint: 'b'.repeat(64) }));
  });
  it('does not release the domain on remove failure, and revokes only after safe remote removal', async () => {
    repo.operation.mockResolvedValue({ ...op, action: 'remove' }); repo.get.mockResolvedValue({ ...domain, verifiedAt: now }); host.run.mockRejectedValueOnce(new Error('secret')); await run();
    expect(repo.finish).not.toHaveBeenCalledWith(op.id, 'succeeded', expect.objectContaining({ status: 'revoked' }));
    host.run.mockResolvedValue(null); await run();
    expect(repo.finish).toHaveBeenLastCalledWith(op.id, 'succeeded', expect.objectContaining({ status: 'revoked' }));
  });
  it('ignores duplicate running/terminal deliveries and competing starts', async () => {
    repo.operation.mockResolvedValueOnce({ ...op, status: 'running' }); await run();
    repo.operation.mockResolvedValueOnce({ ...op, status: 'succeeded' }); await run();
    repo.start.mockResolvedValueOnce(false); await run(); expect(host.run).not.toHaveBeenCalled();
    await expect(processor.process({ operationId: op.id }, randomUUID())).rejects.toThrow('domain_job_id_invalid');
  });
});
