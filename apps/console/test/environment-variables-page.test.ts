// @vitest-environment jsdom
import { computed, ref } from 'vue';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils';
import { createMemoryHistory, createRouter } from 'vue-router';
import EnvironmentVariablesPage from '../src/views/EnvironmentVariablesPage.vue';
import { listEnvironments, listEnvironmentVariables, saveEnvironmentVariable, removeEnvironmentVariable } from '../src/api/environment-variables';
import { ProjectApiError } from '../src/api/projects';
vi.mock('../src/api/environment-variables', () => ({ listEnvironments: vi.fn(), listEnvironmentVariables: vi.fn(), saveEnvironmentVariable: vi.fn(), removeEnvironmentVariable: vi.fn() }));
const access = vi.hoisted(() => ({ role: 'editor' }));
vi.mock('../src/composables/useBuildProjectAccess', () => ({ useBuildProjectAccess: () => ({
  project: ref({ id: '11111111-1111-4111-8111-111111111111', slug: 'site' }), accessVerified: ref(true), error: ref(''), loading: ref(false), canRun: computed(() => access.role === 'editor'),
}) }));
enableAutoUnmount(afterEach);
const id = '11111111-1111-4111-8111-111111111111';
const secret = { name: 'TOKEN', kind: 'secret' as const, updatedAt: '2026-11-21T00:00:00Z', updatedBy: id };
async function render() {
  const router = createRouter({ history: createMemoryHistory(), routes: [
    { path: '/projects/:slug/variables', component: EnvironmentVariablesPage }, { path: '/projects/:slug', component: { template: '<div />' } },
  ] });
  await router.push('/projects/site/variables'); await router.isReady();
  const wrapper = mount(EnvironmentVariablesPage, { global: { plugins: [router], stubs: {
    ElSelect: { props: ['modelValue'], emits: ['update:modelValue', 'change'], template: '<select :aria-label="$attrs[\'aria-label\']" :value="modelValue" @change="$emit(\'update:modelValue\', $event.target.value); $emit(\'change\', $event.target.value)"><slot /></select>' },
    ElOption: { props: ['value', 'label'], template: '<option :value="value">{{ label }}</option>' },
    ElPopconfirm: { template: '<span><slot name="reference" /><button class="confirm" @click="$emit(\'confirm\')">确认删除</button></span>' },
  } } }); await flushPromises(); return wrapper;
}
function button(wrapper: Awaited<ReturnType<typeof render>>, label: string) { return wrapper.findAll('button').find(node => node.text() === label)!; }
beforeEach(() => {
  vi.clearAllMocks(); access.role = 'editor'; vi.mocked(listEnvironments).mockResolvedValue([{ name: 'preview' }, { name: 'production' }]);
  vi.mocked(listEnvironmentVariables).mockResolvedValue([secret, { ...secret, name: 'API_URL', kind: 'plain', value: 'https://visible.test' }]);
  vi.mocked(saveEnvironmentVariable).mockResolvedValue(secret); vi.mocked(removeEnvironmentVariable).mockResolvedValue(undefined);
});
describe('B14 management UI', () => {
  it('masks secrets, shows plain values and replaces without prefilling a secret', async () => {
    const wrapper = await render(); expect(wrapper.text()).toContain('••••••'); expect(wrapper.text()).toContain('https://visible.test');
    await button(wrapper, '替换秘密值').trigger('click');
    const input = wrapper.get('input[aria-label="变量值"]'); expect(input.attributes('type')).toBe('password'); expect((input.element as HTMLInputElement).value).toBe('');
    await input.setValue('new-b14-secret'); await wrapper.get('form').trigger('submit'); await flushPromises();
    expect(saveEnvironmentVariable).toHaveBeenCalledWith(id, 'preview', 'TOKEN', { kind: 'secret', value: 'new-b14-secret' });
    expect(wrapper.html()).not.toContain('new-b14-secret');
  });
  it('edits plain values, validates names and confirms deletion', async () => {
    const wrapper = await render(); await button(wrapper, '编辑').trigger('click');
    expect((wrapper.get('textarea[aria-label="变量值"]').element as HTMLTextAreaElement).value).toBe('https://visible.test');
    await button(wrapper, '取消').trigger('click'); await wrapper.get('input[aria-label="变量名"]').setValue('invalid');
    await wrapper.get('form').trigger('submit'); expect(saveEnvironmentVariable).not.toHaveBeenCalled();
    await wrapper.get('.confirm').trigger('click'); await flushPromises(); expect(removeEnvironmentVariable).toHaveBeenCalledWith(id, 'preview', 'TOKEN');
  });
  it('switches environments, clears stale rows and rejects delayed results from the previous environment', async () => {
    const wrapper = await render();
    let resolve!: (rows: typeof secret[]) => void;
    vi.mocked(listEnvironmentVariables).mockImplementationOnce(() => new Promise(done => { resolve = done; }));
    await button(wrapper, '刷新').trigger('click');
    await wrapper.get('select[aria-label="项目环境"]').setValue('production'); await flushPromises();
    resolve([{ ...secret, name: 'STALE' }]); await flushPromises();
    expect(wrapper.text()).not.toContain('STALE'); expect(listEnvironmentVariables).toHaveBeenLastCalledWith(id, 'production');
  });
  it('hides mutations for viewers and clears values when access is revoked', async () => {
    access.role = 'viewer'; const wrapper = await render(); expect(wrapper.find('form').exists()).toBe(false);
    expect(wrapper.findAll('button').map(node => node.text())).not.toContain('编辑');
    vi.mocked(listEnvironmentVariables).mockRejectedValueOnce(new ProjectApiError('revoked', 403));
    await button(wrapper, '刷新').trigger('click'); await flushPromises();
    expect(wrapper.text()).not.toContain('https://visible.test'); expect(wrapper.text()).not.toContain('TOKEN');
  });
});
