import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { listProjectTemplates, renderProjectFiles } from '@forgekit/project-core';

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
      const files = renderProjectFiles({ name, template: template.id, features: template.defaultFeatures });
      for (const path of Object.keys(files)) {
        const content = await readFile(join(root, name, path), 'utf8');
        expect(content, path).toBe(files[path]);
        expect(content, path).not.toContain('__PROJECT_NAME__');
      }
    }
  });
});

/**
 * Opt-in build smoke test: installs real dependencies from the npm registry and runs each
 * generated project's `build` script. Enabled in CI by FORGEKIT_TEMPLATE_SMOKE=1.
 */
describe.skipIf(process.env.FORGEKIT_TEMPLATE_SMOKE !== '1')('generated project build smoke test', () => {
  for (const template of listProjectTemplates()) {
    it(`installs and builds ${template.id}`, async () => {
      const name = `smoke-${template.id}`;
      expect(run('create', name, '--template', template.id, '--dir', root).status).toBe(0);
      const dir = join(root, name);
      if (template.id === 'nuxt-site') {
        // Oldest post is absent from the home page; explicit prerender routes must still include it.
        await writeFile(join(dir, 'content/blog/smoke-added-post.md'), '\uFEFF---\r\ntitle: "新增文章冒烟测试"\r\ndescription: "验证冒号: 与引号"\r\ndate: 2020-01-01\r\ntags: ["回归", 测试]\r\n---\r\n\r\n## 新增正文\r\n\r\n**Markdown 已渲染**\r\n');
      }
      // spawnSync kills the child after the timeout, so a hung install/build fails instead of blocking the runner.
      const pnpm = (...args: string[]) => spawnSync('corepack', ['pnpm', ...args], { cwd: dir, encoding: 'utf8', timeout: 480_000, killSignal: 'SIGKILL', env: { ...process.env, CI: 'true', NUXT_PUBLIC_SITE_URL: 'https://smoke.example.com/', NUXT_PUBLIC_SITE_NAME: 'Smoke Site' } });
      const install = pnpm('install', '--no-frozen-lockfile');
      expect(install.status, `${install.error ?? ''}\n${install.stdout}${install.stderr}`).toBe(0);
      const build = pnpm('run', 'build');
      expect(build.status, `${build.error ?? ''}\n${build.stdout}${build.stderr}`).toBe(0);
      if (template.id === 'tauri-desktop') {
        expect(await readFile(join(dir, 'dist/index.html'), 'utf8')).toContain('<div id="app">');
        expect(await readFile(join(dir, '.github/workflows/release-desktop.yml'), 'utf8')).toContain('matrix:');
      }
      if (template.id === 'uniapp') {
        // Official CLI output is dist/build/<platform>, rather than HBuilderX's unpackage/dist.
        expect(await readFile(join(dir, 'dist/build/h5/index.html'), 'utf8')).toContain('<div id="app">');
        const weixin = pnpm('run', 'build:mp-weixin');
        expect(weixin.status, `${weixin.error ?? ''}\n${weixin.stdout}${weixin.stderr}`).toBe(0);
        const output = join(dir, 'dist/build/mp-weixin');
        const config = JSON.parse(await readFile(join(output, 'app.json'), 'utf8'));
        expect(config.pages).toEqual(['pages/index/index', 'pages/list/index', 'pages/detail/index', 'pages/profile/index']);
        expect(config.tabBar.list.map((tab: { pagePath: string }) => tab.pagePath)).toEqual([
          'pages/index/index', 'pages/list/index', 'pages/profile/index',
        ]);
        for (const path of ['app.js', 'pages/index/index.wxml', 'pages/list/index.wxml', 'pages/detail/index.wxml', 'pages/profile/index.wxml']) {
          expect(await readFile(join(output, path), 'utf8'), path).toBeTruthy();
        }
      }
      if (template.id === 'uniapp') {
        const alipay = pnpm('run', 'build:mp-alipay');
        expect(alipay.status, `${alipay.error ?? ''}\n${alipay.stdout}${alipay.stderr}`).toBe(0);
        const output = join(dir, 'dist/build/mp-alipay');
        expect(JSON.parse(await readFile(join(output, 'app.json'), 'utf8')).pages).toContain('pages/index/index');
        for (const path of ['app.js', 'mini.project.json', 'pages/index/index.axml']) expect(await readFile(join(output, path), 'utf8')).toBeTruthy();
      }
      if (template.id === 'nuxt-site') {
        expect(await readFile(join(dir, '.output/server/index.mjs'), 'utf8')).toBeTruthy();
        const pkg = JSON.parse(await readFile(join(dir, 'package.json'), 'utf8'));
        expect(pkg.scripts.generate).toBeTruthy();
        const generate = pnpm('run', 'generate');
        expect(generate.status, `${generate.error ?? ''}\n${generate.stdout}${generate.stderr}`).toBe(0);
        const home = await readFile(join(dir, '.output/public/index.html'), 'utf8');
        expect(home).toContain('首页 - Smoke Site');
        expect(home).toContain('如何用 Nuxt 搭建企业官网');
        for (const page of ['about', 'blog', 'contact']) {
          const html = await readFile(join(dir, '.output/public', page, 'index.html'), 'utf8');
          const ogUrl = html.match(/<meta[^>]*property="og:url"[^>]*>/)?.[0];
          expect(ogUrl).toContain(`content="https://smoke.example.com/${page}"`);
        }
        for (const slug of ['hello-world', 'build-a-corporate-site', 'deploy-to-cloud', 'smoke-added-post']) {
          const html = await readFile(join(dir, '.output/public/blog', slug, 'index.html'), 'utf8');
          expect(html).toContain('application/ld+json');
          expect(html).toContain(`https://smoke.example.com/blog/${slug}`);
        }
        const post = await readFile(join(dir, '.output/public/blog/smoke-added-post/index.html'), 'utf8');
        expect(post).toContain('<strong>Markdown 已渲染</strong>');
        expect(post).toContain('新增文章冒烟测试');
        expect(post).toContain('回归');
        expect(post).toContain('2020-01-01');
        expect(post).not.toContain('title: &quot;');
        const jsonLd = post.match(/<script\b[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/);
        expect(jsonLd).not.toBeNull();
        expect(JSON.parse(jsonLd![1]!)).toMatchObject({
          '@type': 'BlogPosting', headline: '新增文章冒烟测试', datePublished: '2020-01-01',
        });
        const sitemap = await readFile(join(dir, '.output/public/sitemap.xml'), 'utf8');
        for (const path of ['/', '/about', '/blog', '/contact', '/blog/hello-world', '/blog/build-a-corporate-site', '/blog/deploy-to-cloud', '/blog/smoke-added-post']) {
          expect(sitemap).toContain(`<loc>https://smoke.example.com${path}</loc>`);
        }
      }
    }, 1_500_000);
  }
});
