import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { BuildRepository } from '../src/build-repository';
import { builds } from '../src/schema';
import type { DatabaseClient } from '../src';

describe('build diagnosis persistence boundary', () => {
  it('writes validated diagnosis with the guarded terminal status and preserves it when reading', async () => {
    const now = new Date(), id = randomUUID();
    let row: typeof builds.$inferSelect = { id, projectId: randomUUID(), triggeredBy: randomUUID(),
      number: 1, template: 'vue-web', sourceRef: 'template:vue-web', target: 'h5', status: 'running',
      queuedAt: now, startedAt: now, finishedAt: null, createdAt: now, updatedAt: now,
      exitCode: null, errorMessage: null, artifactKey: null, artifactSize: null, artifactSha256: null,
      logStorageKey: null, runnerInfo: null, diagnosis: null };
    const select = vi.fn(() => Object.assign(Promise.resolve([{ ...row }]), {
      from() { return this; }, where() { return this; }, limit() { return this; }, for() { return this; },
    }));
    const set = vi.fn((next: typeof row) => ({ where: async () => { row = next; } }));
    const tx = { select, update: vi.fn(() => ({ set })) };
    const db = { select, transaction: async (work: (client: typeof tx) => Promise<unknown>) => work(tx) };
    const repository = new BuildRepository(db as unknown as DatabaseClient['db']);
    const diagnosis = { category: 'compile_error' as const, matchedLogSeqs: [12], excerpt: ['error TS2322: invalid type'] };
    await repository.updateStatus(id, 'running', 'failed', { exitCode: 2, diagnosis });
    expect(tx.update).toHaveBeenCalledWith(builds);
    expect(set).toHaveBeenCalledWith(expect.objectContaining({ status: 'failed', diagnosis }));
    expect(await repository.get(id)).toMatchObject({ status: 'failed', diagnosis });
    expect(row.finishedAt).toBeInstanceOf(Date);
    await expect(repository.updateStatus(id, 'running', 'failed', {
      diagnosis: { ...diagnosis, excerpt: ['x'.repeat(241)] },
    })).rejects.toThrow();
    expect(set).toHaveBeenCalledTimes(1);
  });
});
