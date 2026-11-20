import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { DatabaseClient } from '../src/index';
import { DeployConflictError, DeployRepository, type DeploymentRow, type DeployTargetRow } from '../src/deploy-repository';
import { deployAudit, deployments } from '../src/schema';

// Scripted SQL snapshots exercise the real repository without requiring a MySQL server.
function database(responses: unknown[][]) {
  const values = vi.fn().mockResolvedValue(undefined);
  const tx = {
    select: vi.fn(() => {
      const rows = responses.shift();
      if (!rows) throw new Error('unexpected_select');
      return Object.assign(Promise.resolve(rows), {
        from() { return this; }, where() { return this; }, for() { return this; }, limit() { return this; },
      });
    }),
    insert: vi.fn((_table: unknown) => ({ values })),
  };
  const transaction = vi.fn(async (work: (transaction: typeof tx) => Promise<unknown>) => work(tx));
  const repository = new DeployRepository({ transaction } as unknown as DatabaseClient['db']);
  return { repository, transaction, tx, values, responses };
}

const id = randomUUID(), releaseA = randomUUID(), now = new Date();
const target: DeployTargetRow = { id, projectId: id, kind: 'ssh', name: 'site', host: 'example.com', port: 22,
  username: 'deploy', hostKey: 'ssh-ed25519 AAAA', basePath: '/srv/site', retention: 5,
  currentReleaseId: releaseA, encryptedPrivateKey: 'test-only-ciphertext', disabledAt: null,
  createdBy: id, createdAt: now, updatedAt: now };
const original: DeploymentRow = { id: randomUUID(), projectId: id, buildId: id, deployTargetId: id, environmentId: id,
  status: 'succeeded', action: 'deploy', releaseId: releaseA, rollbackOf: null, triggeredBy: id, retained: true,
  errorMessage: null, startedAt: now, finishedAt: now, createdAt: now, updatedAt: now };
const input = { projectId: id, buildId: id, deployTargetId: id, actor: id, rollbackOf: original.id };
function rollbackSnapshots(previous = original, active: unknown[] = []) {
  return [[{ id }], [target], active,
    [{ id, projectId: id, status: 'succeeded', artifactKey: 'artifact', artifactSha256: 'a'.repeat(64) }],
    [previous], [{ id, projectId: id, name: 'production', createdAt: now, updatedAt: now }]];
}

describe('B12 repository recovery and locking', () => {
  it('accepts a retained SQL-current release when remote state may differ after a failed deployment', async () => {
    // A is retained and SQL-current. B has switched remotely, then failed before SQL
    // success was persisted, so there is no active job and SQL still reports A.
    const { repository, tx, values, responses } = database(rollbackSnapshots());
    const recovery = await repository.create(input);
    expect(recovery).toMatchObject({ status: 'pending', action: 'rollback', releaseId: releaseA, rollbackOf: original.id });
    expect(tx.insert.mock.calls.map(([table]) => table)).toEqual([deployments, deployAudit]);
    expect(values).toHaveBeenLastCalledWith(expect.objectContaining({ deploymentId: recovery.id, action: 'rollback' }));
    expect(responses).toEqual([]);
  });
  it.each([
    { retained: false }, { status: 'failed' as const }, { action: 'rollback' as const },
    { buildId: randomUUID() }, { releaseId: null },
  ])('still rejects an unavailable rollback source: %j', async patch => {
    const { repository, values } = database(rollbackSnapshots({ ...original, ...patch }));
    await expect(repository.create(input)).rejects.toBeInstanceOf(DeployConflictError);
    expect(values).not.toHaveBeenCalled();
  });
  it('still rejects rollback while the target has an active job', async () => {
    const { repository, values } = database(rollbackSnapshots(original, [{ id: randomUUID() }]));
    await expect(repository.create(input)).rejects.toBeInstanceOf(DeployConflictError);
    expect(values).not.toHaveBeenCalled();
  });
  it('uses transaction-local READ COMMITTED for absent-target insertion', async () => {
    const { repository, transaction } = database([[{ id }], [], []]);
    await repository.saveTarget(id, randomUUID(), id, { name: 'site', host: 'example.com', port: 22,
      username: 'deploy', hostKey: 'ssh-ed25519 AAAA', basePath: '/srv/site', retention: 5 }, 'test-only-ciphertext', true);
    expect(transaction).toHaveBeenCalledWith(expect.any(Function), { isolationLevel: 'read committed' });
  });
});
