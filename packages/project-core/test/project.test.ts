import { describe, expect, it } from 'vitest';
import { createProjectPlan, getProjectTemplate, isProjectTemplateId, listProjectTemplates, renderProjectFiles } from '../src/index';

describe('Vue project creation plan', () => {
  it('normalizes feature order and emits the corresponding files', () => {
    const options = { name: 'my-dashboard', template: 'vue-web' as const, features: ['pinia', 'theme', 'router'] as const };
    const plan = createProjectPlan({ ...options, features: [...options.features] });
    expect(plan.options.features).toEqual(['theme', 'router', 'pinia']);
    expect(plan.files).toContain('src/views/Home.vue');
    expect(plan.files).toContain('.forgekit/assets.lock.json');
    expect(renderProjectFiles(plan.options)['src/forgekit/theme.css']).toContain('--fk-brand');
    expect(renderProjectFiles(plan.options)['src/main.ts']).toContain('createPinia');
  });

  it.each(['../oops', 'Bad Name', '-bad', 'foo/boo', 'a'.repeat(61)])('rejects unsafe names: %s', (name) => {
    expect(() => createProjectPlan({ name, template: 'vue-web', features: [] })).toThrow();
  });

  it('refuses unknown features and targets', () => {
    expect(() => createProjectPlan({ name: 'demo', template: 'vue-web', features: ['auth' as 'theme'] })).toThrow();
    expect(() => createProjectPlan({ name: 'demo', template: 'mobile' as 'vue-web', features: [] })).toThrow();
  });
});

describe('project template registry', () => {
  it('lists templates with complete, serializable metadata', () => {
    const templates = listProjectTemplates();
    expect(templates.map((template) => template.id)).toContain('vue-web');
    expect(new Set(templates.map((template) => template.id)).size).toBe(templates.length);
    for (const template of templates) {
      expect(template.name && template.description && template.stack.length && template.targets.length && template.commands.length).toBeTruthy();
      expect(template.defaultFeatures.every((feature) => template.features.some((option) => option.id === feature))).toBe(true);
      expect(JSON.parse(JSON.stringify(template))).toEqual(template);
      expect('render' in template).toBe(false);
    }
  });

  it('returns copies so callers cannot mutate the registry', () => {
    const first = listProjectTemplates()[0]!;
    first.features.length = 0;
    first.defaultFeatures.push('pinia');
    expect(getProjectTemplate(first.id)!.features.length).toBeGreaterThan(0);
    expect(getProjectTemplate(first.id)!.defaultFeatures).not.toContain('pinia');
  });

  it('validates template IDs and per-template features', () => {
    expect(isProjectTemplateId('vue-web')).toBe(true);
    expect(isProjectTemplateId('mobile')).toBe(false);
    expect(isProjectTemplateId(undefined)).toBe(false);
    expect(getProjectTemplate('nope')).toBeUndefined();
    expect(createProjectPlan({ name: 'demo', template: 'vue-web', features: [] }).commands).toEqual(['cd demo', 'pnpm install', 'pnpm dev']);
  });

  it('renders a deterministic, path-safe file set for every template and default feature set', () => {
    for (const template of listProjectTemplates()) {
      const options = { name: 'smoke-app', template: template.id, features: template.defaultFeatures };
      const files = renderProjectFiles(options);
      expect(renderProjectFiles(options)).toEqual(files);
      expect(files['package.json']).toBeDefined();
      expect(JSON.parse(files['package.json']!).scripts.build).toBeTruthy();
      for (const path of Object.keys(files)) {
        expect(path.startsWith('/') || path.split('/').includes('..') || path.includes('\\')).toBe(false);
      }
    }
  });
});

describe('vue-admin template', () => {
  const files = renderProjectFiles({ name: 'ops-console', template: 'vue-admin', features: [] });

  it('substitutes the project name everywhere and leaves no placeholder', () => {
    expect(Object.values(files).some((contents) => contents.includes('__PROJECT_NAME__'))).toBe(false);
    expect(JSON.parse(files['package.json']!).name).toBe('ops-console');
    expect(files['index.html']).toContain('<title>ops-console</title>');
  });

  it('gives each generated project its own browser storage keys', () => {
    const otherFiles = renderProjectFiles({ name: 'other-console', template: 'vue-admin', features: [] });
    for (const key of ['token', 'user', 'dark', 'profile']) {
      expect(files['src/storage.ts']).toContain(`'ops-console:${key}'`);
      expect(otherFiles['src/storage.ts']).toContain(`'other-console:${key}'`);
    }
  });

  it('ships an Element Plus admin with guarded routes and replaceable mock APIs', () => {
    const pkg = JSON.parse(files['package.json']!) as { dependencies: Record<string, string>; scripts: Record<string, string> };
    expect(Object.keys(pkg.dependencies).sort()).toEqual(['@element-plus/icons-vue', 'element-plus', 'pinia', 'vue', 'vue-router']);
    expect(pkg.scripts.build).toBe('vue-tsc --noEmit && vite build');
    expect(files['src/main.ts']).toContain('zhCn');
    expect(files['src/router/index.ts']).toContain('beforeEach');
    for (const view of ['LoginView', 'DashboardView', 'UsersView', 'SettingsView', 'NotFoundView']) {
      expect(files[`src/views/${view}.vue`]).toBeDefined();
    }
    expect(files['src/api/mock.ts']).toContain('export async function fetchUsers');
  });

  it('offers no optional features and rejects others', () => {
    expect(() => createProjectPlan({ name: 'ops', template: 'vue-admin', features: ['theme'] })).toThrow();
    expect(createProjectPlan({ name: 'ops', template: 'vue-admin', features: [] }).files).toContain('src/layouts/AdminLayout.vue');
  });
});

describe('nuxt-site template', () => {
  const files = renderProjectFiles({ name: 'company-blog', template: 'nuxt-site', features: [] });

  it('registers a content site for all registry consumers', () => {
    expect(isProjectTemplateId('nuxt-site')).toBe(true);
    expect(getProjectTemplate('nuxt-site')).toMatchObject({ kind: 'content-site', targets: ['web'], features: [], assetTarget: null });
    expect(() => createProjectPlan({ name: 'site', template: 'nuxt-site', features: ['theme'] })).toThrow();
  });

  it('replaces the project name in package metadata, site config and README', () => {
    expect(JSON.parse(files['package.json']!).name).toBe('company-blog');
    expect(files['nuxt.config.ts']).toContain("siteName: 'company-blog'");
    expect(files['README.md']).toContain('# company-blog');
    expect(Object.values(files).some(contents => contents.includes('__PROJECT_NAME__'))).toBe(false);
    const other = renderProjectFiles({ name: 'other-site', template: 'nuxt-site', features: [] });
    expect(other['nuxt.config.ts']).toContain("siteName: 'other-site'");
  });

  it('ships Nuxt 4 app sources, blog content, SEO and SSR / SSG scripts', () => {
    for (const path of ['app/app.vue', 'app/layouts/default.vue', 'app/pages/index.vue', 'app/pages/about.vue',
      'app/pages/contact.vue', 'app/pages/blog/index.vue', 'app/pages/blog/[slug].vue', 'app/error.vue',
      'app/composables/useBlog.ts', 'content/blog/hello-world.md', 'public/robots.txt', 'server/routes/sitemap.xml.ts', 'tsconfig.json']) {
      expect(files[path], path).toBeDefined();
    }
    const pkg = JSON.parse(files['package.json']!);
    expect(pkg.dependencies).toMatchObject({ nuxt: '^4.1.0', marked: '^16.0.0' });
    expect(pkg.scripts).toMatchObject({ build: 'nuxt typecheck && nuxt build', generate: 'nuxt generate', typecheck: 'nuxt typecheck' });
    expect(files['app/composables/useBlog.ts']).toContain("~~/content/blog/*.md");
    expect(files['app/pages/blog/[slug].vue']).toContain('application/ld+json');
    expect(files['server/routes/sitemap.xml.ts']).toContain('config.blogSlugs.map');
  });
});
