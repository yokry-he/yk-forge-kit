import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { WeappConfigInputSchema, WeappConfigSchema, WeappJobInputSchema, WeappJobPayloadSchema, BuildCreateRequestSchema } from '../src';
describe('B17 contracts', () => {
  it('rejects unknown fields and unsupported targets, constrains robot/version', () => {
    const input = { buildId: randomUUID(), action: 'upload_preview', version: '1.0.0' };
    expect(WeappJobInputSchema.parse(input)).toMatchObject({ target: 'dev', robot: 1, description: '' });
    for (const patch of [{ target: 'experience' }, { robot: 0 }, { robot: 31 }, { robot: 1.5 }, { version: '$(command)' }, { privateKey: 'secret' }, { action: 'publish' }]) expect(WeappJobInputSchema.safeParse({ ...input, ...patch }).success).toBe(false);
    expect(WeappJobPayloadSchema.safeParse({ jobId: randomUUID(), privateKey: 'secret' }).success).toBe(false);
    expect(BuildCreateRequestSchema.safeParse({ sourceRef: 'template:uniapp', target: 'mp-weixin' }).success).toBe(true);
    expect(BuildCreateRequestSchema.safeParse({ sourceRef: 'template:uniapp', target: 'mp-baidu' }).success).toBe(false);
  });
  it('distinguishes write input from public config and excludes encrypted/plaintext secrets', () => {
    expect(WeappConfigInputSchema.parse({ appId: 'wx0000000000000000' })).toEqual({ appId: 'wx0000000000000000', ipWhitelistNote: '' });
    const row = { projectId: randomUUID(), appId: 'wx0000000000000000', hasPrivateKey: true, ipWhitelistNote: '', updatedBy: randomUUID(), updatedAt: new Date().toISOString() };
    expect(WeappConfigSchema.safeParse(row).success).toBe(true);
    for (const name of ['privateKey', 'encryptedPrivateKey']) expect(WeappConfigSchema.safeParse({ ...row, [name]: 'secret' }).success).toBe(false);
  });
});
