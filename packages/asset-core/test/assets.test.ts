import { describe, expect, it } from 'vitest';
import { emptyAssetLock, listAssets, parseAssetLock, planAssetInstall, resolveAssets } from '../src/index';

describe('assets', () => {
  it('lists built-in manifests and resolves duplicates deterministically', () => {
    expect(listAssets()[0]?.id).toBe('official.theme');
    expect(resolveAssets(['official.theme', 'official.theme'], 'vue-web')).toHaveLength(1);
  });
  it('rejects unknown assets', () => {
    expect(() => resolveAssets(['official.unknown'], 'vue-web')).toThrow('未知资产');
  });
  it('plans a non-destructive theme installation and persists lock hashes', () => {
    const base = { 'src/style.css': 'body { margin: 0; }\n', 'src/forgekit/theme.css': null };
    const plan = planAssetInstall('official.theme', 'vue-web', base, emptyAssetLock());
    expect(plan.changes).toHaveLength(2);
    expect(plan.changes[1]?.after).toContain('body { margin: 0; }');
    const files = { ...base, ...Object.fromEntries(plan.changes.map(({ path, after }) => [path, after])) };
    expect(planAssetInstall('official.theme', 'vue-web', files, plan.lock).alreadyInstalled).toBe(true);
    expect(() => planAssetInstall('official.theme', 'vue-web', { ...files, 'src/style.css': 'user changed' }, plan.lock)).toThrow('修改');
  });
  it('rejects collisions and invalid locks', () => {
    expect(() => planAssetInstall('official.theme', 'vue-web', { 'src/style.css': 'a', 'src/forgekit/theme.css': 'custom' }, emptyAssetLock())).toThrow('拒绝覆盖');
    expect(() => parseAssetLock('{"schemaVersion":2,"assets":{}}')).toThrow();
  });
});
