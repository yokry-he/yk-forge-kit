// @vitest-environment jsdom
import { computed, ref } from 'vue';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils';
import { createMemoryHistory, createRouter } from 'vue-router';
import WeappPage from '../src/views/WeappPage.vue';
import { getWeappConfig, saveWeappConfig, listWeappJobs, triggerWeappJob, getWeappQr } from '../src/api/weapp';
import { listBuilds } from '../src/api/builds';
import { ProjectApiError } from '../src/api/projects';
vi.mock('../src/api/weapp', () => ({ getWeappConfig: vi.fn(), saveWeappConfig: vi.fn(), removeWeappConfig: vi.fn(), listWeappJobs: vi.fn(), triggerWeappJob: vi.fn(), getWeappQr: vi.fn(), weappStatusText: { queued: '排队中', succeeded: '成功' } }));
vi.mock('../src/api/builds', () => ({ listBuilds: vi.fn(), triggerBuild: vi.fn() }));
const access = vi.hoisted(() => ({ role: 'editor' }));
vi.mock('../src/composables/useBuildProjectAccess', () => ({ useBuildProjectAccess: () => ({
  project: ref({ id: '11111111-1111-4111-8111-111111111111', slug: 'site', template: 'uniapp' }), accessVerified: ref(true), error: ref(''), loading: ref(false), canRun: computed(() => access.role === 'editor'),
}) }));
enableAutoUnmount(afterEach);
const id = '11111111-1111-4111-8111-111111111111';
const config = { projectId: id, appId: 'wx0000000000000000', hasPrivateKey: true, ipWhitelistNote: 'operator egress IPs', updatedAt: '2026-11-22T00:00:00Z', updatedBy: id };
const job = { id, projectId: id, buildId: id, input: { buildId: id, version: '1.0.0', action: 'upload_preview' }, status: 'succeeded', createdAt: config.updatedAt, hasQrCode: true };
async function render(withJob = false) {
  const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/projects/:slug/weapp/:jobId?', name: 'project-weapp', component: WeappPage }, { path: '/projects/:slug', component: { template: '<div />' } }] });
  await router.push('/projects/site/weapp' + (withJob ? '/' + id : '')); await router.isReady();
  const wrapper = mount(WeappPage, { global: { plugins: [router], stubs: {
    ElSelect: { props: ['modelValue'], emits: ['update:modelValue'], template: '<select :aria-label="$attrs[\'aria-label\']" :value="modelValue" @change="$emit(\'update:modelValue\', $event.target.value)"><slot /></select>' },
    ElOption: { props: ['value', 'label'], template: '<option :value="value">{{ label }}</option>' },
    WeappLogViewer: { template: '<div>日志</div>' },
  } } }); await flushPromises(); return wrapper;
}
beforeEach(() => {
  vi.clearAllMocks(); access.role = 'editor';
  vi.mocked(getWeappConfig).mockResolvedValue(config); vi.mocked(listWeappJobs).mockResolvedValue([job] as never);
  vi.mocked(listBuilds).mockResolvedValue([{ id, projectId: id, target: 'mp-weixin', status: 'succeeded', artifactKey: 'key', number: 1 }, { id: 'h5', target: 'h5', status: 'succeeded', artifactKey: 'key', number: 2 }] as never);
  vi.mocked(saveWeappConfig).mockResolvedValue(config); vi.mocked(triggerWeappJob).mockResolvedValue({ ...job, status: 'queued' } as never);
  vi.mocked(getWeappQr).mockResolvedValue(new Blob(['test'], { type: 'image/jpeg' }));
  URL.createObjectURL = vi.fn(() => 'blob:test-qr'); URL.revokeObjectURL = vi.fn();
});
describe('B17 console', () => {
  it('keeps the key write-only and clears it before the save resolves', async () => {
    const wrapper = await render(); expect(wrapper.text()).toContain('仅可替换');
    const input = wrapper.get('textarea[aria-label="上传私钥"]'); expect((input.element as HTMLTextAreaElement).value).toBe('');
    await input.setValue('synthetic-key'.repeat(10)); await wrapper.findAll('form')[0]!.trigger('submit'); await flushPromises();
    expect(saveWeappConfig).toHaveBeenCalledWith(id, expect.objectContaining({ privateKey: 'synthetic-key'.repeat(10) }));
    expect((input.element as HTMLTextAreaElement).value).toBe('');
  });
  it('offers only successful mini-program artifacts and creates a dev job', async () => {
    const wrapper = await render(); expect(wrapper.get('select[aria-label="成功构建"]').findAll('option')).toHaveLength(1);
    await wrapper.findAll('form')[1]!.trigger('submit'); await flushPromises();
    expect(triggerWeappJob).toHaveBeenCalledWith(id, expect.objectContaining({ buildId: id, target: 'dev', action: 'upload_preview', robot: 1 }));
  });
  it('shows QR with authenticated fetch and revokes the blob URL on unmount', async () => {
    const wrapper = await render(true); expect(getWeappQr).toHaveBeenCalledWith(id, id);
    expect(wrapper.get('img').attributes('src')).toBe('blob:test-qr'); wrapper.unmount(); expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:test-qr');
  });
  it('hides mutations from viewers and clears sensitive views on access revocation', async () => {
    access.role = 'viewer'; const wrapper = await render(true); expect(wrapper.find('form').exists()).toBe(false);
    vi.mocked(getWeappConfig).mockRejectedValueOnce(new ProjectApiError('revoked', 403));
    await wrapper.findAll('button').find(node => node.text() === '刷新')!.trigger('click'); await flushPromises();
    expect(wrapper.find('img').exists()).toBe(false); expect(wrapper.text()).not.toContain('operator egress IPs');
  });
});
