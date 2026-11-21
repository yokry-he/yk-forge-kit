import { describe, expect, it, vi } from 'vitest';
import { resolveRuntimeRedactions } from '../src/runtime-log-worker';
import { redactBuildLog } from '../src/build-logs';
describe('trusted project runtime redactions', () => {
  it('includes secrets and ciphertext from each project environment without exposing plain variables', async () => {
    const variables = {
      environments: vi.fn().mockResolvedValue([{ id: 'preview-id', name: 'preview' }, { id: 'production-id', name: 'production' }]),
      resolve: vi.fn().mockImplementation(async (_pid: string, eid: string) => ({ values: {}, secrets: ['private-' + eid] })),
      list: vi.fn().mockImplementation(async (_pid: string, name: string) => [
        { kind: 'secret', encryptedValue: 'fixture-cipher-' + name }, { kind: 'plain', encryptedValue: null, plainValue: 'public-value' },
      ]),
    };
    const resolved = await resolveRuntimeRedactions(variables, 'project-id');
    expect(resolved.values).toEqual({});
    expect(resolved.secrets).toEqual(['private-preview-id', 'fixture-cipher-preview', 'private-production-id', 'fixture-cipher-production']);
    expect(variables.environments).toHaveBeenCalledWith('project-id');
    expect(variables.resolve).toHaveBeenCalledWith('project-id', 'production-id');
    expect(variables.list).toHaveBeenCalledWith('project-id', 'preview');
    const redacted = redactBuildLog(resolved.secrets.join(' ') + ' public-value', resolved.secrets);
    expect(redacted).toBe('[REDACTED] [REDACTED] [REDACTED] [REDACTED] public-value');
  });
  it('fails closed if any project environment cannot be decrypted', async () => {
    const variables = { environments: vi.fn().mockResolvedValue([{ id: 'env', name: 'production' }]),
      resolve: vi.fn().mockRejectedValue(new Error('decryption_failed')), list: vi.fn() };
    await expect(resolveRuntimeRedactions(variables, 'project-id')).rejects.toThrow('decryption_failed');
    expect(variables.list).not.toHaveBeenCalled();
  });
});
