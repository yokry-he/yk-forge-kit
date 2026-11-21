import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { AlipayConfigInputSchema, AlipayConfigSchema, AlipayJobInputSchema, AlipayJobPayloadSchema, BuildCreateRequestSchema, qrImageType } from '../src';
describe('B20 Alipay contracts', () => {
  const input = { buildId: randomUUID(), version: '1.0.0', action: 'upload_preview' };
  it('accepts official development/experience upload and excludes secrets from queue jobs', () => {
    expect(AlipayJobInputSchema.parse(input)).toMatchObject({ target: 'dev', description: '' });
    expect(AlipayJobInputSchema.parse({ ...input, target: 'experience' }).target).toBe('experience');
    for (const patch of [{ target: 'publish' }, { robot: 1 }, { version: '$(cmd)' }, { version: '01.2.3' }, { version: '1.2.3-beta' }, { version: '2147483648.0.0' }, { description: 'x'.repeat(200) }, { privateKey: 'secret' }, { action: 'preview', target: 'experience' }]) expect(AlipayJobInputSchema.safeParse({ ...input, ...patch }).success).toBe(false);
    expect(AlipayJobPayloadSchema.safeParse({ jobId: randomUUID(), privateKey: 'secret' }).success).toBe(false);
    expect(BuildCreateRequestSchema.safeParse({ sourceRef: 'template:uniapp', target: 'mp-alipay' }).success).toBe(true);
  });
  it('requires numeric AppID and toolId, exposes only explicit safe metadata', () => {
    expect(AlipayConfigInputSchema.safeParse({ appId: '0000000000000000', toolId: 'synthetic-tool' }).success).toBe(true);
    expect(AlipayConfigInputSchema.safeParse({ appId: 'wx0000000000000000' }).success).toBe(false);
    const row = { projectId: randomUUID(), appId: '0000000000000000', toolId: 'synthetic-tool', hasPrivateKey: true, updatedAt: new Date().toISOString(), updatedBy: randomUUID() };
    expect(AlipayConfigSchema.safeParse(row).success).toBe(true);
    for (const name of ['privateKey', 'encryptedPrivateKey']) expect(AlipayConfigSchema.safeParse({ ...row, [name]: 'secret' }).success).toBe(false);
  });
  it('rejects executable QR responses and oversized images', () => {
    expect(qrImageType(Buffer.from([255,216,1,255,217]))).toBe('image/jpeg');
    for (const data of [Buffer.from('<svg/>'), Buffer.alloc(1048577)]) expect(() => qrImageType(data)).toThrow();
  });
});
