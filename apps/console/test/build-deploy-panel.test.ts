// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils';
import { createMemoryHistory, createRouter } from 'vue-router';
import { ElSelect } from 'element-plus';
import { DeployTargetSchema, DeploymentSchema } from '@forgekit/contracts';
import BuildDeployPanel from '../src/components/deploys/BuildDeployPanel.vue';
import { listDeployTargets, triggerDeployment } from '../src/api/deploys';
import { ProjectApiError } from '../src/api/projects';

vi.mock('../src/api/deploys', () => ({ listDeployTargets: vi.fn(), triggerDeployment: vi.fn() }));
enableAutoUnmount(afterEach);
const id = '11111111-1111-4111-8111-111111111111';
const target = DeployTargetSchema.parse({ id, projectId: id, kind: 'ssh', name: '站点主机', host: 'example.com', port: 22,
  username: 'deploy', hostKey: 'ssh-ed25519 AAAA', basePath: '/srv/site', retention: 2, createdBy: id,
  createdAt: '2026-11-20T00:00:00Z', updatedAt: '2026-11-20T00:00:00Z' });
const deployment = DeploymentSchema.parse({ id, projectId: id, buildId: id, environmentId: id, deployTargetId: id,
  status: 'pending', startedAt: null, finishedAt: null, createdAt: '2026-11-20T00:00:00Z', updatedAt: '2026-11-20T00:00:00Z' });

async function render(canManage = true) {
  const router = createRouter({ history: createMemoryHistory(), routes: [
    { path: '/', component: { template: '<div />' } },
    { path: '/projects/:slug/deployments/:deploymentId?', name: 'project-deployments', component: { template: '<div />' } },
  ] });
  await router.push('/'); await router.isReady();
  const wrapper = mount(BuildDeployPanel, { props: { projectId: id, buildId: id, slug: 'site', canManage }, global: { plugins: [router] } });
  return { wrapper, router };
}

beforeEach(() => { vi.clearAllMocks(); vi.mocked(listDeployTargets).mockResolvedValue([]); });

describe('BuildDeployPanel', () => {
  it('keeps an empty selector labelled, disables deploy and links the empty state to target management', async () => {
    const { wrapper, router } = await render(); await flushPromises();
    expect(wrapper.get('h2').text()).toBe('部署到自有 Linux 主机');
    const select = wrapper.getComponent(ElSelect);
    expect(select.props('placeholder')).toBe('选择部署目标');
    expect(select.classes()).toContain('deploy-target-select');
    expect(wrapper.get('label').attributes('for')).toBe(wrapper.get('[role="combobox"]').attributes('id'));
    const deploy = wrapper.get('button');
    expect(deploy.attributes('disabled')).toBeDefined();
    const hintId = deploy.attributes('aria-describedby');
    expect(wrapper.get(`[id="${hintId}"]`).text()).toContain('尚未添加部署目标');
    await deploy.trigger('click'); expect(triggerDeployment).not.toHaveBeenCalled();
    const links = wrapper.findAll('a');
    expect(links.map(link => link.text())).toEqual(['管理部署目标与历史', '添加部署目标']);
    expect(links[0]!.attributes('href')).toBe(links[1]!.attributes('href'));
    await links[1]!.trigger('click'); await flushPromises();
    expect(router.currentRoute.value.fullPath).toBe('/projects/site/deployments');
  });

  it('requires selection before deploying and keeps the target and button in one control row', async () => {
    vi.mocked(listDeployTargets).mockResolvedValue([target]);
    let finish!: () => void;
    vi.mocked(triggerDeployment).mockImplementationOnce(() => new Promise(resolve => { finish = () => resolve(deployment); }));
    const { wrapper, router } = await render(); await flushPromises();
    expect(wrapper.find('.build-panel-empty').exists()).toBe(false);
    const row = wrapper.get('.build-panel-controls');
    expect(row.get('button').attributes('disabled')).toBeDefined();
    wrapper.getComponent(ElSelect).vm.$emit('update:modelValue', id); await flushPromises();
    expect(row.get('button').attributes('disabled')).toBeUndefined();
    await row.get('button').trigger('click');
    expect(triggerDeployment).toHaveBeenCalledWith(id, id, id);
    expect(row.get('button').attributes('disabled')).toBeDefined();
    finish(); await flushPromises();
    expect(router.currentRoute.value.fullPath).toBe(`/projects/site/deployments/${id}`);
  });

  it('shows loading and failure reasons instead of a false empty state', async () => {
    let reject!: (error: Error) => void;
    vi.mocked(listDeployTargets).mockImplementationOnce(() => new Promise((_, fail) => { reject = fail; }));
    const { wrapper } = await render();
    expect(wrapper.get('[role="status"]').text()).toBe('正在加载部署目标…');
    expect(wrapper.find('.build-panel-empty').exists()).toBe(false);
    expect(wrapper.get('button').attributes('disabled')).toBeDefined();
    reject(new ProjectApiError('服务暂不可用', 503)); await flushPromises();
    expect(wrapper.get('[role="alert"]').text()).toContain('服务暂不可用');
    expect(wrapper.find('.build-panel-empty').exists()).toBe(false);
    expect(wrapper.get('button').attributes('disabled')).toBeDefined();
  });

  it('keeps management navigation available to viewers without deployment controls', async () => {
    const { wrapper } = await render(false); await flushPromises();
    expect(wrapper.get('a').text()).toBe('管理部署目标与历史');
    expect(wrapper.findComponent(ElSelect).exists()).toBe(false);
    expect(wrapper.find('button').exists()).toBe(false);
    expect(wrapper.text()).toContain('仅项目所有者和编辑者可发起部署');
  });
});
