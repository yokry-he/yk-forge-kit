// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { defineComponent, ref } from 'vue';
import { createMemoryHistory, createRouter } from 'vue-router';
import type { ProjectMembersResponse, ProjectRecord } from '@forgekit/contracts';
import { ProjectApiError, getProject } from '../src/api/projects';
import { listProjectMembers } from '../src/api/project-members';
import { clearSession } from '../src/auth/session';
import { useBuildProjectAccess } from '../src/composables/useBuildProjectAccess';
const config = vi.hoisted(() => ({ oidc: true }));
vi.mock('../src/api/projects', () => ({ getProject: vi.fn(), ProjectApiError: class extends Error { constructor(message: string, readonly status: number) { super(message); } } }));
vi.mock('../src/api/project-members', () => ({ listProjectMembers: vi.fn() }));
vi.mock('../src/auth/session', () => ({ get oidcEnabled() { return config.oidc; }, authSession: ref(null), clearSession: vi.fn(async () => {}) }));
const project: ProjectRecord = { id: '11111111-1111-4111-8111-111111111111', slug: 'demo', name: '项目', template: 'vue-web', features: [], createdAt: '2026-11-19T00:00:00.000Z' };
const members = (role: ProjectMembersResponse['currentRole']): ProjectMembersResponse => ({ members: [], currentUserId: 'user', currentRole: role });
const wrappers: VueWrapper[] = [];
async function setup() {
  const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/projects/:slug/builds', component: { template: '<div />' } }, { path: '/auth/login', component: { template: '<div />' } }] });
  await router.push('/projects/demo/builds');
  const slug = ref('demo');
  let access!: ReturnType<typeof useBuildProjectAccess>;
  wrappers.push(mount(defineComponent({ setup() { access = useBuildProjectAccess(slug); return () => null; } }), { global: { plugins: [router] } }));
  await flushPromises();
  return { access, slug, router };
}
beforeEach(() => {
  config.oidc = true; vi.useFakeTimers();
  vi.mocked(getProject).mockReset().mockResolvedValue(project);
  vi.mocked(listProjectMembers).mockReset().mockResolvedValue(members('owner'));
  vi.mocked(clearSession).mockClear();
});
afterEach(() => { wrappers.splice(0).forEach(w => w.unmount()); vi.useRealTimers(); vi.restoreAllMocks(); });
describe('build project access', () => {
  it.each(['owner', 'editor', 'viewer', null] as const)('checks role %s', async (role) => {
    vi.mocked(listProjectMembers).mockResolvedValue(members(role));
    const { access } = await setup();
    expect(access.canRun.value).toBe(role === 'owner' || role === 'editor');
    expect(access.canCancel.value).toBe(access.canRun.value);
    expect(access.accessVerified.value).toBe(role !== null);
  });
  it('local is readable and cannot mutate or fetch members', async () => {
    config.oidc = false; const { access } = await setup();
    expect(access.project.value).toEqual(project); expect(access.canRun.value).toBe(false);
    expect(listProjectMembers).not.toHaveBeenCalled();
  });
  it('disables writes during verification and on member network failure', async () => {
    const { access } = await setup();
    vi.mocked(listProjectMembers).mockRejectedValue(new ProjectApiError('offline', 0));
    const pending = access.refresh(); expect(access.canRun.value).toBe(false); await pending;
    expect(access.canRun.value).toBe(false); expect(access.members.value).toBeNull();
    expect(clearSession).not.toHaveBeenCalled(); expect(access.project.value).toEqual(project);
  });
  it('refreshes on focus, visible transition and each visible minute', async () => {
    const { access } = await setup();
    window.dispatchEvent(new Event('focus')); await flushPromises();
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
    document.dispatchEvent(new Event('visibilitychange')); await flushPromises();
    await vi.advanceTimersByTimeAsync(60_000); await flushPromises();
    expect(getProject).toHaveBeenCalledTimes(4); expect(access.canRun.value).toBe(true);
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
    await vi.advanceTimersByTimeAsync(60_000); expect(getProject).toHaveBeenCalledTimes(4);
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
  });
  it.each([401, 403, 404])('clears sensitive data on %s', async (status) => {
    const { access, router } = await setup();
    vi.mocked(getProject).mockRejectedValue(new ProjectApiError('denied', status)); await access.refresh();
    expect(access.project.value).toBeNull(); expect(access.members.value).toBeNull(); expect(access.canRun.value).toBe(false);
    if (status === 401) { expect(clearSession).toHaveBeenCalledOnce(); expect(router.currentRoute.value.path).toBe('/auth/login'); expect(router.currentRoute.value.query.returnTo).toBe('/projects/demo/builds'); }
    else expect(clearSession).not.toHaveBeenCalled();
  });
  it('ignores old requests after slug change', async () => {
    const { access, slug } = await setup();
    let resolveOld!: (value: ProjectRecord) => void;
    vi.mocked(getProject).mockImplementationOnce(() => new Promise(resolve => { resolveOld = resolve; }));
    const pending = access.refresh();
    vi.mocked(getProject).mockResolvedValue({ ...project, slug: 'other' });
    slug.value = 'other'; await flushPromises();
    resolveOld(project); await pending; await flushPromises(); expect(access.project.value?.slug).toBe('other');
  });
  it('removes listeners and timers and ignores pending results on unmount', async () => {
    const win = vi.spyOn(window, 'removeEventListener'), doc = vi.spyOn(document, 'removeEventListener');
    await setup(); wrappers.splice(0).forEach(w => w.unmount());
    expect(win).toHaveBeenCalledWith('focus', expect.any(Function)); expect(doc).toHaveBeenCalledWith('visibilitychange', expect.any(Function));
    const count = vi.mocked(getProject).mock.calls.length; window.dispatchEvent(new Event('focus'));
    await vi.advanceTimersByTimeAsync(60_000); expect(getProject).toHaveBeenCalledTimes(count);
  });
});
