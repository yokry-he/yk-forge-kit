// @vitest-environment jsdom
import { ref } from 'vue';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils';
import { createMemoryHistory, createRouter } from 'vue-router';
import type { Domain, DeployTarget, RuntimeLogSession } from '@forgekit/contracts';
import RuntimeLogsPage from '../src/views/RuntimeLogsPage.vue';
import { listDomains } from '../src/api/domains';
import { listDeployTargets } from '../src/api/deploys';
import { createRuntimeSession, cancelRuntimeSession } from '../src/api/runtime-logs';
import { ProjectApiError } from '../src/api/projects';
vi.mock('../src/api/domains', () => ({ listDomains: vi.fn() }));
vi.mock('../src/api/deploys', () => ({ listDeployTargets: vi.fn() }));
vi.mock('../src/api/runtime-logs', () => ({ createRuntimeSession: vi.fn(), cancelRuntimeSession: vi.fn() }));
vi.mock('../src/composables/useBuildProjectAccess', () => ({ useBuildProjectAccess: () => ({
  project: ref({ id: '11111111-1111-4111-8111-111111111111', slug: 'site' }), accessVerified: ref(true), error: ref(''), loading: ref(false), canRun: ref(false),
}) }));
vi.mock('../src/components/runtime/RuntimeLogViewer.vue', () => ({ default: { template: '<pre>安全运行日志</pre>', props: ['projectId', 'sessionId'] } }));
enableAutoUnmount(afterEach);
const id = '11111111-1111-4111-8111-111111111111';
const session: RuntimeLogSession = { id, projectId: id, domainId: id, deployTargetId: id, source: 'caddy-access', status: 'pending', errorCode: null,
  createdAt: '2026-11-21T00:00:00Z', expiresAt: '2026-11-21T00:01:00Z' };
async function render() {
  const router = createRouter({ history: createMemoryHistory(), routes: [
    { path: '/projects/:slug/runtime-logs', name: 'project-runtime-logs', component: RuntimeLogsPage },
    { path: '/projects/:slug/domains', name: 'project-domains', component: { template: '<div />' } },
  ] });
  await router.push('/projects/site/runtime-logs'); await router.isReady();
  const wrapper = mount(RuntimeLogsPage, { global: { plugins: [router] } }); await flushPromises(); return wrapper;
}
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(listDomains).mockResolvedValue([{ id, deployTargetId: id, hostname: 'site.example', status: 'active', verifiedAt: '2026-11-21T00:00:00Z' } as Domain]);
  vi.mocked(listDeployTargets).mockResolvedValue([{ id, name: '站点主机' } as DeployTarget]);
  vi.mocked(createRuntimeSession).mockResolvedValue(session); vi.mocked(cancelRuntimeSession).mockResolvedValue(undefined);
});
describe('runtime logs read-only console', () => {
  it('lets a viewer select the site and start a bounded session with filters, then replace it', async () => {
    const wrapper = await render();
    expect(wrapper.text()).toContain('运行日志'); expect(wrapper.text()).toContain('60 秒');
    await wrapper.get('input[aria-label="关键词"]').setValue('.*$(id)');
    await wrapper.get('form').trigger('submit'); await flushPromises();
    expect(createRuntimeSession).toHaveBeenCalledWith(id, { domainId: id, source: 'caddy-access', lines: 200, level: 'all', windowMinutes: 0, keyword: '.*$(id)' });
    expect(wrapper.text()).toContain('安全运行日志');
    await wrapper.get('form').trigger('submit'); await flushPromises(); expect(cancelRuntimeSession).toHaveBeenCalledWith(id, id);
  });
  it('clears tails and site details on access revocation', async () => {
    const wrapper = await render();
    vi.mocked(createRuntimeSession).mockRejectedValueOnce(new ProjectApiError('权限已撤销', 403));
    await wrapper.get('form').trigger('submit'); await flushPromises();
    expect(wrapper.find('form').exists()).toBe(false); expect(wrapper.text()).not.toContain('安全运行日志'); expect(wrapper.text()).toContain('权限已失效');
  });
  it('shows the empty state and disables starting without a verified site', async () => {
    vi.mocked(listDomains).mockResolvedValueOnce([]); const wrapper = await render();
    expect(wrapper.text()).toContain('暂无可查看的站点'); expect(wrapper.get('button[type="submit"]').attributes('disabled')).toBeDefined();
    await wrapper.get('form').trigger('submit'); expect(createRuntimeSession).not.toHaveBeenCalled();
  });
});
