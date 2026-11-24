// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils';
import { createMemoryHistory, createRouter } from 'vue-router';
import type { ProjectRecord } from '@forgekit/contracts';
import { listProjectTemplates } from '@forgekit/project-core';
import ProjectListView from '../src/views/ProjectListView.vue';
import ProjectCreateView from '../src/views/ProjectCreateView.vue';
import ProjectDetailView from '../src/views/ProjectDetailView.vue';
import DesktopPage from '../src/views/DesktopPage.vue';
import { getProject, listProjects } from '../src/api/projects';
import { listProjectAssets } from '../src/api/project-assets';
import { listProjectMembers } from '../src/api/project-members';
import { getTemplateVisual } from '../src/utils/template-visuals';
import { projectFeatureLinks } from '../src/utils/project-features';

vi.mock('../src/api/projects', () => ({ getProject: vi.fn(), listProjects: vi.fn(), saveProject: vi.fn() }));
vi.mock('../src/api/project-assets', () => ({ listProjectAssets: vi.fn(), planProjectAsset: vi.fn(), upgradeProjectAssetPlan: vi.fn() }));
vi.mock('../src/api/project-members', () => ({ listProjectMembers: vi.fn(), updateProjectMemberRole: vi.fn() }));
vi.mock('../src/api/invitations', () => ({ issueInvitation: vi.fn(), listInvitations: vi.fn(), revokeInvitation: vi.fn() }));
enableAutoUnmount(afterEach);
const templates = listProjectTemplates();
const record = (template: string, platforms?: ProjectRecord['platforms']): ProjectRecord => ({
  id: template, slug: 'demo', name: 'demo', template, platforms, features: [], createdAt: '2026-11-22T00:00:00Z',
});
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(listProjectAssets).mockResolvedValue([]);
  vi.mocked(listProjectMembers).mockResolvedValue({ currentRole: 'viewer', members: [] });
});
async function render(view: typeof ProjectListView) {
  const router = createRouter({ history: createMemoryHistory(), routes: [
    ...['/projects', '/projects/new', '/projects/new/beginner'].map(path => ({ path, component: { template: '<div />' } })),
    { path: '/projects/:slug', name: 'project-detail', component: view },
    ...['deployments', 'android', 'weapp', 'alipay', 'desktop', 'variables', 'builds'].map(feature => ({
      path: `/projects/:slug/${feature}`, name: `project-${feature}`, component: { template: '<div />' },
    })),
  ] });
  await router.push('/projects/demo'); await router.isReady();
  const wrapper = mount(view, { global: { plugins: [router] } });
  await flushPromises(); return wrapper;
}

describe('template identity in project pages', () => {
  it('renders every project card and manual template with its own identity', async () => {
    vi.mocked(listProjects).mockResolvedValue(templates.map(t => record(t.id)));
    for (const view of [ProjectListView, ProjectCreateView]) {
      const wrapper = await render(view);
      for (const template of templates) {
        const identity = wrapper.get(`[data-template="${template.id}"]`);
        expect(identity.get('.template-mark').text()).toBe(getTemplateVisual(template.id).icon);
        expect(identity.text()).toContain(view === ProjectListView ? getTemplateVisual(template.id).shortName : template.name);
      }
    }
  });
});

describe('project detail navigation and recommendations', () => {
  it.each(templates.map(t => t.id))('shows relevant links and compatible assets for %s', async template => {
    const project = record(template);
    vi.mocked(getProject).mockResolvedValue(project);
    const wrapper = await render(ProjectDetailView);
    const nav = wrapper.get('nav[aria-label="项目功能"]');
    expect(nav.classes()).toContain('project-feature-nav');
    expect(nav.findAll('a').map(a => a.text())).toEqual(projectFeatureLinks(project).map(link => link.label));
    expect(nav.findAll('a').every(a => a.attributes('href').startsWith('/projects/demo/'))).toBe(true);
    expect(wrapper.get('.template-mark').text()).toBe(getTemplateVisual(template).icon);
    if (template === 'vue-web') expect(wrapper.text()).toContain('登记安装计划');
    else {
      expect(wrapper.text()).toContain('暂无适配该模板的推荐资源');
      expect(wrapper.find('.asset-option-row').exists()).toBe(false);
    }
  });
  it('honors explicitly selected mini-program platforms', async () => {
    vi.mocked(getProject).mockResolvedValue(record('uniapp', ['weapp']));
    const wrapper = await render(ProjectDetailView);
    expect(wrapper.get('nav').text()).toContain('微信上传与预览');
    expect(wrapper.get('nav').text()).not.toContain('Android');
    expect(wrapper.get('nav').text()).not.toContain('支付宝');
    expect(wrapper.get('nav').text()).not.toContain('部署');
  });
});

describe('desktop route', () => {
  it('registers a real page and links the shipped template guide', async () => {
    const { router } = await import('../src/router');
    const route = router.resolve('/projects/demo/desktop');
    expect(route.name).toBe('project-desktop');
    const component = route.matched[0]?.components?.default;
    expect(typeof component).toBe('function');
    if (typeof component === 'function') expect(await component()).toHaveProperty('default', DesktopPage);
    vi.mocked(getProject).mockResolvedValue(record('tauri-desktop'));
    const wrapper = await render(DesktopPage);
    expect(wrapper.text()).toContain('在线桌面打包即将推出');
    expect(wrapper.text()).toContain('pnpm tauri build');
    expect(wrapper.get('a[target="_blank"]').attributes('href')).toContain('tauri-desktop.md');
  });
});
