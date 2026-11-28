// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils';
import PreviewLinkPanel from '../src/components/builds/PreviewLinkPanel.vue';
import { createPreviewLink, listPreviewLinks, revokePreviewLink } from '../src/api/preview-links';
import { ProjectApiError } from '../src/api/projects';
vi.mock('../src/api/preview-links', () => ({ createPreviewLink: vi.fn(), listPreviewLinks: vi.fn(), revokePreviewLink: vi.fn() }));
enableAutoUnmount(afterEach);
const id = '11111111-1111-4111-8111-111111111111';
const metadata = { id, buildId: id, createdBy: id, createdAt: '2026-11-19T00:00:00.000Z', expiresAt: '2099-01-01T00:00:00.000Z', revokedAt: null, lastAccessedAt: null };
const created = { previewLink: metadata, token: 'a'.repeat(43), url: 'https://credential.preview.example/' };
const props = { projectId: id, buildId: id, canManage: true };
function button(wrapper: ReturnType<typeof mount>, text: string) { return wrapper.findAll('button').find(item => item.text() === text)!; }
beforeEach(() => {
  vi.clearAllMocks(); vi.mocked(listPreviewLinks).mockResolvedValue([]); vi.mocked(createPreviewLink).mockResolvedValue(created);
  vi.mocked(revokePreviewLink).mockResolvedValue(undefined);
});
afterEach(() => { vi.unstubAllGlobals(); });
describe('PreviewLinkPanel', () => {
  it('groups refresh in the card header and labels the TTL beside the create action', async () => {
    const wrapper = mount(PreviewLinkPanel, { props }); await flushPromises();
    expect(wrapper.get('header h2').text()).toBe('预览链接');
    expect(wrapper.get('header button').text()).toBe('刷新链接');
    const controls = wrapper.get('.build-panel-controls');
    expect(controls.get('label').attributes('for')).toBe(controls.get('select').attributes('id'));
    expect((controls.get('select').element as HTMLSelectElement).value).toBe('86400');
    expect(controls.get('button').text()).toBe('创建链接');
    expect(controls.get('button').classes()).toEqual(wrapper.get('header button').classes());
    await wrapper.get('header button').trigger('click'); await flushPromises();
    expect(listPreviewLinks).toHaveBeenCalledTimes(2);
  });
  it('chooses TTL, shows URL once, copies, then discards it without storage', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined); vi.stubGlobal('navigator', { clipboard: { writeText } });
    const storage = vi.spyOn(Storage.prototype, 'setItem');
    const wrapper = mount(PreviewLinkPanel, { props }); await flushPromises();
    await wrapper.get('select').setValue(3600); await button(wrapper, '创建链接').trigger('click'); await flushPromises();
    expect(createPreviewLink).toHaveBeenCalledWith(id, id, 3600);
    expect((wrapper.get('#created-url').element as HTMLInputElement).value).toBe(created.url);
    expect(wrapper.text()).toContain('仅显示一次');
    await button(wrapper, '复制链接').trigger('click'); await flushPromises(); expect(writeText).toHaveBeenCalledWith(created.url);
    await button(wrapper, '关闭提示').trigger('click'); expect(wrapper.find('#created-url').exists()).toBe(false);
    expect(wrapper.text()).toContain(id); expect(wrapper.text()).not.toContain(created.token);
    expect(storage).not.toHaveBeenCalled(); storage.mockRestore();
  });
  it('hides mutation controls for viewers and lists metadata without token URLs', async () => {
    vi.mocked(listPreviewLinks).mockResolvedValue([metadata]);
    const wrapper = mount(PreviewLinkPanel, { props: { ...props, canManage: false } }); await flushPromises();
    expect(wrapper.find('select').exists()).toBe(false); expect(wrapper.text()).not.toContain('撤销');
    expect(wrapper.text()).toContain(id); expect(wrapper.find('input').exists()).toBe(false);
  });
  it('revokes the link and clears its once-only URL', async () => {
    const wrapper = mount(PreviewLinkPanel, { props }); await flushPromises();
    await button(wrapper, '创建链接').trigger('click'); await flushPromises();
    await button(wrapper, '撤销').trigger('click'); await flushPromises();
    expect(revokePreviewLink).toHaveBeenCalledWith(id, id, id); expect(wrapper.find('#created-url').exists()).toBe(false);
    expect(wrapper.text()).toContain('暂无有效预览链接');
  });
  it('clears credential state on build change and ignores stale create responses', async () => {
    let finish!: (value: typeof created) => void;
    vi.mocked(createPreviewLink).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const wrapper = mount(PreviewLinkPanel, { props }); await flushPromises();
    await button(wrapper, '创建链接').trigger('click'); await wrapper.setProps({ buildId: 'next' });
    finish(created); await flushPromises(); expect(wrapper.find('#created-url').exists()).toBe(false);
  });
  it('clears once-only credentials on permission loss and on unauthorized responses', async () => {
    const wrapper = mount(PreviewLinkPanel, { props }); await flushPromises();
    await button(wrapper, '创建链接').trigger('click'); await flushPromises();
    await wrapper.setProps({ canManage: false }); expect(wrapper.find('#created-url').exists()).toBe(false);
    await flushPromises(); vi.mocked(listPreviewLinks).mockRejectedValueOnce(new ProjectApiError('unauthorized', 401));
    await button(wrapper, '刷新链接').trigger('click'); await flushPromises(); expect(wrapper.emitted('unauthorized')).toHaveLength(1);
  });
  it('shows loading, rate limit, clipboard and server failures without exposing raw errors', async () => {
    vi.mocked(listPreviewLinks).mockRejectedValueOnce(new ProjectApiError('secret-response', 429));
    const wrapper = mount(PreviewLinkPanel, { props }); expect(wrapper.text()).toContain('加载中'); await flushPromises();
    expect(wrapper.text()).toContain('请求过于频繁'); expect(wrapper.text()).not.toContain('secret-response');
    vi.mocked(createPreviewLink).mockRejectedValueOnce(new ProjectApiError('secret', 503));
    await button(wrapper, '创建链接').trigger('click'); await flushPromises(); expect(wrapper.text()).toContain('暂不可用');
    await button(wrapper, '创建链接').trigger('click'); await flushPromises();
    await button(wrapper, '复制链接').trigger('click'); await flushPromises(); expect(wrapper.text()).toContain('手动复制');
  });
});
