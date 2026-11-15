import { describe, expect, it } from 'vitest';
import { BadRequestException } from '@nestjs/common';
import { parseAssetSelection } from '../src/project-assets.controller';

describe('project asset selection validation', () => {
  it('resolves a known compatible asset at the current version', () => {
    const asset = parseAssetSelection({ assetId: 'official.theme' });
    expect(asset.version).toBe('1.1.0');
  });
  it.each([null, {}, { assetId: 123 }, { assetId: 'official.unknown' }, { assetId: [] }])
    ('rejects invalid or unsupported asset selection', (body) => {
      expect(() => parseAssetSelection(body)).toThrow(BadRequestException);
    });
});
