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
