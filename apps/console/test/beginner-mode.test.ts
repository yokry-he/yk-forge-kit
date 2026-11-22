// @vitest-environment jsdom
import { flushPromises, mount } from '@vue/test-utils';
import { createMemoryHistory, createRouter } from 'vue-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import BeginnerModeView from '../src/views/BeginnerModeView.vue';
import { classifyNeed, getBeginnerConfig, saveBeginnerConfig, deleteBeginnerConfig } from '../src/api/beginner';
import { saveProject } from '../src/api/projects';
import type { ProjectRecord } from '@forgekit/contracts';
vi.mock('../src/api/beginner', () => ({ classifyNeed: vi.fn(), getBeginnerConfig: vi.fn(), saveBeginnerConfig: vi.fn(), deleteBeginnerConfig: vi.fn() }));
vi.mock('../src/api/projects', () => ({ saveProject: vi.fn() }));
const record: ProjectRecord = { id: 'id', name: 'company-site', slug: 'company-site', template: 'nuxt-site', features: [], platforms: ['web'], createdAt: new Date().toISOString() };
async function setup() {
  const router = createRouter({ history: createMemoryHistory(), routes: [
    { path: '/projects/new/beginner', component: BeginnerModeView },
    { path: '/projects/new', component: { template: '<div />' } },
    { path: '/projects/:slug', component: { template: '<div />' } },
  ] });
  await router.push('/projects/new/beginner'); await router.isReady();
  const wrapper = mount(BeginnerModeView, { global: { plugins: [router] } });
  await flushPromises(); return { wrapper, router };
}
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getBeginnerConfig).mockResolvedValue({ configured: false });
  vi.mocked(classifyNeed).mockResolvedValue({ templateId: 'nuxt-site', name: 'company-site', platforms: ['web'], source: 'ai' });
  vi.mocked(saveProject).mockResolvedValue(record);
  vi.mocked(saveBeginnerConfig).mockResolvedValue({ configured: true });
  vi.mocked(deleteBeginnerConfig).mockResolvedValue(undefined);
});
describe('新手模式向导', () => {
  it('describes a need, edits the suggestion, creates through the existing API and opens detail', async () => {
    const { wrapper, router } = await setup();
    await wrapper.get('#beginner-need').setValue('公司官网');
    await wrapper.get('form').trigger('submit'); await flushPromises();
    expect(classifyNeed).toHaveBeenCalledWith('公司官网'); expect(wrapper.text()).toContain('AI（ai）');
    await wrapper.get('#beginner-name').setValue('edited-site');
    const next = wrapper.findAll('button').find(b => b.text() === '继续 →')!;
    await next.trigger('click');
    expect(wrapper.text()).toContain('源码生成由现有本地 CLI 完成');
    await wrapper.findAll('button').find(b => b.text() === '创建项目配置')!.trigger('click'); await flushPromises();
    expect(saveProject).toHaveBeenCalledWith({ name: 'edited-site', template: 'nuxt-site', features: [], platforms: ['web'] });
    expect(router.currentRoute.value.path).toBe('/projects/company-site');
  });
  it('shows keyword fallback and uncertainty, resets compatible platforms on template change', async () => {
    vi.mocked(classifyNeed).mockResolvedValue({ templateId: 'vue-web', name: 'web-app', platforms: ['web'], source: 'keywords', lowConfidence: true, warnings: ['请确认推荐'] });
    const { wrapper } = await setup();
    await wrapper.get('#beginner-need').setValue('随便推荐一个'); await wrapper.get('form').trigger('submit'); await flushPromises();
    expect(wrapper.text()).toContain('关键词（keywords）'); expect(wrapper.text()).toContain('把握不大，请确认');
    expect(wrapper.text()).toContain('请确认推荐');
    await wrapper.get('#beginner-template').setValue('tauri-desktop');
    expect(wrapper.findAll('input[type="checkbox"]').map(c => c.attributes('value'))).toEqual(['tauri-desktop']);
    await wrapper.get('#beginner-name').setValue('../unsafe');
    expect(wrapper.findAll('button').find(b => b.text() === '继续 →')!.attributes('disabled')).toBeDefined();
    await wrapper.get('#beginner-name').setValue('safe'); await wrapper.get('input[type="checkbox"]').setValue(false);
    expect(wrapper.findAll('button').find(b => b.text() === '继续 →')!.attributes('disabled')).toBeDefined();
  });
  it('requests confirmation after a user switches even a confident template', async () => {
    const { wrapper } = await setup(); await wrapper.get('#beginner-need').setValue('company site');
    await wrapper.get('form').trigger('submit'); await flushPromises();
    expect(wrapper.text()).not.toContain('把握不大，请确认');
    await wrapper.get('#beginner-template').setValue('uniapp');
    expect(wrapper.text()).toContain('把握不大，请确认');
    expect(wrapper.findAll('input[type="checkbox"]').length).toBe(5);
  });
  it('only displays configured state, keeps an empty key and supports deletion', async () => {
    vi.mocked(getBeginnerConfig).mockResolvedValue({ configured: true, provider: 'DeepSeek', baseUrl: 'https://api.deepseek.com', model: 'deepseek-chat' });
    const { wrapper } = await setup(); const secret = 'sk-replace-write-only';
    expect(wrapper.text()).toContain('已配置（仅可替换）');
    expect((wrapper.get('#ai-key').element as HTMLInputElement).value).toBe('');
    await wrapper.get('.ai-config form').trigger('submit'); await flushPromises();
    expect(saveBeginnerConfig).toHaveBeenLastCalledWith(expect.objectContaining({ apiKey: '' }));
    await wrapper.get('#ai-key').setValue(secret); await wrapper.get('.ai-config form').trigger('submit'); await flushPromises();
    expect(saveBeginnerConfig).toHaveBeenLastCalledWith(expect.objectContaining({ apiKey: secret }));
    expect((wrapper.get('#ai-key').element as HTMLInputElement).value).toBe(''); expect(wrapper.html()).not.toContain(secret);
    await wrapper.findAll('button').find(b => b.text() === '删除 AI 配置')!.trigger('click'); await flushPromises();
    expect(deleteBeginnerConfig).toHaveBeenCalledOnce(); expect(wrapper.text()).toContain('AI 配置已删除');
  });
  it('shows safe errors and clears key drafts even after failed writes', async () => {
    const secret = 'sk-not-in-error'; vi.mocked(saveBeginnerConfig).mockRejectedValue(new Error(secret));
    vi.mocked(classifyNeed).mockRejectedValue(new Error(secret));
    const { wrapper } = await setup(); await wrapper.get('#ai-key').setValue(secret);
    await wrapper.get('.ai-config form').trigger('submit'); await flushPromises();
    expect((wrapper.get('#ai-key').element as HTMLInputElement).value).toBe(''); expect(wrapper.text()).not.toContain(secret);
    await wrapper.get('#beginner-need').setValue('web'); await wrapper.get('form').trigger('submit'); await flushPromises();
    expect(wrapper.text()).toContain('暂时无法推荐'); expect(wrapper.text()).not.toContain(secret);
  });
  it('keeps the wizard usable when the optional configuration read fails', async () => {
    vi.mocked(getBeginnerConfig).mockRejectedValue(new Error('offline'));
    const { wrapper } = await setup(); expect(wrapper.text()).toContain('AI 配置暂不可用');
    await wrapper.get('#beginner-need').setValue('web'); await wrapper.get('form').trigger('submit'); await flushPromises();
    expect(wrapper.get('#beginner-template').exists()).toBe(true);
  });
});
