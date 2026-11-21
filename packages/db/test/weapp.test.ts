import { randomBytes, randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { encryptWeappKey, decryptWeappKey, decryptDeployKey, decryptVariable, isWeappBuild } from '../src';
describe('B17 encryption and build preconditions', () => {
  it('encrypts with fresh IVs and binds secrets to project and purpose', () => {
    const key = randomBytes(32), pid = randomUUID(), secret = 'synthetic-private-key-content';
    const blob = encryptWeappKey(secret, key, pid);
    expect(blob).not.toContain(secret); expect(encryptWeappKey(secret, key, pid)).not.toBe(blob);
    expect(decryptWeappKey(blob, key, pid).toString()).toBe(secret);
    for (const read of [() => decryptWeappKey(blob, key, randomUUID()), () => decryptWeappKey(blob, randomBytes(32), pid),
      () => decryptWeappKey(blob.slice(0, -4), key, pid), () => decryptVariable(blob, key, pid, pid, 'KEY'), () => decryptDeployKey(blob, key, pid, pid)]) {
      expect(read).toThrow('deploy_key_decryption_failed');
    }
  });
  it('requires successful same-project uniapp mp-weixin artifacts', () => {
    const pid = randomUUID(), build = { projectId: pid, template: 'uniapp', target: 'mp-weixin', status: 'succeeded', artifactKey: 'key', artifactSha256: 'digest' };
    expect(isWeappBuild(build, pid)).toBe(true);
    for (const patch of [{ target: 'h5' }, { target: undefined }, { template: 'vue-web' }, { status: 'queued' }, { status: 'running' }, { status: 'failed' }, { artifactKey: null }, { artifactSha256: null }, { projectId: randomUUID() }]) expect(isWeappBuild({ ...build, ...patch }, pid)).toBe(false);
  });
});
