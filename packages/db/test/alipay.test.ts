import { randomBytes, randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { encryptAlipayKey, decryptAlipayKey, decryptWeappKey, decryptDeployKey, decryptVariable, isAlipayBuild } from '../src';
describe('B20 encryption and build preconditions', () => {
  it('encrypts with fresh IVs and binds secrets to project and purpose', () => {
    const key = randomBytes(32), pid = randomUUID(), secret = 'synthetic-private-key-content';
    const blob = encryptAlipayKey(secret, key, pid);
    expect(blob).not.toContain(secret); expect(encryptAlipayKey(secret, key, pid)).not.toBe(blob);
    expect(decryptAlipayKey(blob, key, pid).toString()).toBe(secret);
    for (const read of [() => decryptAlipayKey(blob, key, randomUUID()), () => decryptAlipayKey(blob, randomBytes(32), pid),
      () => decryptAlipayKey(blob.slice(0, -4), key, pid), () => decryptWeappKey(blob, key, pid), () => decryptVariable(blob, key, pid, pid, 'KEY'), () => decryptDeployKey(blob, key, pid, pid)]) {
      expect(read).toThrow('deploy_key_decryption_failed');
    }
  });
  it('requires successful same-project uniapp mp-alipay artifacts', () => {
    const pid = randomUUID(), build = { projectId: pid, template: 'uniapp', target: 'mp-alipay', status: 'succeeded', artifactKey: 'key', artifactSha256: 'digest' };
    expect(isAlipayBuild(build, pid)).toBe(true);
    for (const patch of [{ target: 'mp-weixin' }, { target: 'h5' }, { target: undefined }, { template: 'vue-web' }, { status: 'queued' }, { status: 'running' }, { status: 'failed' }, { artifactKey: null }, { artifactSha256: null }, { projectId: randomUUID() }]) expect(isAlipayBuild({ ...build, ...patch }, pid)).toBe(false);
  });
});
