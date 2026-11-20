import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { encryptVariable, decryptVariable, decryptDeployKey } from '../src/deploy-secrets';
describe('B14 authenticated secrets, sharing the B12 construction', () => {
  it('authenticates all identity fields and isolates the B12 namespace', () => {
    const key = randomBytes(32), value = 'b14-test-only-secret';
    const blob = encryptVariable(value, key, 'project', 'env', 'TOKEN');
    expect(blob).not.toBe(encryptVariable(value, key, 'project', 'env', 'TOKEN'));
    expect(decryptVariable(blob, key, 'project', 'env', 'TOKEN').toString()).toBe(value);
    for (const [project, env, name] of [['other', 'env', 'TOKEN'], ['project', 'other', 'TOKEN'], ['project', 'env', 'OTHER']]) {
      expect(() => decryptVariable(blob, key, project!, env!, name!)).toThrow('deploy_key_decryption_failed');
    }
    expect(() => decryptDeployKey(blob, key, 'project', 'env')).toThrow();
    expect(() => decryptVariable(blob, randomBytes(32), 'project', 'env', 'TOKEN')).toThrow();
    for (const length of [4, 12, 15, 17]) {
      const parts = blob.split('.'); parts[2] = Buffer.alloc(length).toString('base64');
      expect(() => decryptVariable(parts.join('.'), key, 'project', 'env', 'TOKEN')).toThrow();
    }
    const parts = blob.split('.'); parts[3] = Buffer.from('tampered').toString('base64');
    expect(() => decryptVariable(parts.join('.'), key, 'project', 'env', 'TOKEN')).toThrow();
  });
});
