// @vitest-environment jsdom
import { computed, ref } from 'vue';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils';
import { createMemoryHistory, createRouter } from 'vue-router';
import { DomainSchema, DomainOperationSchema, DeployTargetSchema } from '@forgekit/contracts';
import DomainsPage from '../src/views/DomainsPage.vue';
import { listDeployTargets } from '../src/api/deploys';
import { listDomains, listDomainOperations, createDomain, requestDomainOperation } from '../src/api/domains';
import { ProjectApiError } from '../src/api/projects';
vi.mock('../src/api/deploys', () => ({ listDeployTargets: vi.fn() }));
vi.mock('../src/api/domains', async original => ({ ...await original<typeof import('../src/api/domains')>(),
  listDomains: vi.fn(), listDomainOperations: vi.fn(), getDomainOperation: vi.fn(), createDomain: vi.fn(), requestDomainOperation: vi.fn() }));
const access = vi.hoisted(() => ({ role: 'editor' }));
const id = '11111111-1111-4111-8111-111111111111', opId = '22222222-2222-4222-8222-222222222222';
vi.mock('../src/composables/useBuildProjectAccess', () => ({ useBuildProjectAccess: () => ({
  project: ref({ id: '11111111-1111-4111-8111-111111111111', slug: 'site' }), accessVerified: ref(true), error: ref(''), loading: ref(false), canRun: computed(() => access.role === 'editor'),
}) }));
vi.mock('../src/components/domains/DomainLogViewer.vue', () => ({ default: { template: '<pre>安全域名操作日志</pre>', props: ['projectId', 'operationId'] } }));
enableAutoUnmount(afterEach);
const ts = '2026-11-20T00:00:00Z';
const domain = DomainSchema.parse({ id, projectId: id, deployTargetId: id, hostname: 'site.example', status: 'active', tlsMode: 'internal',
  verificationName: '_forgekit-challenge.site.example', verificationValue: 'forgekit-domain=token', verifiedAt: ts, lastCheckedAt: ts,
  certificateExpiresAt: '2026-12-20T00:00:00Z', certificateFingerprint: 'a'.repeat(64), errorCode: null, createdAt: ts, updatedAt: ts });
const op = DomainOperationSchema.parse({ id: opId, projectId: id, domainId: id, deployTargetId: id, status: 'succeeded', action: 'verify', errorCode: null,
  finishedAt: ts, createdAt: ts, updatedAt: ts });
const target = DeployTargetSchema.parse({ id, projectId: id, kind: 'ssh', name: '站点主机', host: '192.0.2.1', port: 22, username: 'deploy',
  hostKey: 'ssh-ed25519 AAAA', basePath: '/srv/site', currentReleaseId: id, retention: 2, createdBy: id, createdAt: ts, updatedAt: ts });
async function render(detail = '') {
  const router = createRouter({ history: createMemoryHistory(), routes: [
    { path: '/projects/:slug/domains/:operationId?', name: 'project-domains', component: DomainsPage },
    { path: '/projects/:slug/deployments', name: 'project-deployments', component: { template: '<div />' } },
  ] });
  await router.push('/projects/site/domains' + detail); await router.isReady();
  const wrapper = mount(DomainsPage, { global: { plugins: [router], stubs: { ElPopconfirm: { template: '<span><slot name="reference" /><button class="confirm" @click="$emit(\'confirm\')">确认移除</button></span>' } } } });
  await flushPromises(); return wrapper;
}
function button(wrapper: Awaited<ReturnType<typeof render>>, text: string) { return wrapper.findAll('button').find(button => button.text() === text)!; }
beforeEach(() => {
  vi.clearAllMocks(); access.role = 'editor'; vi.mocked(listDeployTargets).mockResolvedValue([target]); vi.mocked(listDomains).mockResolvedValue([domain]);
  vi.mocked(listDomainOperations).mockResolvedValue([op]); vi.mocked(createDomain).mockResolvedValue(domain); vi.mocked(requestDomainOperation).mockResolvedValue(op);
});
describe('Chinese domain management', () => {
  it('shows ownership records, certificate trust mode, expiry, fingerprint and operation details', async () => {
    const wrapper = await render('/' + opId);
    for (const value of ['_forgekit-challenge.site.example', 'forgekit-domain=token', '内部 CA', '证书到期', '最近检查', '安全域名操作日志', 'HTTPS 可用']) expect(wrapper.text()).toContain(value);
    expect(wrapper.get('a[href="https://site.example"]').attributes('rel')).toContain('noopener');
  });
  it('validates input, adds to the deployed target, and clears drafts', async () => {
    const wrapper = await render();
    await wrapper.get('input[aria-label="自定义域名"]').setValue('https://bad.example'); await wrapper.get('form').trigger('submit');
    expect(createDomain).not.toHaveBeenCalled(); expect(wrapper.text()).toContain('有效域名');
    await wrapper.get('input[aria-label="自定义域名"]').setValue('NEW.EXAMPLE'); await wrapper.get('form').trigger('submit'); await flushPromises();
    expect(createDomain).toHaveBeenCalledWith(id, { deployTargetId: id, hostname: 'new.example' });
    expect((wrapper.get('input[aria-label="自定义域名"]').element as HTMLInputElement).value).toBe('');
  });
  it.each(['domain_certificate_invalid', 'domain_health_failed'])('does not advertise healthy HTTPS after a failed observation: %s', async errorCode => {
    vi.mocked(listDomains).mockResolvedValue([{ ...domain, status: 'failed', errorCode }]);
    const wrapper = await render();
    expect(wrapper.text()).toContain('操作或检查失败，HTTPS 可用性未确认');
    expect(wrapper.text()).toContain(errorCode);
    expect(wrapper.text()).toContain('继续每日检查');
    expect(wrapper.text()).toContain('证书到期'); expect(wrapper.text()).toContain('a'.repeat(64));
    expect(wrapper.find('a[href="https://site.example"]').exists()).toBe(false);
    expect(wrapper.get('.el-tag').text()).not.toBe('HTTPS 可用');
    expect(button(wrapper, '刷新证书状态').exists()).toBe(true);
  });
  it('requests verification, refresh and confirmed removal and disables concurrent operations', async () => {
    const wrapper = await render(); await button(wrapper, '验证并启用 HTTPS').trigger('click'); await flushPromises();
    expect(requestDomainOperation).toHaveBeenLastCalledWith(id, id, 'verify');
    await button(wrapper, '刷新证书状态').trigger('click'); await flushPromises(); expect(requestDomainOperation).toHaveBeenLastCalledWith(id, id, 'refresh');
    await wrapper.get('button.confirm').trigger('click'); await flushPromises(); expect(requestDomainOperation).toHaveBeenLastCalledWith(id, id, 'remove');
    vi.mocked(listDomainOperations).mockResolvedValue([{ ...op, status: 'running' }]); await button(wrapper, '刷新').trigger('click'); await flushPromises();
    expect(button(wrapper, '验证并启用 HTTPS').attributes('disabled')).toBeDefined();
  });
  it('hides mutations for viewers and clears domain data on access revocation', async () => {
    access.role = 'viewer'; const wrapper = await render();
    expect(wrapper.find('form').exists()).toBe(false); expect(wrapper.findAll('button').map(b => b.text())).not.toContain('验证并启用 HTTPS');
    expect(wrapper.text()).toContain('site.example');
    vi.mocked(listDomains).mockRejectedValueOnce(new ProjectApiError('权限已撤销', 403));
    await button(wrapper, '刷新').trigger('click'); await flushPromises();
    expect(wrapper.text()).not.toContain('site.example'); expect(wrapper.text()).toContain('权限已撤销');
  });
});
