import { describe, expect, it } from 'vitest';
import { listProjectTemplates } from '@forgekit/project-core';
import { getTemplateVisual } from '../src/utils/template-visuals';
import { projectFeatureLinks } from '../src/utils/project-features';

describe('template identity', () => {
  it('covers every registered template with official names and distinct icons, colors and short names', () => {
    const templates = listProjectTemplates();
    const visuals = templates.map(t => getTemplateVisual(t.id));
    expect(visuals.map(v => v.label)).toEqual(templates.map(t => t.name));
    for (const key of ['icon', 'color', 'shortName'] as const) expect(new Set(visuals.map(v => v[key])).size).toBe(templates.length);
    expect(getTemplateVisual('uniapp').shortName).toBe('uni-app');
    expect(getTemplateVisual('tauri-desktop').shortName).toBe('Tauri');
  });
  it('keeps unknown persisted templates neutral', () => {
    expect(getTemplateVisual('legacy')).toMatchObject({ label: 'legacy', shortName: 'legacy', icon: '◇' });
  });
});

describe('project feature navigation', () => {
  const routes = (template: string, platforms?: Parameters<typeof projectFeatureLinks>[0]['platforms']) => projectFeatureLinks({ template, platforms }).map(link => link.route);
  it.each(['vue-web', 'vue-admin', 'nuxt-site'])('shows web features for %s', template => {
    expect(routes(template)).toEqual(['project-deployments', 'project-variables', 'project-builds']);
  });
  it('uses selected uni-app platforms and preserves legacy template capabilities', () => {
    expect(routes('uniapp', ['weapp'])).toEqual(['project-weapp', 'project-variables', 'project-builds']);
    expect(routes('uniapp', ['web', 'alipay', 'android'])).toEqual(['project-deployments', 'project-android', 'project-alipay', 'project-variables', 'project-builds']);
    expect(routes('uniapp')).toContain('project-weapp');
    expect(routes('uniapp')).toContain('project-android');
    expect(routes('uniapp', null)).toContain('project-alipay');
  });
  it('provides a desktop entry without web or mobile packaging links', () => {
    expect(routes('tauri-desktop')).toEqual(['project-desktop', 'project-variables', 'project-builds']);
  });
});
