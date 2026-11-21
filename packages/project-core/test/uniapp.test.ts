import { afterEach, describe, expect, it, vi } from 'vitest';
import { ModuleKind, ScriptTarget, transpileModule } from 'typescript';
import { createProjectPlan, getProjectTemplate, isProjectTemplateId, renderProjectFiles } from '../src/index';

const options = { name: 'cross-platform', template: 'uniapp' as const, features: [] };
const files = renderProjectFiles(options);
const pkg = JSON.parse(files['package.json']!) as {
  name: string; packageManager: string; scripts: Record<string, string>;
  dependencies: Record<string, string>; devDependencies: Record<string, string>;
};
const pages = JSON.parse(files['src/pages.json']!) as {
  pages: { path: string }[];
  tabBar: { list: { pagePath: string; iconPath?: string; selectedIconPath?: string }[] };
};

function evaluate(source: string, globals: Record<string, unknown> = {}): Record<string, unknown> {
  const exports: Record<string, unknown> = {};
  const js = transpileModule(source, {
    compilerOptions: { target: ScriptTarget.ES2022, module: ModuleKind.CommonJS },
  }).outputText;
  new Function('exports', ...Object.keys(globals), js)(exports, ...Object.values(globals));
  return exports;
}

describe('uniapp template', () => {
  it('registers a cross-platform starter with an H5 static build plan and no optional features', () => {
    expect(isProjectTemplateId('uniapp')).toBe(true);
    expect(getProjectTemplate('uniapp')).toMatchObject({
      kind: 'miniapp', targets: ['h5', 'miniapp', 'mobile'],
      stack: ['Vue 3', 'TypeScript', 'Vite', 'uni-app'],
      features: [], defaultFeatures: [], assetTarget: null,
      build: { script: 'build', outputDirectory: 'dist/build/h5' },
    });
    expect(() => createProjectPlan({ ...options, features: ['theme'] })).toThrow();
    const plan = createProjectPlan(options);
    expect(plan.commands).toContain('pnpm install');
    expect(plan.commands).toContain('pnpm build:mp-weixin');
    for (const command of plan.commands.filter(command => command.startsWith('pnpm ') && command !== 'pnpm install')) {
      expect(pkg.scripts[command.slice(5)], command).toBeTruthy();
    }
  });

  it('replaces names everywhere and returns deterministic path-safe files', () => {
    expect(pkg.name).toBe(options.name);
    for (const path of ['README.md', 'index.html', 'src/App.vue', 'src/manifest.json', 'src/pages.json']) {
      expect(files[path], path).toContain(options.name);
    }
    expect(Object.values(files).join('\n')).not.toContain('__PROJECT_NAME__');
    expect(renderProjectFiles(options)).toEqual(files);
    expect(createProjectPlan(options).files).toEqual(Object.keys(files).sort());
    for (const path of Object.keys(files)) {
      expect(path.startsWith('/') || path.split('/').includes('..') || path.includes('\\'), path).toBe(false);
      expect(path).not.toMatch(/b16-drafts|node_modules|pnpm-lock/);
    }
    const other = renderProjectFiles({ ...options, name: 'other-app' });
    expect(JSON.parse(other['src/manifest.json']!).name).toBe('other-app');
    expect(files['README.md']).toContain('# cross-platform');
  });

  it('ships complete Vue 3 CLI entry points and three tabs plus a stacked detail page', () => {
    for (const path of ['.gitignore', 'README.md', 'index.html', 'vite.config.ts', 'tsconfig.json', 'src/env.d.ts',
      'src/main.ts', 'src/App.vue', 'src/manifest.json', 'src/pages.json', 'src/api/types.ts', 'src/api/index.ts',
      'src/api/mock.ts', 'src/navigation.ts']) expect(files[path], path).toBeTruthy();
    expect(files['src/main.ts']).toContain('createSSRApp');
    expect(files['vite.config.ts']).toContain('plugins: [uni()]');
    expect(JSON.parse(files['tsconfig.json']!).compilerOptions.strict).toBe(true);
    expect(pages.pages.map(page => page.path)).toEqual([
      'pages/index/index', 'pages/list/index', 'pages/detail/index', 'pages/profile/index',
    ]);
    expect(pages.tabBar.list.map(tab => tab.pagePath)).toEqual([
      'pages/index/index', 'pages/list/index', 'pages/profile/index',
    ]);
    for (const page of pages.pages) {
      const source = files[`src/${page.path}.vue`]!;
      expect(source).toContain('<script setup lang="ts">');
      expect(source).toContain('loading');
      expect(source).toContain('v-else-if="error"');
      expect(source).toContain('console.error');
      expect(source).toContain('uni.showToast');
    }
    for (const tab of pages.tabBar.list) {
      for (const icon of [tab.iconPath, tab.selectedIconPath]) {
        if (icon) expect(files[`src/${icon}`], icon).toBeTruthy();
      }
    }
    expect(files['src/App.vue']).toContain('@media (min-width: 720px)');
    expect(files['src/pages/list/index.vue']).toContain('没有匹配的条目');
    expect(files['src/pages/detail/index.vue']).toContain('条目不存在或已删除');
  });

  it('pins compatible real versions and includes H5, Weixin, Alipay and App scripts', () => {
    expect(pkg.packageManager).toBe('pnpm@10.18.3');
    const dependencies = { ...pkg.dependencies, ...pkg.devDependencies };
    for (const [name, version] of Object.entries(dependencies)) {
      expect(version, name).toMatch(/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/);
      if (name.startsWith('@dcloudio/') && name !== '@dcloudio/types') {
        expect(version).toBe('3.0.0-5030420261029002');
      }
    }
    expect(dependencies).toMatchObject({ vue: '3.4.21', '@vue/runtime-core': '3.4.21', vite: '5.4.21', typescript: '5.9.3' });
    expect(pkg.scripts).toMatchObject({
      dev: 'uni', 'dev:h5': 'uni', build: 'vue-tsc --noEmit && uni build', 'build:h5': 'pnpm build',
      typecheck: 'vue-tsc --noEmit', 'dev:mp-weixin': 'uni -p mp-weixin',
      'build:mp-weixin': 'vue-tsc --noEmit && uni build -p mp-weixin',
      'dev:mp-alipay': 'uni -p mp-alipay', 'build:mp-alipay': 'vue-tsc --noEmit && uni build -p mp-alipay',
      'dev:app': 'uni -p app', 'build:app': 'vue-tsc --noEmit && uni build -p app',
    });
    const manifest = JSON.parse(files['src/manifest.json']!);
    expect(manifest.vueVersion).toBe('3');
    expect(manifest['app-plus'].distribute).toMatchObject({ android: { permissions: [] }, ios: {} });
    for (const platform of ['h5', 'mp-weixin', 'mp-alipay']) expect(manifest[platform]).toBeDefined();
    expect(manifest.appid).toBe('');
    expect(manifest['mp-weixin'].appid).toBe('');
    expect(manifest['mp-alipay'].appid).toBe('');
    expect(manifest['mp-weixin'].setting.urlCheck).toBe(true);
  });

  it('restricts the dev server to the project and disables cross-origin access', () => {
    const uni = vi.fn(() => ({ name: 'uni' }));
    const config = evaluate(files['vite.config.ts']!, {
      require: (id: string) => {
        if (id === 'vite') return { defineConfig: (value: unknown) => value };
        if (id === '@dcloudio/vite-plugin-uni') return { default: uni };
        throw new Error(`Unexpected config import: ${id}`);
      },
    }).default;
    expect(uni).toHaveBeenCalledOnce();
    expect(config).toEqual({
      plugins: [{ name: 'uni' }],
      server: { host: '127.0.0.1', cors: false, fs: { strict: true, allow: ['.'] } },
    });
  });

  it('keeps browser-only APIs and secrets out of the starter', () => {
    const source = Object.entries(files).filter(([path]) => /\.(ts|vue|html)$/.test(path)).map(([, content]) => content).join('\n');
    expect(source).not.toMatch(/\b(window|document|localStorage|sessionStorage)\b|\bfetch\(/);
    expect(source).not.toMatch(/\bas any\b|:\s*any\b/);
    expect(Object.values(files).join('\n')).not.toMatch(/-----BEGIN .*PRIVATE KEY-----|(?:sk|AKIA)[A-Za-z0-9]{16,}/);
    expect(files['src/api/index.ts']).toContain('uni.request');
    expect(files['src/api/index.ts']).toContain("from './mock'");
    expect(files['README.md']).toContain('不生成 APK / IPA');
    expect(files['README.md']).toContain('assetTarget: null');
  });
});

describe('uniapp generated mock API', () => {
  afterEach(() => vi.useRealTimers());
  const api = evaluate(files['src/api/mock.ts']!) as {
    fetchEntries(): Promise<{ id: string; title: string }[]>;
    fetchEntryById(id: string): Promise<{ id: string; title: string } | null>;
    fetchUserProfile(): Promise<{ nickname: string }>;
  };

  it('provides delayed typed data, detail lookup and a null result for absent IDs', async () => {
    vi.useFakeTimers();
    const pending = api.fetchEntries();
    const complete = vi.fn();
    void pending.then(complete);
    await vi.advanceTimersByTimeAsync(299);
    expect(complete).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    const entries = await pending;
    expect(entries.length).toBeGreaterThan(0);
    const details = api.fetchEntryById(entries[0]!.id);
    const missing = api.fetchEntryById('absent');
    await vi.runAllTimersAsync();
    expect(await details).toEqual(entries[0]);
    expect(await missing).toBeNull();
  });

  it('returns independent copies so consumers cannot mutate the shared mock data', async () => {
    vi.useFakeTimers();
    const first = api.fetchEntries();
    const profile = api.fetchUserProfile();
    await vi.runAllTimersAsync();
    const entries = await first;
    const id = entries[0]!.id;
    entries[0]!.title = 'changed';
    entries.pop();
    (await profile).nickname = 'changed';
    const again = api.fetchEntries();
    const detail = api.fetchEntryById(id);
    const nextProfile = api.fetchUserProfile();
    await vi.runAllTimersAsync();
    expect((await again).length).toBe(entries.length + 1);
    expect((await detail)!.title).not.toBe('changed');
    expect((await nextProfile).nickname).not.toBe('changed');
  });
});

describe('uniapp generated navigation', () => {
  it('encodes detail IDs and recovers from direct detail visits without a back stack', () => {
    const uni = { navigateTo: vi.fn(), navigateBack: vi.fn(), switchTab: vi.fn(), showToast: vi.fn() };
    const navigation = evaluate(files['src/navigation.ts']!, { uni }) as { openEntry(id: string): void; goBack(): void };
    navigation.openEntry('a&b=1');
    expect(uni.navigateTo.mock.calls[0]![0].url).toBe('/pages/detail/index?id=a%26b%3D1');
    uni.navigateTo.mock.calls[0]![0].fail();
    expect(uni.showToast).toHaveBeenCalled();
    navigation.goBack();
    uni.navigateBack.mock.calls[0]![0].fail();
    expect(uni.switchTab).toHaveBeenCalledWith(expect.objectContaining({ url: '/pages/list/index' }));
  });
});
