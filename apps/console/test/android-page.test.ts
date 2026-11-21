// @vitest-environment jsdom
import { computed, ref } from 'vue';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils';
import { createMemoryHistory, createRouter } from 'vue-router';
import AndroidPage from '../src/views/AndroidPage.vue';
import { getAndroidConfig, saveAndroidConfig, listAndroidJobs, triggerAndroidJob, downloadAndroidArtifact } from '../src/api/android';
import { ProjectApiError } from '../src/api/projects';
vi.mock('../src/api/android', () => ({ getAndroidConfig: vi.fn(), saveAndroidConfig: vi.fn(), removeAndroidConfig: vi.fn(), cancelAndroidJob: vi.fn(), listAndroidJobs: vi.fn(), triggerAndroidJob: vi.fn(), downloadAndroidArtifact: vi.fn(), androidStatusText: { queued: '排队中', succeeded: '成功' } }));
const access = vi.hoisted(() => ({ role: 'editor' }));
vi.mock('../src/composables/useBuildProjectAccess', () => ({ useBuildProjectAccess: () => ({
  project: ref({ id: '11111111-1111-4111-8111-111111111111', slug: 'site', template: 'uniapp' }), accessVerified: ref(true), error: ref(''), loading: ref(false), canRun: computed(() => access.role === 'editor'),
}) }));
enableAutoUnmount(afterEach);
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });
const id = '11111111-1111-4111-8111-111111111111';
const settings = { packageName: 'com.example.demo', appId: '__UNI__TEST123', appKey: 'synthetic-appkey', versionName: '1.0.0', versionCode: 1 };
const config = { projectId: id, settings, hasSigning: true, updatedAt: '2026-11-22T00:00:00Z', updatedBy: id };
const job = { id, projectId: id, settings, input: { buildType: 'release', kind: 'apk' }, status: 'succeeded', createdAt: config.updatedAt, artifact: { kind: 'apk', size: 5, sha256: 'a'.repeat(64) } };
async function render(withJob = false) {
  const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/projects/:slug/android/:jobId?', name: 'project-android', component: AndroidPage }, { path: '/projects/:slug', component: { template: '<div />' } }] });
  await router.push('/projects/site/android' + (withJob ? '/' + id : '')); await router.isReady();
  const wrapper = mount(AndroidPage, { global: { plugins: [router], stubs: {
    ElSelect: { props: ['modelValue'], emits: ['update:modelValue'], template: '<select :aria-label="$attrs[\'aria-label\']" :value="modelValue" @change="$emit(\'update:modelValue\', $event.target.value)"><slot /></select>' },
    ElOption: { props: ['value', 'label'], template: '<option :value="value">{{ label }}</option>' },
    AndroidLogViewer: { template: '<div>日志</div>' },
  } } }); await flushPromises(); return wrapper;
}
beforeEach(() => {
  vi.clearAllMocks(); access.role = 'editor';
  vi.mocked(getAndroidConfig).mockResolvedValue(config); vi.mocked(listAndroidJobs).mockResolvedValue([job] as never);

  vi.mocked(saveAndroidConfig).mockResolvedValue(config); vi.mocked(triggerAndroidJob).mockResolvedValue({ ...job, status: 'queued' } as never);
  vi.mocked(downloadAndroidArtifact).mockResolvedValue(new Blob(['test'], { type: 'application/octet-stream' }));
  URL.createObjectURL = vi.fn(() => 'blob:test-qr'); URL.revokeObjectURL = vi.fn();
});
describe('B18 Android console', () => {
  it('shows signing status without values and saves settings without reading the old key', async () => {
    const wrapper = await render(); expect(wrapper.text()).toContain('已配置（仅可替换）');
    expect((wrapper.get('input[aria-label="Keystore 密码"]').element as HTMLInputElement).value).toBe('');
    await wrapper.findAll('form')[0]!.trigger('submit'); await flushPromises();
    expect(saveAndroidConfig).toHaveBeenCalledWith(id, settings);
    expect(wrapper.text()).toContain('DCloud AppKey（会写入安装包）');
  });
  it('uploads/replaces signing as base64 and clears all signing inputs before save completes', async () => {
    const wrapper = await render(); const file = new File(['synthetic-key'], 'release.jks');
    Object.defineProperty(file, 'arrayBuffer', { value: async () => new TextEncoder().encode('synthetic-key').buffer });
    const node = wrapper.get('input[type="file"]'); Object.defineProperty(node.element, 'files', { value: [file], configurable: true });
    await node.trigger('change'); await flushPromises();
    await wrapper.get('input[aria-label="密钥别名"]').setValue('release');
    await wrapper.get('input[aria-label="Keystore 密码"]').setValue('store-password');
    await wrapper.get('input[aria-label="密钥密码"]').setValue('key-password');
    await wrapper.findAll('form')[0]!.trigger('submit'); await flushPromises();
    expect(saveAndroidConfig).toHaveBeenCalledWith(id, { ...settings, signing: { keystore: btoa('synthetic-key'), alias: 'release', storePassword: 'store-password', keyPassword: 'key-password' } });
    expect((wrapper.get('input[aria-label="Keystore 密码"]').element as HTMLInputElement).value).toBe('');
    expect((wrapper.get('input[aria-label="密钥密码"]').element as HTMLInputElement).value).toBe('');
  });
  it('creates debug jobs with no signing payload and displays checksum/version/kind details', async () => {
    const wrapper = await render(true); expect(wrapper.text()).toContain('SHA-256：' + 'a'.repeat(64));
    expect(wrapper.text()).toContain('com.example.demo · 1.0.0 (1) · release · APK');
    await wrapper.findAll('form')[1]!.trigger('submit'); await flushPromises();
    expect(triggerAndroidJob).toHaveBeenCalledWith(id, { buildType: 'debug', kind: 'apk' });
  });
  it('verifies download checksums and refuses mismatched binaries', async () => {
    const wrapper = await render(true);
    vi.stubGlobal('crypto', { subtle: { digest: vi.fn().mockResolvedValue(new Uint8Array(32).fill(0xaa).buffer) } });
    vi.mocked(downloadAndroidArtifact).mockResolvedValue({ arrayBuffer: async () => new ArrayBuffer(5) } as Blob);
    const clicked = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    const button = wrapper.findAll('button').find(node => node.text() === '校验并下载安装包')!;
    await button.trigger('click'); await flushPromises();
    expect(downloadAndroidArtifact).toHaveBeenCalledWith(id, id); expect(clicked).toHaveBeenCalledOnce();
    clicked.mockClear(); vi.mocked(crypto.subtle.digest).mockResolvedValue(new Uint8Array(32).buffer);
    await button.trigger('click'); await flushPromises();
    expect(clicked).not.toHaveBeenCalled(); expect(wrapper.text()).toContain('安装包校验失败');
  });
  it('disables viewer writes and clears sensitive data on access revocation', async () => {
    access.role = 'viewer'; const wrapper = await render(true);
    for (const label of ['保存配置', '开始打包', '删除配置与签名']) expect(wrapper.findAll('button').find(n => n.text() === label)?.attributes('disabled')).toBeDefined();
    vi.mocked(getAndroidConfig).mockRejectedValueOnce(new ProjectApiError('revoked', 403));
    await wrapper.findAll('button').find(node => node.text() === '刷新')!.trigger('click'); await flushPromises();
    expect(wrapper.text()).not.toContain(settings.packageName); expect(wrapper.text()).not.toContain('SHA-256');
  });
});
