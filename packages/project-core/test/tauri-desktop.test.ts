import { readFileSync } from 'node:fs';
import { ModuleKind, ScriptTarget, transpileModule } from 'typescript';
import { describe, expect, it, vi } from 'vitest';
import { createProjectPlan, getProjectTemplate, isProjectTemplateId, listProjectTemplates, renderProjectFiles } from '../src/index';

const options = { name: 'my-desktop', template: 'tauri-desktop' as const, features: [] };
const files = renderProjectFiles(options);
const config = JSON.parse(files['src-tauri/tauri.conf.json']!);
const pkg = JSON.parse(files['package.json']!);

describe('tauri-desktop generated project', () => {
  it('registers a desktop template for the console, API and CLI', () => {
    expect(isProjectTemplateId('tauri-desktop')).toBe(true);
    expect(listProjectTemplates().map(template => template.id)).toContain('tauri-desktop');
    expect(getProjectTemplate('tauri-desktop')).toMatchObject({
      kind: 'desktop', targets: ['desktop'], features: [], defaultFeatures: [], assetTarget: null,
      build: { script: 'build', outputDirectory: 'dist' },
    });
    const plan = createProjectPlan(options);
    expect(plan.commands).toEqual(['cd my-desktop', 'pnpm install', 'pnpm tauri dev']);
    expect(() => createProjectPlan({ ...options, features: ['router'] })).toThrow();
  });

  it('renders a complete, deterministic project with project-specific names', () => {
    expect(renderProjectFiles(options)).toEqual(files);
    for (const path of ['package.json', 'index.html', 'tsconfig.json', 'vite.config.ts', 'src/main.ts', 'src/App.vue',
      'src/layouts/AppShell.vue', 'src/views/HomeView.vue', 'src/views/SettingsView.vue', 'src/composables/useGreet.ts',
      'src/styles.css', 'src-tauri/Cargo.toml', 'src-tauri/build.rs', 'src-tauri/src/main.rs', 'src-tauri/src/lib.rs',
      'src-tauri/tauri.conf.json', 'src-tauri/capabilities/main.json', 'src-tauri/app-icon.svg',
      'src-tauri/updater.example.json', '.github/workflows/release-desktop.yml', 'docs/updater.md', 'README.md', 'LICENSE']) {
      expect(files[path], path).toBeTruthy();
      expect(createProjectPlan(options).files).toContain(path);
    }
    expect(Object.values(files).join('')).not.toContain('__PROJECT_NAME__');
    expect(pkg).toMatchObject({ name: 'my-desktop', license: 'Apache-2.0', private: true });
    expect(config).toMatchObject({ productName: 'my-desktop', identifier: 'com.example.my-desktop', version: '../package.json' });
    expect(config.app.windows).toEqual([expect.objectContaining({ label: 'main', title: 'my-desktop', url: 'index.html' })]);
    expect(files['src-tauri/Cargo.toml']).toContain('name = "my-desktop"');
    expect(files['src-tauri/Cargo.toml']).toContain('license = "Apache-2.0"');
    const other = renderProjectFiles({ ...options, name: 'other-desktop' });
    expect(JSON.parse(other['src-tauri/tauri.conf.json']!).identifier).toBe('com.example.other-desktop');
    expect(other['src/views/SettingsView.vue']).toContain("'other-desktop:displayName'");
  });

  it('pins frontend and native dependencies and includes a strict production build', () => {
    for (const version of Object.values({ ...pkg.dependencies, ...pkg.devDependencies })) {
      expect(version).toMatch(/^\d+\.\d+\.\d+$/);
    }
    expect(pkg.devDependencies.vite).toBe('8.3.8');
    expect(pkg.scripts.build).toBe('vue-tsc --noEmit && vite build');
    expect(JSON.parse(files['tsconfig.json']!).compilerOptions.strict).toBe(true);
    expect(files['src-tauri/Cargo.toml']).toContain('version = "=2.12.7"');
    expect(files['src-tauri/Cargo.toml']).toContain('version = "=2.7.6"');
    expect(config.build.beforeDevCommand).toBe('pnpm icons && pnpm dev');
    expect(config.build.beforeBuildCommand).toBe('pnpm icons && pnpm build');
    expect(pkg.scripts.icons).toBe('tauri icon src-tauri/app-icon.svg');
  });

  it('grants only greet to the local main window, enrolling commands in the ACL', () => {
    expect(config.app.withGlobalTauri).toBe(false);
    expect(config.app.security.capabilities).toEqual(['main']);
    const capability = JSON.parse(files['src-tauri/capabilities/main.json']!);
    expect(capability).toMatchObject({ identifier: 'main', local: true, windows: ['main'], permissions: ['allow-greet'] });
    expect(capability.remote).toBeUndefined();
    expect(files['src-tauri/build.rs']).toContain('AppManifest::new().commands(&["greet"])');
    expect(files['src-tauri/src/lib.rs']).toContain('tauri::generate_handler![greet]');
    expect(files['src-tauri/src/lib.rs']).toContain('name.chars().count() > 80');
  });

  it('restricts CSP to bundled resources and IPC, with localhost-only development', () => {
    const security = config.app.security;
    expect(security.csp).toContain("default-src 'none'");
    for (const directive of ["script-src 'self'", "style-src 'self'", "object-src 'none'", "base-uri 'none'", "form-action 'none'", "frame-src 'none'"]) {
      expect(security.csp.split('; ')).toContain(directive);
    }
    expect(security.csp).not.toMatch(/unsafe-|\*|https:|wss:|data:|blob:/);
    expect(security.csp).toContain('connect-src ipc: http://ipc.localhost');
    expect(security.devCsp).toContain('ws://127.0.0.1:1420');
    expect(security.dangerousDisableAssetCspModification).toBeUndefined();
    expect(config.build.devUrl).toBe('http://127.0.0.1:1420');
    expect(config.app.windows.every((window: { url: string }) => !window.url.includes('://'))).toBe(true);
    expect(files['vite.config.ts']).toContain("host: '127.0.0.1'");
    expect(files['vite.config.ts']).toContain('strictPort: true');
    expect(files['vite.config.ts']).toContain('cors: false');
    expect(files['vite.config.ts']).toContain("fs: { strict: true, allow: ['.'] }");
    const frontend = Object.entries(files).filter(([path]) => path.startsWith('src/')).map(([, content]) => content).join('');
    expect(frontend).not.toMatch(/https?:\/\/|fetch\(|v-html/);
  });

  it('ships no active updater, endpoints, tray or placeholder private keys', () => {
    expect(config.bundle.createUpdaterArtifacts).toBe(false);
    expect(config.plugins).toEqual({});
    expect(config.app.trayIcon).toBeUndefined();
    expect(Object.keys({ ...pkg.dependencies, ...pkg.devDependencies }).some(key => key.includes('updater'))).toBe(false);
    expect(files['src-tauri/Cargo.toml']).not.toMatch(/updater|tray-icon/);
    expect(files['src-tauri/src/lib.rs']).not.toMatch(/updater|TrayIcon/);
    expect(JSON.parse(files['src-tauri/updater.example.json']!)).toMatchObject({ plugins: { updater: { endpoints: [], pubkey: '' } } });
    expect(files['src/views/SettingsView.vue']).toContain('未启用');
    expect(files['src/views/SettingsView.vue']).not.toContain('checkbox');
    expect(Object.values(files).join('')).not.toMatch(/BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY/);
  });

  it('carries installer matrix workflow as a generated file, separate from repository CI', () => {
    const workflow = files['.github/workflows/release-desktop.yml']!;
    for (const value of ['workflow_dispatch:', 'matrix:', 'windows-latest', 'aarch64-apple-darwin', 'x86_64-apple-darwin',
      'msi,nsis', 'app,dmg', 'actions/upload-artifact@v4', 'contents: read', 'tar -czf']) {
      expect(workflow).toContain(value);
    }
    const ci = readFileSync(new URL('../../../.github/workflows/ci.yml', import.meta.url), 'utf8');
    expect(ci).toContain('template-smoke:');
    expect(ci).toContain('create desktop-check --template tauri-desktop');
    expect(ci).toContain('libwebkit2gtk-4.1-dev');
    expect(ci).toContain('cargo check --manifest-path src-tauri/Cargo.toml');
    expect(ci).not.toMatch(/^  (?:build-desktop|release-desktop):/m);
    expect(ci).not.toContain('pnpm tauri build');
  });
});

/** Exercise the generated adapter itself, mocking only the native API boundary. */
function loadGreet(desktop: boolean) {
  const invoke = vi.fn<(command: string, args: { name: string }) => Promise<string>>().mockResolvedValue('来自 Rust 的问候');
  const exports: Record<string, unknown> = {};
  const js = transpileModule(files['src/composables/useGreet.ts']!, {
    compilerOptions: { target: ScriptTarget.ES2022, module: ModuleKind.CommonJS },
  }).outputText;
  new Function('require', 'exports', js)(() => ({ invoke, isTauri: () => desktop }), exports);
  const useGreet = exports.useGreet as () => { callGreet(name: string): Promise<string> };
  return { invoke, ...useGreet() };
}

describe('tauri-desktop generated IPC adapter', () => {
  it('makes a typed desktop call with trimmed input', async () => {
    const { invoke, callGreet } = loadGreet(true);
    expect(await callGreet(' 张三 ')).toBe('来自 Rust 的问候');
    expect(invoke).toHaveBeenCalledWith('greet', { name: '张三' });
  });

  it('provides an explicit browser preview without invoking native commands', async () => {
    const { invoke, callGreet } = loadGreet(false);
    expect(await callGreet('张三')).toContain('本地预览模式');
    expect(invoke).not.toHaveBeenCalled();
  });

  it('validates input before calling IPC and preserves Unicode character limits', async () => {
    const { invoke, callGreet } = loadGreet(true);
    for (const name of ['', '  ', '文'.repeat(81)]) await expect(callGreet(name)).rejects.toThrow('1–80');
    expect(invoke).not.toHaveBeenCalled();
    await expect(callGreet('😀'.repeat(80))).resolves.toBe('来自 Rust 的问候');
  });

  it('propagates native errors for the page to display', async () => {
    const { invoke, callGreet } = loadGreet(true);
    invoke.mockRejectedValueOnce(new Error('permission denied'));
    await expect(callGreet('张三')).rejects.toThrow('permission denied');
    expect(files['src/views/HomeView.vue']).toContain('finally');
    expect(files['src/views/HomeView.vue']).toContain('role="alert"');
  });
});
