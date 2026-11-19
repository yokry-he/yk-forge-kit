import { expect, it } from 'vitest';
import { API_VERSION, parseAssetVerificationReceipt } from '../src/index';

it('exports a stable API version contract', () => {
  expect(API_VERSION).toBe('v1');
});

const example = {
  schemaVersion: 1,
  kind: 'forgekit.asset-verification',
  project: 'my-app',
  assetId: 'official.theme',
  assetVersion: '1.1.0',
  files: [{ path: 'src/style.css', sha256: 'a'.repeat(64) }],
  lockSha256: 'b'.repeat(64),
  verifiedAt: '2026-11-15T12:00:00.000Z',
};

it('parses a well-formed unsigned verification receipt', () => {
  expect(parseAssetVerificationReceipt(JSON.stringify(example)).assetId).toBe('official.theme');
});

it.each([
  { ...example, lockSha256: 'abc' },
  { ...example, files: [{ path: '../unsafe', sha256: 'a'.repeat(64) }] },
  { ...example, files: [example.files[0], example.files[0]] },
  { ...example, schemaVersion: 2 },
])('rejects malformed receipt fields', (value) => {
  expect(() => parseAssetVerificationReceipt(JSON.stringify(value))).toThrow();
});
