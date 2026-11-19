// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount, enableAutoUnmount, type VueWrapper } from '@vue/test-utils';
import { createMemoryHistory, createRouter, type Router } from 'vue-router';
import { computed, defineComponent, ref, type Ref } from 'vue';
import type {
  Build,
  BuildLogChunk,
  BuildLogEvent,
  BuildStreamEnd,
  ProjectMembersResponse,
  ProjectRecord,
} from '@forgekit/contracts';
import BuildListPage from '../src/views/BuildListPage.vue';
import BuildDetailPage from '../src/views/BuildDetailPage.vue';
import { useBuildProjectAccess } from '../src/composables/useBuildProjectAccess';
import { useBuildLogStream } from '../src/composables/useBuildLogStream';
import {
  cancelBuild,
  getBuild,
  listBuildLogs,
  listBuilds,
  triggerBuild,
  createBuildStreamTicket,
  buildLogStreamUrl,
} from '../src/api/builds';
import { getProject } from '../src/api/projects';
import { listProjectMembers } from '../src/api/project-members';
import { clearSession, oidcEnabled } from '../src/auth/session';

enableAutoUnmount(afterEach);

vi.mock('../src/api/projects', () => {
  class ProjectApiError extends Error {
    readonly status: number;
    constructor(message: string, status: number) {
      super(message);
      this.name = 'ProjectApiError';
      this.status = status;
    }
  }
  return {
    ProjectApiError,
    apiRequest: vi.fn(),
    projectRequest: vi.fn(),
    getProject: vi.fn(),
  };
});

vi.mock('../src/api/project-members', () => ({
  listProjectMembers: vi.fn(),
}));

vi.mock('../src/api/builds', () => ({
  listBuilds: vi.fn(),
  getBuild: vi.fn(),
  triggerBuild: vi.fn(),
  cancelBuild: vi.fn(),
  listBuildLogs: vi.fn(),
  createBuildStreamTicket: vi.fn(),
  buildLogStreamUrl: vi.fn(),
}));

vi.mock('../src/auth/session', () => ({
  oidcEnabled: true,
  authSession: ref(null),
  restoreSession: vi.fn(),
  getAccessToken: vi.fn().mockResolvedValue('test-token'),
  clearSession: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../src/composables/useBuildProjectAccess', () => ({
  useBuildProjectAccess: vi.fn(),
}));

vi.mock('../src/composables/useBuildLogStream', () => ({
  useBuildLogStream: vi.fn(),
}));

const project: ProjectRecord = {
  id: 'project-id-1',
  slug: 'my-project',
  name: '我的项目',
  template: 'vue',
  features: ['theme', 'router'],
  createdAt: '2026-01-01T00:00:00.000Z',
};

const projectB: ProjectRecord = {
  id: 'project-id-2',
  slug: 'other-project',
  name: '其他项目',
  template: 'vue',
  features: [],
  createdAt: '2026-01-02T00:00:00.000Z',
};

const runningBuild: Build = {
  id: 'build-1',
  projectId: 'project-id-1',
  number: 1,
  template: 'vue',
  sourceRef: 'main',
  status: 'running',
  triggeredBy: 'user-1',
  queuedAt: '2026-01-01T00:00:00.000Z',
  startedAt: '2026-01-01T00:00:01.000Z',
  finishedAt: null,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:01.000Z',
  exitCode: null,
  errorMessage: null,
  artifactKey: null,
  artifactSize: null,
  artifactSha256: null,
  logStorageKey: null,
  runnerInfo: null,
};

const succeededBuild: Build = {
  ...runningBuild,
  id: 'build-1',
  status: 'succeeded',
  finishedAt: '2026-01-01T00:00:30.000Z',
  updatedAt: '2026-01-01T00:00:30.000Z',
  exitCode: 0,
};

const canceledBuild: Build = {
  ...runningBuild,
  status: 'canceled',
  finishedAt: '2026-01-01T00:00:20.000Z',
  updatedAt: '2026-01-01T00:00:20.000Z',
};

const membersResponse: ProjectMembersResponse = {
  members: [
    { userId: 'user-1', displayName: 'User One', role: 'owner', joinedAt: '2026-01-01T00:00:00.000Z' },
  ],
  currentUserId: 'user-1',
  currentRole: 'owner',
};

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function setAccessMock(
  overrides: Partial<{
    project: ProjectRecord | null;
    members: ProjectMembersResponse | null;
    loading: boolean;
    error: string;
    accessVerified: boolean;
    canRun: boolean;
    canCancel: boolean;
    refresh: () => Promise<void>;
  }> = {},
) {
  const projectRef = ref<ProjectRecord | null>(overrides.project !== undefined ? overrides.project : project);
  const membersRef = ref<ProjectMembersResponse | null>(
    overrides.members !== undefined ? overrides.members : membersResponse,
  );
  const loadingRef = ref(overrides.loading ?? false);
  const errorRef = ref(overrides.error ?? '');
  const accessVerifiedRef = ref(overrides.accessVerified ?? true);
  const canRunRef = computed(() => overrides.canRun ?? (accessVerifiedRef.value && ['owner', 'editor'].includes(membersRef.value?.currentRole ?? '')));
  const canCancelRef = computed(() => overrides.canCancel ?? canRunRef.value);
  const refresh = vi.fn().mockImplementation(overrides.refresh ?? (async () => {}));

  const mock = {
    project: projectRef,
    members: membersRef,
    loading: loadingRef,
    error: errorRef,
    accessVerified: accessVerifiedRef,
    canRun: canRunRef,
    canCancel: canCancelRef,
    refresh,
  };
  vi.mocked(useBuildProjectAccess).mockReturnValue(mock as unknown as ReturnType<typeof useBuildProjectAccess>);
  return mock;
}

function setLogStreamMock(
  overrides: Partial<{
    chunks: BuildLogChunk[];
    lastSeq: number;
    state: 'connecting' | 'connected' | 'reconnecting' | 'ended' | 'error' | 'closed';
    error: string;
    truncated: boolean;
    build: Build | null;
    end: BuildStreamEnd | null;
    accessError: 401 | 403 | 404 | null;
  }> = {},
) {
  const mock = {
    chunks: ref<BuildLogChunk[]>(overrides.chunks ?? []),
    lastSeq: ref(overrides.lastSeq ?? 0),
    state: ref<'connecting' | 'connected' | 'reconnecting' | 'ended' | 'error' | 'closed'>(
      overrides.state ?? 'connected',
    ),
    error: ref(overrides.error ?? ''),
    truncated: ref(overrides.truncated ?? false),
    build: ref<Build | null>(overrides.build ?? null),
    end: ref<BuildStreamEnd | null>(overrides.end ?? null),
    accessError: ref<401 | 403 | 404 | null>(overrides.accessError ?? null),
    reconnect: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn(),
  };
  vi.mocked(useBuildLogStream).mockReturnValue(
    mock as unknown as ReturnType<typeof useBuildLogStream>,
  );
  return mock;
}

async function createTestRouter(): Promise<Router> {
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/', component: defineComponent({ name: 'Home', template: '<div>Home</div>' }) },
      {
        path: '/projects/:slug/builds',
        name: 'project-builds',
        component: BuildListPage,
      },
      {
        path: '/projects/:slug/builds/:buildId',
        name: 'project-build',
        component: BuildDetailPage,
      },
      {
        path: '/projects/:slug',
        name: 'project-detail',
        component: defineComponent({ name: 'ProjectDetail', template: '<div>ProjectDetail</div>' }),
      },
      {
        path: '/auth/login',
        name: 'auth-login',
        component: defineComponent({ name: 'Login', template: '<div>Login</div>' }),
      },
    ],
  });
  await router.push('/');
  await router.isReady();
  return router;
}

async function mountList(router: Router): Promise<VueWrapper> {
  await router.push('/projects/my-project/builds');
  await router.isReady();
  const wrapper = mount(BuildListPage, { global: { plugins: [router] } });
  await flushPromises();
  return wrapper;
}

async function mountDetail(router: Router, buildId = 'build-1'): Promise<VueWrapper> {
  await router.push(`/projects/my-project/builds/${buildId}`);
  await router.isReady();
  const wrapper = mount(BuildDetailPage, {
    global: {
      plugins: [router],
      stubs: {
        BuildLogViewer: defineComponent({
          name: 'BuildLogViewer',
          props: { projectId: String, buildId: String },
          emits: ['status', 'end', 'unauthorized', 'forbidden'],
          template: '<div class="build-log-viewer-stub" />',
        }),
        BuildTriggerForm: defineComponent({
          name: 'BuildTriggerForm',
          props: { projectId: String, canRun: Boolean, initialSourceRef: String },
          emits: ['created', 'unauthorized'],
          template: '<div class="build-trigger-form-stub" />',
        }),
      },
    },
  });
  await flushPromises();
  return wrapper;
}

describe('BuildListPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setAccessMock();
    setLogStreamMock();
    vi.mocked(listBuilds).mockResolvedValue([runningBuild]);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('加载并显示构建列表', async () => {
    const router = await createTestRouter();
    const wrapper = await mountList(router);

    expect(listBuilds).toHaveBeenCalledWith('project-id-1', { limit: 50 });
    expect(wrapper.text()).toContain('我的项目');
    expect(wrapper.text()).toContain('构建记录');
    expect(wrapper.text()).toContain('#1');
    expect(wrapper.text()).toContain('构建中');
    expect(wrapper.text()).toContain('main');
  });

  it('显示加载状态', async () => {
    const deferred = createDeferred<Build[]>();
    vi.mocked(listBuilds).mockReturnValue(deferred.promise);
    const router = await createTestRouter();
    const wrapper = await mountList(router);

    expect(wrapper.find('[role="status"]').exists()).toBe(true);
    deferred.resolve([]);
    await flushPromises();
    expect(wrapper.find('[role="status"]').exists()).toBe(false);
  });

  it('显示空状态', async () => {
    vi.mocked(listBuilds).mockResolvedValue([]);
    const router = await createTestRouter();
    const wrapper = await mountList(router);

    expect(wrapper.text()).toContain('暂无构建记录');
  });

  it('显示加载错误', async () => {
    vi.mocked(listBuilds).mockRejectedValue(new Error('网络错误'));
    const router = await createTestRouter();
    const wrapper = await mountList(router);

    expect(wrapper.find('[role="alert"]').exists()).toBe(true);
    expect(wrapper.text()).toContain('构建加载失败');
    expect(wrapper.text()).toContain('网络错误');
  });

  it('分页加载更多并使用最后一条 number 作为游标', async () => {
    const builds = Array.from({ length: 50 }, (_, i) => ({
      ...runningBuild,
      id: `build-${i + 1}`,
      number: 100 - i,
    }));
    vi.mocked(listBuilds)
      .mockResolvedValueOnce(builds)
      .mockResolvedValueOnce([{ ...runningBuild, id: 'build-old', number: 50 }]);

    const router = await createTestRouter();
    const wrapper = await mountList(router);

    expect(wrapper.text()).toContain('#100');
    expect(wrapper.text()).toContain('#51');
    const loadMore = wrapper.findAll('button').find(button => button.text() === '加载更多')!;
    expect(loadMore.exists()).toBe(true);
    await loadMore.trigger('click');
    await flushPromises();

    expect(listBuilds).toHaveBeenLastCalledWith('project-id-1', { limit: 50, beforeNumber: 51 });
    expect(wrapper.text()).toContain('#50');
    expect(wrapper.findAll('button').some(button => button.text() === '加载更多')).toBe(false);
  });

  it('路由切换后旧数据不得回写', async () => {
    const deferredOld = createDeferred<Build[]>();
    const buildsB = [{ ...runningBuild, id: 'build-b', projectId: 'project-id-2', number: 200 }];

    vi.mocked(useBuildProjectAccess).mockImplementation((slug: Readonly<Ref<string>>) => {
      const projectRef = computed<ProjectRecord | null>(() =>
        slug.value === 'my-project' ? project : projectB,
      );
      return {
        project: projectRef,
        members: ref<ProjectMembersResponse | null>(membersResponse),
        loading: ref(false),
        error: ref(''),
        accessVerified: ref(true),
        canRun: computed(() => true),
        canCancel: computed(() => true),
        refresh: vi.fn(),
      } as unknown as ReturnType<typeof useBuildProjectAccess>;
    });

    vi.mocked(listBuilds).mockImplementation((projectId: string) => {
      if (projectId === 'project-id-1') {
        return deferredOld.promise;
      }
      return Promise.resolve(buildsB);
    });

    const router = await createTestRouter();
    await router.push('/projects/my-project/builds');
    await router.isReady();
    const wrapper = mount(BuildListPage, { global: { plugins: [router] } });
    await flushPromises();

    expect(listBuilds).toHaveBeenCalledWith('project-id-1', { limit: 50 });

    await router.push('/projects/other-project/builds');
    await flushPromises();

    expect(listBuilds).toHaveBeenLastCalledWith('project-id-2', { limit: 50 });
    expect(wrapper.text()).toContain('#200');
    expect(wrapper.text()).not.toContain('#100');

    deferredOld.resolve([{ ...runningBuild, id: 'build-old', projectId: 'project-id-1', number: 100 }]);
    await flushPromises();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(wrapper.text()).toContain('#200');
    expect(wrapper.text()).not.toContain('#100');
  });
});

describe('BuildListPage request ownership', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
    setAccessMock();
    vi.mocked(listBuilds).mockResolvedValue([runningBuild]);
    vi.mocked(getBuild).mockResolvedValue(runningBuild);
  });

  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

  it.each(['before', 'during'] as const)('keeps polling live when an old refresh finishes %s the new request', async (completion) => {
    const old = createDeferred<Build>();
    const current = createDeferred<Build>();
    vi.mocked(getBuild).mockReturnValueOnce(old.promise).mockReturnValueOnce(current.promise);
    const wrapper = await mountList(await createTestRouter());

    await vi.advanceTimersByTimeAsync(5000);
    expect(getBuild).toHaveBeenCalledTimes(1);
    await wrapper.findAll('button').find(button => button.text() === '刷新')!.trigger('click');
    await flushPromises();
    expect(listBuilds).toHaveBeenCalledTimes(2);

    if (completion === 'before') { old.resolve(succeededBuild); await flushPromises(); }
    await vi.advanceTimersByTimeAsync(5000);
    expect(getBuild).toHaveBeenCalledTimes(2);
    if (completion === 'during') { old.resolve(succeededBuild); await flushPromises(); }
    expect(wrapper.text()).toContain('构建中');
    expect(wrapper.text()).not.toContain('成功');

    // The stale completion must not unlock the current polling request.
    await vi.advanceTimersByTimeAsync(5000);
    expect(getBuild).toHaveBeenCalledTimes(2);
    current.resolve({ ...runningBuild, sourceRef: 'fresh-poll' }); await flushPromises();
    expect(wrapper.text()).toContain('fresh-poll');
    await vi.advanceTimersByTimeAsync(5000);
    expect(getBuild).toHaveBeenCalledTimes(3);
    expect(getBuild).toHaveBeenLastCalledWith(project.id, runningBuild.id);
  });

  it.each(['before', 'during'] as const)('keeps pagination live when an old page finishes %s the new request', async (completion) => {
    const firstPage = Array.from({ length: 50 }, (_, i) => ({ ...runningBuild, id: `page-${i}`, number: 100 - i }));
    const nextPage = Array.from({ length: 50 }, (_, i) => ({ ...runningBuild, id: `older-${i}`, number: 50 - i }));
    const old = createDeferred<Build[]>();
    const current = createDeferred<Build[]>();
    vi.mocked(listBuilds)
      .mockResolvedValueOnce(firstPage)
      .mockReturnValueOnce(old.promise)
      .mockResolvedValueOnce(firstPage)
      .mockReturnValueOnce(current.promise)
      .mockResolvedValueOnce([]);
    const wrapper = await mountList(await createTestRouter());
    await wrapper.findAll('button').find(button => button.text() === '加载更多')!.trigger('click');
    expect(listBuilds).toHaveBeenCalledTimes(2);
    await wrapper.findAll('button').find(button => button.text() === '刷新')!.trigger('click');
    await flushPromises();
    expect(listBuilds).toHaveBeenCalledTimes(3);

    if (completion === 'before') { old.resolve([{ ...runningBuild, number: 999 }]); await flushPromises(); }
    const button = wrapper.findAll('button').find(button => button.text() === '加载更多')!;
    expect(button.attributes('disabled')).toBeUndefined();
    await button.trigger('click');
    expect(listBuilds).toHaveBeenCalledTimes(4);
    expect(listBuilds).toHaveBeenLastCalledWith(project.id, { limit: 50, beforeNumber: 51 });
    if (completion === 'during') { old.resolve([{ ...runningBuild, number: 999 }]); await flushPromises(); }
    expect(wrapper.text()).not.toContain('#999');
    expect(button.attributes('disabled')).toBeDefined();
    await button.trigger('click');
    expect(listBuilds).toHaveBeenCalledTimes(4);

    current.resolve(nextPage); await flushPromises();
    expect(wrapper.text()).toContain('#50');
    expect(button.attributes('disabled')).toBeUndefined();
    await button.trigger('click'); await flushPromises();
    expect(listBuilds).toHaveBeenCalledTimes(5);
    expect(listBuilds).toHaveBeenLastCalledWith(project.id, { limit: 50, beforeNumber: 1 });
    expect(wrapper.text()).toContain('#100');
  });
});

describe('BuildDetailPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setAccessMock();
    setLogStreamMock();
    vi.mocked(getBuild).mockResolvedValue(runningBuild);
    vi.mocked(cancelBuild).mockResolvedValue(canceledBuild);
    vi.mocked(clearSession).mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('直接访问构建详情，slug 解析为项目 UUID', async () => {
    const router = await createTestRouter();
    const wrapper = await mountDetail(router);

    expect(getBuild).toHaveBeenCalledWith('project-id-1', 'build-1');
    expect(wrapper.text()).toContain('#1');
    expect(wrapper.text()).toContain('构建中');
    expect(wrapper.text()).toContain('main');
    expect(wrapper.text()).toContain('vue');
  });

  it('根据 BuildLogViewer status 事件更新构建状态', async () => {
    const updatedBuild = { ...runningBuild, status: 'succeeded' as const, finishedAt: '2026-01-01T00:00:30.000Z' };
    const LogViewerStub = defineComponent({
      name: 'BuildLogViewer',
      props: { projectId: String, buildId: String },
      emits: ['status', 'end', 'unauthorized', 'forbidden'],
      mounted() {
        this.$emit('status', updatedBuild);
      },
      template: '<div class="build-log-viewer-stub" />',
    });

    const router = await createTestRouter();
    await router.push('/projects/my-project/builds/build-1');
    await router.isReady();
    const wrapper = mount(BuildDetailPage, {
      global: {
        plugins: [router],
        stubs: {
          BuildLogViewer: LogViewerStub,
          BuildTriggerForm: defineComponent({
            name: 'BuildTriggerForm',
            props: { projectId: String, canRun: Boolean, initialSourceRef: String },
            emits: ['created', 'unauthorized'],
            template: '<div class="build-trigger-form-stub" />',
          }),
        },
      },
    });
    await flushPromises();

    expect(wrapper.text()).toContain('成功');
    expect(wrapper.text()).toContain(new Intl.DateTimeFormat('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).format(new Date(updatedBuild.finishedAt)));
  });

  it('取消构建时 409 后重新加载状态', async () => {
    const error409 = new (await import('../src/api/projects')).ProjectApiError('Conflict', 409);
    vi.mocked(cancelBuild).mockRejectedValueOnce(error409);
    vi.mocked(getBuild)
      .mockResolvedValueOnce(runningBuild)
      .mockResolvedValueOnce(canceledBuild);

    const router = await createTestRouter();
    const wrapper = await mountDetail(router);

    const cancelButton = wrapper.findAll('button').find(button => button.text() === '取消构建')!;
    expect(cancelButton.exists()).toBe(true);
    await cancelButton.trigger('click');
    await flushPromises();

    expect(cancelBuild).toHaveBeenCalledWith('project-id-1', 'build-1');
    expect(getBuild).toHaveBeenCalledTimes(2);
    expect(wrapper.text()).toContain('已取消');
  });

  it('再次构建提交后跳转到新构建详情', async () => {
    const newBuild: Build = {
      ...runningBuild,
      id: 'build-2',
      number: 2,
      projectId: 'project-id-1',
    };
    const TriggerFormStub = defineComponent({
      name: 'BuildTriggerForm',
      props: { projectId: String, canRun: Boolean, initialSourceRef: String },
      emits: ['created', 'unauthorized'],
      template: '<button class="trigger-submit" @click="$emit(\'created\', newBuild)">提交</button>',
      data() {
        return { newBuild };
      },
    });

    const router = await createTestRouter();
    await router.push('/projects/my-project/builds/build-1');
    await router.isReady();
    const wrapper = mount(BuildDetailPage, {
      global: {
        plugins: [router],
        stubs: {
          BuildLogViewer: defineComponent({
            name: 'BuildLogViewer',
            props: { projectId: String, buildId: String },
            emits: ['status', 'end', 'unauthorized', 'forbidden'],
            template: '<div class="build-log-viewer-stub" />',
          }),
          BuildTriggerForm: TriggerFormStub,
        },
      },
    });
    await flushPromises();

    const rebuildButton = wrapper.findAll('button').find(button => button.text() === '再次构建')!;
    expect(rebuildButton.exists()).toBe(true);
    await rebuildButton.trigger('click');
    await flushPromises();

    const submitButton = wrapper.find('.trigger-submit');
    expect(submitButton.exists()).toBe(true);
    await submitButton.trigger('click');
    await flushPromises();

    expect(router.currentRoute.value.fullPath).toBe('/projects/my-project/builds/build-2');
  });

  it('401 时清除会话并跳转登录', async () => {
    const error401 = new (await import('../src/api/projects')).ProjectApiError('Unauthorized', 401);
    vi.mocked(getBuild).mockRejectedValueOnce(error401);

    const router = await createTestRouter();
    await router.push('/projects/my-project/builds/build-1');
    await router.isReady();
    mount(BuildDetailPage, {
      global: {
        plugins: [router],
        stubs: {
          BuildLogViewer: defineComponent({
            name: 'BuildLogViewer',
            props: { projectId: String, buildId: String },
            emits: ['status', 'end', 'unauthorized', 'forbidden'],
            template: '<div class="build-log-viewer-stub" />',
          }),
          BuildTriggerForm: defineComponent({
            name: 'BuildTriggerForm',
            props: { projectId: String, canRun: Boolean, initialSourceRef: String },
            emits: ['created', 'unauthorized'],
            template: '<div class="build-trigger-form-stub" />',
          }),
        },
      },
    });
    await flushPromises();

    expect(clearSession).toHaveBeenCalled();
    expect(router.currentRoute.value.path).toBe('/auth/login');
    expect(router.currentRoute.value.query.returnTo).toBe('/projects/my-project/builds/build-1');
  });

  it('404 时清除构建数据并显示错误', async () => {
    const error404 = new (await import('../src/api/projects')).ProjectApiError('Not Found', 404);
    vi.mocked(getBuild).mockRejectedValueOnce(error404);

    const router = await createTestRouter();
    const wrapper = await mountDetail(router);

    expect(getBuild).toHaveBeenCalledWith('project-id-1', 'build-1');
    expect(wrapper.text()).not.toContain('#1');
    expect(wrapper.find('[role="alert"]').exists()).toBe(true);
    expect(wrapper.text()).toContain('无权访问构建或构建不存在');
    expect(clearSession).not.toHaveBeenCalled();
  });
});

describe('page authorization and request races', () => {
  beforeEach(() => {
    vi.clearAllMocks(); setAccessMock(); setLogStreamMock();
    vi.mocked(listBuilds).mockResolvedValue([runningBuild]); vi.mocked(getBuild).mockResolvedValue(runningBuild);
  });
  it('uses the real access composable to resolve slug before the UUID build request', async () => {
    const real = await vi.importActual<typeof import('../src/composables/useBuildProjectAccess')>('../src/composables/useBuildProjectAccess');
    vi.mocked(useBuildProjectAccess).mockImplementation(real.useBuildProjectAccess);
    vi.mocked(getProject).mockResolvedValue(project); vi.mocked(listProjectMembers).mockResolvedValue(membersResponse);
    const wrapper = await mountDetail(await createTestRouter());
    expect(getProject).toHaveBeenCalledWith('my-project'); expect(listProjectMembers).toHaveBeenCalledWith('my-project');
    expect(getBuild).toHaveBeenCalledWith(project.id, runningBuild.id); expect(wrapper.text()).toContain('#1');
  });
  it('keeps rows and disables trigger immediately on role downgrade', async () => {
    const access = setAccessMock(); const wrapper = await mountList(await createTestRouter());
    expect(wrapper.get('button[type="submit"]').attributes('disabled')).toBeUndefined();
    access.members.value = { ...membersResponse, currentRole: 'viewer' }; await flushPromises();
    expect(wrapper.get('button[type="submit"]').attributes('disabled')).toBeDefined(); expect(wrapper.text()).toContain('#1');
  });
  it('preserves existing rows on pagination failure', async () => {
    vi.mocked(listBuilds).mockResolvedValueOnce(Array.from({ length: 50 }, (_, i) => ({ ...runningBuild, id: `page-${i}`, number: 100 - i }))).mockRejectedValueOnce(new Error('分页网络故障'));
    const wrapper = await mountList(await createTestRouter());
    await wrapper.findAll('button').find(b => b.text() === '加载更多')!.trigger('click'); await flushPromises();
    expect(wrapper.text()).toContain('#100'); expect(wrapper.text()).toContain('#51'); expect(wrapper.text()).toContain('分页网络故障');
  });
  it('clears project and build rows on read denial without signing out', async () => {
    const access = setAccessMock(); const { ProjectApiError } = await import('../src/api/projects');
    vi.mocked(listBuilds).mockRejectedValue(new ProjectApiError('denied', 403));
    const wrapper = await mountList(await createTestRouter());
    expect(access.project.value).toBeNull(); expect(wrapper.text()).not.toContain('#1'); expect(wrapper.text()).toContain('没有权限');
    expect(clearSession).not.toHaveBeenCalled();
  });
  it('ignores the old detail response after build route changes', async () => {
    const old = createDeferred<Build>(); vi.mocked(getBuild).mockReturnValueOnce(old.promise);
    const router = await createTestRouter(); const wrapper = await mountDetail(router);
    vi.mocked(getBuild).mockResolvedValue({ ...runningBuild, id: 'build-2', number: 200 });
    await router.push('/projects/my-project/builds/build-2'); await flushPromises();
    old.resolve(runningBuild); await flushPromises();
    expect(wrapper.text()).toContain('#200'); expect(wrapper.text()).not.toContain('构建 #1');
  });
  it('ignores an old cancellation after navigation', async () => {
    const old = createDeferred<Build>(); vi.mocked(cancelBuild).mockReturnValueOnce(old.promise);
    const router = await createTestRouter(); const wrapper = await mountDetail(router);
    await wrapper.findAll('button').find(b => b.text() === '取消构建')!.trigger('click');
    vi.mocked(getBuild).mockResolvedValue({ ...runningBuild, id: 'build-2', number: 200 });
    await router.push('/projects/my-project/builds/build-2'); await flushPromises(); old.resolve(canceledBuild); await flushPromises();
    expect(wrapper.text()).toContain('#200'); expect(wrapper.text()).not.toContain('已取消');
  });
  it('409 with a still-running build permits a subsequent explicit cancellation', async () => {
    const { ProjectApiError } = await import('../src/api/projects');
    vi.mocked(cancelBuild).mockRejectedValueOnce(new ProjectApiError('race', 409)).mockResolvedValueOnce(canceledBuild);
    const wrapper = await mountDetail(await createTestRouter());
    await wrapper.findAll('button').find(b => b.text() === '取消构建')!.trigger('click'); await flushPromises();
    const button = wrapper.findAll('button').find(b => b.text() === '取消构建')!;
    expect(button.attributes('disabled')).toBeUndefined(); await button.trigger('click'); await flushPromises();
    expect(wrapper.text()).toContain('已取消'); expect(cancelBuild).toHaveBeenCalledTimes(2);
  });
});
