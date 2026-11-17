import { describe, expect, it } from 'vitest';
import { emptyAssetLock, fingerprint, getAssetVersionStatus, listAssets, parseAssetLock, planAssetInstall, planAssetUpgrade, planAssetUninstall, resolveAssets } from '../src/index';

describe('assets', () => {
  it('lists built-in manifests and resolves duplicates deterministically', () => {
    expect(listAssets()[0]?.id).toBe('official.theme');
    expect(listAssets()[0]?.version).toBe('1.1.0');
    expect(resolveAssets(['official.theme', 'official.theme'], 'vue-web')).toHaveLength(1);
  });
  it('rejects unknown assets', () => {
    expect(() => resolveAssets(['official.unknown'], 'vue-web')).toThrow('未知资产');
  });
  it('classifies recorded versions without claiming a local installation was verified', () => {
    expect(getAssetVersionStatus('official.theme', '1.1.0')).toBe('current');
    expect(getAssetVersionStatus('official.theme', '1.0.0')).toBe('upgrade-available');
    expect(getAssetVersionStatus('official.theme', '2.0.0')).toBe('unsupported');
    expect(getAssetVersionStatus('unknown', '1.0.0')).toBe('unsupported');
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
  it('upgrades known v1 theme files without touching unchanged user style', () => {
    const first = planAssetInstall('official.theme', 'vue-web', {
      'src/style.css': 'body {}\n', 'src/forgekit/theme.css': null,
    }, emptyAssetLock());
    const currentTheme = first.changes[0]?.after;
    if (!currentTheme) throw new Error('Missing theme fixture');
    const v1Theme = currentTheme.replace('  --fk-brand-hover: #7c3aed;\n  --fk-radius: 10px;\n', '');
    const style = first.changes[1]?.after;
    if (!style) throw new Error('Missing style fixture');
    const priorLock = {
      schemaVersion: 1 as const,
      assets: { 'official.theme': { version: '1.0.0', files: { 'src/forgekit/theme.css': fingerprint(v1Theme), 'src/style.css': fingerprint(style) } } },
    };
    const files = { 'src/forgekit/theme.css': v1Theme, 'src/style.css': style };
    const upgraded = planAssetUpgrade('official.theme', 'vue-web', files, priorLock);
    expect(upgraded.changes).toHaveLength(1);
    expect(upgraded.lock.assets['official.theme']?.version).toBe('1.1.0');
    const newFiles = { ...files, 'src/forgekit/theme.css': upgraded.changes[0]?.after ?? '' };
    expect(planAssetUpgrade('official.theme', 'vue-web', newFiles, upgraded.lock).noChange).toBe(true);
    expect(() => planAssetUpgrade('official.theme', 'vue-web', { ...files, 'src/style.css': 'custom' }, priorLock)).toThrow('修改');
  });
  it('uninstalls only managed code after checking lock integrity', () => {
    const initial = 'body { color: red; }\n';
    const installed = planAssetInstall('official.theme', 'vue-web', {
      'src/style.css': initial, 'src/forgekit/theme.css': null,
    }, emptyAssetLock());
    const files = Object.fromEntries(installed.changes.map((change) => [change.path, change.after])) as Record<string, string>;
    const removed = planAssetUninstall('official.theme', 'vue-web', files, installed.lock);
    expect(removed.changes.find((item) => item.path === 'src/style.css')?.after).toBe(initial);
    expect(removed.changes.find((item) => item.path === 'src/forgekit/theme.css')?.action).toBe('delete');
    expect(Object.keys(removed.lock.assets)).toHaveLength(0);
    expect(() => planAssetUninstall('official.theme', 'vue-web', { ...files, 'src/forgekit/theme.css': 'custom' }, installed.lock)).toThrow('修改');
    expect(() => planAssetUninstall('official.theme', 'vue-web', files, emptyAssetLock())).toThrow('尚未安装');
  });
});
