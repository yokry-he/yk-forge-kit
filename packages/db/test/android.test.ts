import { randomBytes, randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { encryptAndroidSigning, decryptAndroidSigning, decryptVariable, decryptWeappKey } from '../src';
describe('B18 authenticated signing storage', () => {
  it('uses fresh IVs and rejects project/purpose/key substitution or tampering', () => {
    const key = randomBytes(32), project = randomUUID(), secret = '{"keystore":"synthetic-signing-material"}';
    const blob = encryptAndroidSigning(secret, key, project);
    expect(blob).not.toContain(secret); expect(encryptAndroidSigning(secret, key, project)).not.toBe(blob);
    expect(decryptAndroidSigning(blob, key, project).toString()).toBe(secret);
    for (const read of [() => decryptAndroidSigning(blob, key, randomUUID()), () => decryptAndroidSigning(blob, randomBytes(32), project),
      () => decryptAndroidSigning(blob.slice(0, -4), key, project), () => decryptVariable(blob, key, project, project, 'SIGN'), () => decryptWeappKey(blob, key, project)]) {
      expect(read).toThrow('deploy_key_decryption_failed');
    }
  });
});
