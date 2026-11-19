import { describe, expect, it } from 'vitest';
import { BadRequestException } from '@nestjs/common';
import { parseAssetSelection, parseExpectedVersion } from '../src/project-assets.controller';

describe('project asset selection validation', () => {
  it('resolves a known compatible asset at the current version', () => {
    const asset = parseAssetSelection({ assetId: 'official.theme' });
    expect(asset.version).toBe('1.1.0');
  });
  it.each([null, {}, { assetId: 123 }, { assetId: 'official.unknown' }, { assetId: [] }])
    ('rejects invalid or unsupported asset selection', (body) => {
      expect(() => parseAssetSelection(body)).toThrow(BadRequestException);
    });
  it('accepts only an expected version, never a caller-selected target or status', () => {
    expect(parseExpectedVersion({ expectedVersion: '1.0.0' })).toBe('1.0.0');
    for (const value of [null, {}, { expectedVersion: 1 }, { expectedVersion: 'latest' },
      { expectedVersion: '1.0.0', version: '2.0.0' }, { expectedVersion: '1.0.0', status: 'applied' }]) {
      expect(() => parseExpectedVersion(value)).toThrow(BadRequestException);
    }
  });
});
