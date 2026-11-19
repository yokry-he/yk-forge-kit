import { emptyAssetLock, planAssetInstall } from '@forgekit/asset-core';

export type ProjectFeature = 'theme' | 'router' | 'pinia';

export interface ProjectOptions {
  name: string;
  template: 'vue-web';
  features: ProjectFeature[];
}

export interface ProjectPlan {
  options: ProjectOptions;
  files: string[];
  commands: string[];
}

export class ProjectValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProjectValidationError';
  }
}

const availableFeatures: ProjectFeature[] = ['theme', 'router', 'pinia'];

export function normalizeProjectOptions(input: ProjectOptions): ProjectOptions {
  if (!/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(input.name) || input.name.length > 60) {
    throw new ProjectValidationError('项目名称须为 1–60 位的小写字母、数字及中划线，且以字母开头。');
  }
  if (input.template !== 'vue-web') {
    throw new ProjectValidationError('当前仅支持 Vue Web 模板。');
  }
  if (!Array.isArray(input.features) || input.features.some((feature) => !availableFeatures.includes(feature))) {
    throw new ProjectValidationError('包含不支持的项目能力。');
  }
  return { name: input.name, template: input.template, features: availableFeatures.filter((f) => input.features.includes(f)) };
}

export function createProjectPlan(input: ProjectOptions): ProjectPlan {
  const options = normalizeProjectOptions(input);
  return {
    options,
    files: Object.keys(renderProjectFiles(options)).sort(),
    commands: [`cd ${options.name}`, 'pnpm install', 'pnpm dev'],
  };
}

/** Pure renderer. Path validation and disk writes belong to the CLI adapter. */
export function renderProjectFiles(input: ProjectOptions): Record<string, string> {
  const options = normalizeProjectOptions(input);
  const enabled = new Set(options.features);
  const dependencies: Record<string, string> = { vue: '^3.5.0' };
  if (enabled.has('router')) dependencies['vue-router'] = '^4.5.0';
  if (enabled.has('pinia')) dependencies.pinia = '^3.0.0';

  const mainImports = [`import { createApp } from 'vue'`, `import App from './App.vue'`, `import './style.css'`];
  if (enabled.has('router')) mainImports.push(`import router from './router'`);
  if (enabled.has('pinia')) mainImports.push(`import { createPinia } from 'pinia'`);
  const mainLines = [...mainImports, '', 'const app = createApp(App)'];
  if (enabled.has('pinia')) mainLines.push('app.use(createPinia())');
  if (enabled.has('router')) mainLines.push('app.use(router)');
  mainLines.push("app.mount('#app')", '');

  const files: Record<string, string> = {
    'package.json': JSON.stringify({ name: options.name, version: '0.1.0', private: true, type: 'module', packageManager: 'pnpm@10.18.3', scripts: { dev: 'vite', build: 'vue-tsc --noEmit && vite build', preview: 'vite preview' }, dependencies, devDependencies: { '@vitejs/plugin-vue': '^6.0.0', typescript: '^5.9.0', vite: '^7.0.0', 'vue-tsc': '^3.0.0' } }, null, 2) + '\n',
    'index.html': `<!doctype html>\n<html lang="zh-CN"><head><meta charset="UTF-8" /><meta name="viewport" content="width=device-width, initial-scale=1.0" /><title>${options.name}</title></head><body><div id="app"></div><script type="module" src="/src/main.ts"></script></body></html>\n`,
    'vite.config.ts': `import { defineConfig } from 'vite'\nimport vue from '@vitejs/plugin-vue'\n\nexport default defineConfig({ plugins: [vue()] })\n`,
    'tsconfig.json': JSON.stringify({ compilerOptions: { target: 'ES2022', module: 'ESNext', moduleResolution: 'Bundler', strict: true, skipLibCheck: true, lib: ['ES2022', 'DOM', 'DOM.Iterable'], types: ['vite/client'], jsx: 'preserve' }, include: ['src/**/*.ts', 'src/**/*.vue', 'vite.config.ts'] }, null, 2) + '\n',
    'src/main.ts': mainLines.join('\n'),
    'src/App.vue': enabled.has('router') ? `<template>\n  <main class="app"><router-view /></main>\n</template>\n` : `<template>\n  <main class="app"><h1>${options.name}</h1><p>项目创建成功，开始构建你的应用吧。</p></main>\n</template>\n`,
    'src/style.css': `:root { font-family: system-ui, sans-serif; } body { margin: 0; } .app { max-width: 960px; margin: 10vh auto; padding: 24px; }\n`,
    'README.md': `# ${options.name}\n\n由 YKForgeKit 创建的 Vue 3 + Vite 项目。\n\n## 开始\n\n\`\`\`bash\npnpm install\npnpm dev\n\`\`\`\n\n已启用能力：${options.features.length ? options.features.join('、') : '无'}。\n`,
    '.gitignore': `node_modules/\ndist/\n.env.local\n`,
  };
  if (enabled.has('router')) {
    files['src/router.ts'] = `import { createRouter, createWebHistory } from 'vue-router'\nimport Home from './views/Home.vue'\n\nexport default createRouter({ history: createWebHistory(), routes: [{ path: '/', component: Home }] })\n`;
    files['src/views/Home.vue'] = `<template>\n  <section><h1>${options.name}</h1><p>欢迎使用 YKForgeKit 创建的项目。</p></section>\n</template>\n`;
  }
  if (enabled.has('theme')) {
    const plan = planAssetInstall('official.theme', 'vue-web', {
      'src/style.css': files['src/style.css'] ?? null,
      'src/forgekit/theme.css': null,
    }, emptyAssetLock());
    for (const change of plan.changes) {
      if (change.after === null) throw new Error('项目创建过程不允许资产删除操作。');
      files[change.path] = change.after;
    }
    files['.forgekit/assets.lock.json'] = JSON.stringify(plan.lock, null, 2) + '\n';
  }
  return files;
}
