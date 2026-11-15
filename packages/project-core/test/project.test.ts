import { describe, expect, it } from 'vitest';
import { createProjectPlan, renderProjectFiles } from '../src/index';

describe('Vue project creation plan', () => {
  it('normalizes feature order and emits the corresponding files', () => {
    const options = { name: 'my-dashboard', template: 'vue-web' as const, features: ['pinia', 'theme', 'router'] as const };
    const plan = createProjectPlan({ ...options, features: [...options.features] });
    expect(plan.options.features).toEqual(['theme', 'router', 'pinia']);
    expect(plan.files).toContain('src/views/Home.vue');
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
