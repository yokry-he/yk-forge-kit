import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const cli = resolve('dist/index.js');
let root: string;
const run = (...args: string[]) => spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8' });

beforeAll(async () => { root = await mkdtemp(join(tmpdir(), 'forgekit-asset-verify-')); });
afterAll(async () => { if (root) await rm(root, { recursive: true, force: true }); });

describe('read-only CLI verification', () => {
  it('verifies files installed by the Vue template', () => {
    expect(run('create', 'with-theme', '--dir', root).status).toBe(0);
    const result = run('asset', 'verify', 'official.theme', '--dir', join(root, 'with-theme'));
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('只读验证');
  });

  it('fails when the asset was not installed', () => {
    expect(run('create', 'without-theme', '--features', 'none', '--dir', root).status).toBe(0);
    const result = run('asset', 'verify', 'official.theme', '--dir', join(root, 'without-theme'));
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('尚未安装');
  });

  it('detects changed managed files without repairing them', async () => {
    const path = join(root, 'with-theme', 'src/forgekit/theme.css');
    const altered = (await readFile(path, 'utf8')) + '\n/* user edit */\n';
    await writeFile(path, altered);
    const result = run('asset', 'verify', 'official.theme', '--dir', join(root, 'with-theme'));
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('文件被修改');
    expect(await readFile(path, 'utf8')).toBe(altered);
  });
});
