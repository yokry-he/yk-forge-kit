import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { listProjectTemplates } from '@forgekit/project-core';

const cli = resolve('dist/index.js');
let root: string;
const run = (...args: string[]) => spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8' });

beforeAll(async () => { root = await mkdtemp(join(tmpdir(), 'forgekit-templates-')); });
afterAll(async () => { if (root) await rm(root, { recursive: true, force: true }); });

describe('CLI template selection', () => {
  it('lists every registered template', () => {
    const result = run('templates');
    expect(result.status).toBe(0);
    for (const template of listProjectTemplates()) expect(result.stdout).toContain(template.id);
  });

  it('rejects unknown templates and features that the template does not offer', () => {
    const unknown = run('create', 'bad-template', '--template', 'mobile', '--dir', root);
    expect(unknown.status).toBe(1);
    expect(unknown.stderr).toContain('未知模板');
    expect(run('create', 'bad-feature', '--template', 'vue-web', '--features', 'auth', '--dir', root).status).toBe(1);
  });

  it('creates each template with its default features', async () => {
    for (const template of listProjectTemplates()) {
      const name = `tpl-${template.id}`;
      const result = run('create', name, '--template', template.id, '--dir', root);
      expect(result.status, result.stderr).toBe(0);
      const pkg = JSON.parse(await readFile(join(root, name, 'package.json'), 'utf8')) as { name: string; scripts: Record<string, string> };
      expect(pkg.name).toBe(name);
      expect(pkg.scripts.build).toBeTruthy();
    }
  });
});

/**
 * Opt-in build smoke test: installs real dependencies from the npm registry and runs each
 * generated project's `build` script. Enabled in CI by FORGEKIT_TEMPLATE_SMOKE=1.
 */
describe.skipIf(process.env.FORGEKIT_TEMPLATE_SMOKE !== '1')('generated project build smoke test', () => {
  for (const template of listProjectTemplates()) {
    it(`installs and builds ${template.id}`, () => {
      const name = `smoke-${template.id}`;
      expect(run('create', name, '--template', template.id, '--dir', root).status).toBe(0);
      const dir = join(root, name);
      const pnpm = (...args: string[]) => spawnSync('corepack', ['pnpm', ...args], { cwd: dir, encoding: 'utf8', env: { ...process.env, CI: 'true' } });
      const install = pnpm('install', '--no-frozen-lockfile');
      expect(install.status, install.stdout + install.stderr).toBe(0);
      const build = pnpm('run', 'build');
      expect(build.status, build.stdout + build.stderr).toBe(0);
    }, 300_000);
  }
});
