import { describe, expect, it } from 'vitest';
import { AndroidConfigInputSchema, AndroidJobInputSchema, AndroidJobPayloadSchema, AndroidArtifactSchema } from '../src/android';
const settings = { packageName: 'com.example.demo', appId: '__UNI__TEST123', appKey: 'synthetic-appkey', versionName: '1.0.0', versionCode: 1 };
describe('B18 strict Android contracts', () => {
  it('accepts configuration and bounded write-only signing replacements', () => {
    expect(AndroidConfigInputSchema.parse(settings)).toEqual(settings);
    expect(AndroidConfigInputSchema.parse({ ...settings, signing: { keystore: 'dGVzdGtleQ==', alias: 'release', storePassword: 'store-password', keyPassword: 'key-password' } }).signing?.alias).toBe('release');
  });
  it.each([{ packageName: 'com.demo;id' }, { packageName: '../escape' }, { appId: 'wx123' }, { appKey: 'a\nsecret' }, { versionCode: 0 }, { versionCode: 1.1 }, { versionName: '$(id)' }, { command: 'gradle' }, { signing: { keystore: 'invalid%' } }])('rejects unsafe metadata %j', patch => {
    expect(AndroidConfigInputSchema.safeParse({ ...settings, ...patch }).success).toBe(false);
  });
  it('does not accept queue secrets, arbitrary commands, paths or unexpected kinds', () => {
    expect(AndroidJobInputSchema.parse({ buildType: 'release', kind: 'aab' })).toEqual({ buildType: 'release', kind: 'aab' });
    for (const input of [{ buildType: 'debug', kind: 'ipa' }, { buildType: 'debug', kind: 'apk', signing: 'secret' }, { buildType: 'release', kind: 'apk', sourceRef: '/host' }]) expect(AndroidJobInputSchema.safeParse(input).success).toBe(false);
    expect(AndroidJobPayloadSchema.safeParse({ jobId: 'bad', password: 'secret' }).success).toBe(false);
    expect(AndroidArtifactSchema.safeParse({ kind: 'apk', size: 1, sha256: 'bad' }).success).toBe(false);
  });
});
