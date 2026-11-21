// @vitest-environment jsdom
import { ref } from 'vue';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { enableAutoUnmount, mount, flushPromises } from '@vue/test-utils';
import RuntimeLogViewer from '../src/components/runtime/RuntimeLogViewer.vue';
const stop = vi.hoisted(() => vi.fn());
vi.mock('../src/composables/useRuntimeLogStream', () => ({ useRuntimeLogStream: () => ({
  chunks: ref([{ seq: 1, content: '<img src=x onerror="alert(1)">\n[REDACTED]\n' }]), state: ref('connected'), error: ref(''), session: ref(null), accessError: ref(null), stop,
}) }));
enableAutoUnmount(afterEach);
describe('runtime tail viewer', () => {
  it('renders hostile log markup as text, supports keyboard scrolling and explicit stop', async () => {
    const wrapper = mount(RuntimeLogViewer, { props: { projectId: 'fixture', sessionId: 'fixture' } });
    await flushPromises();
    expect(wrapper.find('img').exists()).toBe(false); expect(wrapper.get('pre').text()).toContain('<img src=x');
    expect(wrapper.get('pre').attributes('tabindex')).toBe('0');
    await wrapper.get('input[type="checkbox"]').setValue(false);
    await wrapper.get('button').trigger('click'); expect(stop).toHaveBeenCalledOnce();
  });
});
