import { randomBytes, randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { EnvironmentVariableRepository, type DatabaseClient } from '../src/index';
import { encryptVariable } from '../src/deploy-secrets';
import { environmentVariables, variableAudit } from '../src/schema';

// Exercise the persistence boundary without a MySQL dependency in the default test job.
describe('B14 persistence allowlists', () => {
  it.each(['create', 'update'] as const)('stores encrypted data separately from value-free %s audit', async action => {
    const pid = randomUUID(), eid = randomUUID(), actor = randomUUID(), key = randomBytes(32), secret = 'b14-persistence-secret';
    const responses: unknown[][] = [[{ id: pid }], [{ id: eid }], action === 'create' ? [] : [{ name: 'TOKEN' }]];
    const writes: Array<{ table: unknown; value: unknown }> = [];
    const tx = { select: vi.fn(() => {
      const rows = responses.shift(); if (!rows) throw new Error('unexpected_select');
      return Object.assign(Promise.resolve(rows), { from() { return this; }, where() { return this; }, for() { return this; } });
    }), insert: (table: unknown) => ({ values: (value: unknown) => {
      writes.push({ table, value }); return Object.assign(Promise.resolve(), { onDuplicateKeyUpdate: () => Promise.resolve() });
    } }) };
    const transaction = async (work: (value: typeof tx) => Promise<unknown>) => work(tx);
    const repo = new EnvironmentVariableRepository({ transaction } as unknown as DatabaseClient['db']);
    const result = await repo.save(pid, 'preview', 'TOKEN', { kind: 'secret', value: secret }, actor,
      (value, env) => encryptVariable(value, key, pid, env, 'TOKEN'));
    expect(result.plainValue).toBeNull(); expect(result.encryptedValue).toMatch(/^v1\./);
    expect(writes[0]!.table).toBe(environmentVariables);
    expect(JSON.stringify(writes[0]!.value)).not.toContain(secret);
    expect(writes[1]).toEqual({ table: variableAudit, value: { projectId: pid, environmentId: eid, name: 'TOKEN', kind: 'secret', actorUserId: actor, action } });
    expect(JSON.stringify(writes[1]!.value)).not.toContain(result.encryptedValue!);
  });
});
