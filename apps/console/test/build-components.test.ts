// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mount, flushPromises, enableAutoUnmount } from '@vue/test-utils';
import { nextTick, ref } from 'vue';
import type { Build, BuildLogChunk, BuildStreamEnd, BuildStatus } from '@forgekit/contracts';
import BuildStatusBadge from '../src/components/builds/BuildStatusBadge.vue';
import BuildTriggerForm from '../src/components/builds/BuildTriggerForm.vue';
import BuildLogViewer from '../src/components/builds/BuildLogViewer.vue';
import { triggerBuild } from '../src/api/builds';
import { useBuildLogStream, type BuildLogConnectionState } from '../src/composables/useBuildLogStream';
import { ProjectApiError } from '../src/api/projects';

vi.mock('../src/api/builds', () => ({
  triggerBuild: vi.fn(),
}));

vi.mock('../src/composables/useBuildLogStream', () => ({
  useBuildLogStream: vi.fn(),
}));

enableAutoUnmount(afterEach);
const mockTriggerBuild = vi.mocked(triggerBuild);
const mockUseBuildLogStream = vi.mocked(useBuildLogStream);

function makeBuild(overrides: Partial<Build> = {}): Build {
  return {
    id: 'build-1',
    projectId: 'project-1',
    number: 1,
    template: 'vue',
    sourceRef: 'main',
    status: 'queued',
    triggeredBy: 'user-1',
    queuedAt: '2026-01-01T00:00:00.000Z',
    startedAt: null,
    finishedAt: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    exitCode: null,
    errorMessage: null,
    artifactKey: null,
    artifactSize: null,
    artifactSha256: null,
    logStorageKey: null,
    runnerInfo: null,
    ...overrides,
  };
}

function makeChunk(seq: number, overrides: Partial<BuildLogChunk> = {}): BuildLogChunk {
  return {
    seq,
    stream: 'stdout',
    content: `line ${seq}`,
    ts: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function makeEnd(overrides: Partial<BuildStreamEnd> = {}): BuildStreamEnd {
  return {
    buildId: 'build-1',
    status: 'succeeded',
    lastSeq: 1,
    ...overrides,
  };
}

function createStreamMock() {
  return {
    chunks: ref<BuildLogChunk[]>([]),
    lastSeq: ref(0),
    state: ref<BuildLogConnectionState>('connecting'),
    error: ref(''),
    truncated: ref(false),
    build: ref<Build | null>(null),
    end: ref<BuildStreamEnd | null>(null),
    accessError: ref<401 | 403 | 404 | null>(null),
    reconnect: vi.fn(async () => {
      // 模拟重连成功
    }),
    stop: vi.fn(),
  };
}

describe('BuildStatusBadge', () => {
  const cases: Array<[BuildStatus, string]> = [
    ['queued', '排队中'],
    ['running', '构建中'],
    ['succeeded', '成功'],
    ['failed', '失败'],
    ['canceled', '已取消'],
    ['timed_out', '已超时'],
  ];

  for (const [status, label] of cases) {
    it(`renders ${status} as ${label}`, () => {
      const wrapper = mount(BuildStatusBadge, { props: { status } });
      expect(wrapper.text()).toBe(label);
    });
  }
});

describe('BuildTriggerForm', () => {
  beforeEach(() => {
    mockTriggerBuild.mockReset();
  });

  it('禁用输入与提交当 canRun=false', () => {
    const wrapper = mount(BuildTriggerForm, {
      props: { projectId: 'project-1', canRun: false },
    });
    const input = wrapper.get('input');
    const button = wrapper.get('button[type="submit"]');
    expect((input.element as HTMLInputElement).disabled).toBe(true);
    expect((button.element as HTMLButtonElement).disabled).toBe(true);
  });

  it('空输入不触发 API 并展示错误', async () => {
    const wrapper = mount(BuildTriggerForm, {
      props: { projectId: 'project-1', canRun: true },
    });
    await wrapper.get('form').trigger('submit');
    expect(mockTriggerBuild).not.toHaveBeenCalled();
    expect(wrapper.find('[role="alert"]').exists()).toBe(true);
  });

  it('超过 1024 字符输入不触发 API', async () => {
    const wrapper = mount(BuildTriggerForm, {
      props: { projectId: 'project-1', canRun: true },
    });
    const input = wrapper.get('input');
    await input.setValue('a'.repeat(1025));
    await wrapper.get('form').trigger('submit');
    expect(mockTriggerBuild).not.toHaveBeenCalled();
    expect(wrapper.find('[role="alert"]').exists()).toBe(true);
  });

  it('成功后触发 created 事件并传递 trimmed sourceRef', async () => {
    const build = makeBuild({ id: 'build-2', number: 2, sourceRef: 'main' });
    mockTriggerBuild.mockResolvedValue(build);
    const wrapper = mount(BuildTriggerForm, {
      props: { projectId: 'project-1', canRun: true },
    });
    await wrapper.get('input').setValue('  main  ');
    await wrapper.get('form').trigger('submit');
    await flushPromises();
    expect(mockTriggerBuild).toHaveBeenCalledWith('project-1', 'main');
    expect(wrapper.emitted('created')?.[0]?.[0]).toEqual(build);
  });

  it('B17 preserves the mini-program target on rebuild', async () => {
    mockTriggerBuild.mockResolvedValue(makeBuild({ target: 'mp-weixin' }));
    const wrapper = mount(BuildTriggerForm, { props: { projectId: 'project-1', canRun: true, initialSourceRef: 'template:uniapp', initialTarget: 'mp-weixin' } });
    expect((wrapper.get('#build-target').element as HTMLSelectElement).value).toBe('mp-weixin');
    await wrapper.get('form').trigger('submit'); await flushPromises();
    expect(mockTriggerBuild).toHaveBeenCalledWith('project-1', 'template:uniapp', undefined, 'mp-weixin');
  });

  it('失败时显示错误并保留输入', async () => {
    mockTriggerBuild.mockRejectedValue(new Error('网络错误'));
    const wrapper = mount(BuildTriggerForm, {
      props: { projectId: 'project-1', canRun: true },
    });
    await wrapper.get('input').setValue('feature/x');
    await wrapper.get('form').trigger('submit');
    await flushPromises();
    const alert = wrapper.get('[role="alert"]');
    expect(alert.text()).toContain('构建触发失败');
    expect((wrapper.get('input').element as HTMLInputElement).value).toBe('feature/x');
  });

  it('提交中禁用按钮防止双击', async () => {
    let resolveTrigger: (build: Build) => void = () => {};
    const pending = new Promise<Build>((resolve) => {
      resolveTrigger = resolve;
    });
    mockTriggerBuild.mockReturnValue(pending);
    const wrapper = mount(BuildTriggerForm, {
      props: { projectId: 'project-1', canRun: true },
    });
    await wrapper.get('input').setValue('main');
    const form = wrapper.get('form');
    await form.trigger('submit');
    await nextTick();
    const button = wrapper.get('button[type="submit"]');
    expect((button.element as HTMLButtonElement).disabled).toBe(true);
    await form.trigger('submit');
    expect(mockTriggerBuild).toHaveBeenCalledTimes(1);
    resolveTrigger(makeBuild());
    await flushPromises();
  });

  it('401 时发出 unauthorized 事件', async () => {
    mockTriggerBuild.mockRejectedValue(new ProjectApiError('未授权', 401));
    const wrapper = mount(BuildTriggerForm, {
      props: { projectId: 'project-1', canRun: true },
    });
    await wrapper.get('input').setValue('main');
    await wrapper.get('form').trigger('submit');
    await flushPromises();
    expect(wrapper.emitted('unauthorized')).toBeTruthy();
  });
});

describe('BuildLogViewer', () => {
  beforeEach(() => {
    mockUseBuildLogStream.mockReset();
  });

  it('以文本方式显示日志并转义 HTML', async () => {
    const stream = createStreamMock();
    mockUseBuildLogStream.mockReturnValue(stream as ReturnType<typeof useBuildLogStream>);
    const wrapper = mount(BuildLogViewer, {
      props: { projectId: 'project-1', buildId: 'build-1' },
    });

    stream.chunks.value = [
      makeChunk(1, { content: '<img src=x onerror=alert(1)>', stream: 'stdout' }),
    ];
    await nextTick();

    const chunkElement = wrapper.get('.build-log-stdout');
    expect(chunkElement.html()).toContain('&lt;img');
    expect(chunkElement.html()).not.toContain('<img');
  });

  it('根据流类型添加样式类', async () => {
    const stream = createStreamMock();
    mockUseBuildLogStream.mockReturnValue(stream as ReturnType<typeof useBuildLogStream>);
    const wrapper = mount(BuildLogViewer, {
      props: { projectId: 'project-1', buildId: 'build-1' },
    });

    stream.chunks.value = [
      makeChunk(1, { stream: 'stdout' }),
      makeChunk(2, { stream: 'stderr' }),
      makeChunk(3, { stream: 'system' }),
    ];
    await nextTick();

    expect(wrapper.find('.build-log-stdout').exists()).toBe(true);
    expect(wrapper.find('.build-log-stderr').exists()).toBe(true);
    expect(wrapper.find('.build-log-system').exists()).toBe(true);
  });

  it('自动滚动默认开启，新日志滚动到底部', async () => {
    const stream = createStreamMock();
    mockUseBuildLogStream.mockReturnValue(stream as ReturnType<typeof useBuildLogStream>);
    const wrapper = mount(BuildLogViewer, {
      props: { projectId: 'project-1', buildId: 'build-1' },
    });
    await nextTick();

    const region = wrapper.get('.build-log-container').element as HTMLElement;
    Object.defineProperty(region, 'scrollHeight', {
      value: 100,
      configurable: true,
      writable: true,
    });
    Object.defineProperty(region, 'scrollTop', {
      value: 0,
      configurable: true,
      writable: true,
    });

    const checkbox = wrapper.get('input[type="checkbox"]');
    expect((checkbox.element as HTMLInputElement).checked).toBe(true);

    stream.chunks.value = [makeChunk(1)];
    await nextTick();
    await nextTick(); // 等待 watcher 的 nextTick 滚动
    expect(region.scrollTop).toBe(100);
  });

  it('关闭自动滚动后保持滚动位置', async () => {
    const stream = createStreamMock();
    mockUseBuildLogStream.mockReturnValue(stream as ReturnType<typeof useBuildLogStream>);
    const wrapper = mount(BuildLogViewer, {
      props: { projectId: 'project-1', buildId: 'build-1' },
    });
    await nextTick();

    const region = wrapper.get('.build-log-container').element as HTMLElement;
    Object.defineProperty(region, 'scrollHeight', {
      value: 200,
      configurable: true,
      writable: true,
    });
    Object.defineProperty(region, 'scrollTop', {
      value: 0,
      configurable: true,
      writable: true,
    });

    const checkbox = wrapper.get('input[type="checkbox"]');
    await checkbox.setValue(false);
    region.scrollTop = 0;

    stream.chunks.value = [makeChunk(1), makeChunk(2)];
    await nextTick();
    await nextTick();
    expect(region.scrollTop).toBe(0);
  });

  it('错误状态显示重新连接并调用 reconnect', async () => {
    const stream = createStreamMock();
    mockUseBuildLogStream.mockReturnValue(stream as ReturnType<typeof useBuildLogStream>);
    stream.state.value = 'error';
    stream.error.value = '连接失败';

    const wrapper = mount(BuildLogViewer, {
      props: { projectId: 'project-1', buildId: 'build-1' },
    });
    await nextTick();

    const button = wrapper
      .findAll('button')
      .find((btn) => btn.text().includes('重新连接'));
    expect(button).toBeDefined();
    if (!button) throw new Error('未找到重新连接按钮');
    await button.trigger('click');
    expect(stream.reconnect).toHaveBeenCalled();
  });

  it('结束状态显示刷新日志并调用 reconnect', async () => {
    const stream = createStreamMock();
    mockUseBuildLogStream.mockReturnValue(stream as ReturnType<typeof useBuildLogStream>);
    stream.state.value = 'ended';

    const wrapper = mount(BuildLogViewer, {
      props: { projectId: 'project-1', buildId: 'build-1' },
    });
    await nextTick();

    const button = wrapper
      .findAll('button')
      .find((btn) => btn.text().includes('刷新日志'));
    expect(button).toBeDefined();
    if (!button) throw new Error('未找到刷新日志按钮');
    await button.trigger('click');
    expect(stream.reconnect).toHaveBeenCalled();
  });

  it('截断时显示仅显示最近日志', async () => {
    const stream = createStreamMock();
    mockUseBuildLogStream.mockReturnValue(stream as ReturnType<typeof useBuildLogStream>);
    stream.truncated.value = true;

    const wrapper = mount(BuildLogViewer, {
      props: { projectId: 'project-1', buildId: 'build-1' },
    });
    await nextTick();

    expect(wrapper.text()).toContain('仅显示最近日志');
  });

  it('发出 status 和 end 事件', async () => {
    const stream = createStreamMock();
    mockUseBuildLogStream.mockReturnValue(stream as ReturnType<typeof useBuildLogStream>);
    const wrapper = mount(BuildLogViewer, {
      props: { projectId: 'project-1', buildId: 'build-1' },
    });

    const runningBuild = makeBuild({ id: 'build-1', status: 'running' });
    stream.build.value = runningBuild;
    await nextTick();
    expect(wrapper.emitted('status')?.[0]?.[0]).toEqual(runningBuild);

    const endEvent = makeEnd({ buildId: 'build-1', status: 'succeeded', lastSeq: 2 });
    stream.end.value = endEvent;
    await nextTick();
    expect(wrapper.emitted('end')?.[0]?.[0]).toEqual(endEvent);
  });
});

describe('log viewer bounded updates', () => {
  it('updates when chunk count stays constant and preserves exact line breaks', async () => {
    const stream = createStreamMock(); mockUseBuildLogStream.mockReturnValue(stream);
    const wrapper = mount(BuildLogViewer, { props: { projectId: 'project-1', buildId: 'build-1' } });
    stream.chunks.value = [makeChunk(1, { content: 'first' }), makeChunk(2, { content: 'part' })]; await nextTick();
    expect(wrapper.get('pre').text()).toBe('firstpart');
    stream.chunks.value = [makeChunk(2, { content: 'part' }), makeChunk(3, { content: 'next\n' })]; await nextTick();
    expect(wrapper.get('pre').element.textContent).toBe('partnext\n'); expect(wrapper.text()).not.toContain('first');
  });
});

describe('B14 build environment choice', () => {
  it('passes an explicit environment while preserving preview as the default', async () => {
    mockTriggerBuild.mockResolvedValue(makeBuild());
    const wrapper = mount(BuildTriggerForm, { props: { projectId: 'project-1', canRun: true } });
    await wrapper.get('#build-source-ref').setValue('template:vue-web');
    await wrapper.get('#build-environment').setValue('production'); await wrapper.get('form').trigger('submit'); await flushPromises();
    expect(mockTriggerBuild).toHaveBeenCalledWith('project-1', 'template:vue-web', 'production');
    mockTriggerBuild.mockClear(); await wrapper.get('#build-environment').setValue('../invalid'); await wrapper.get('form').trigger('submit');
    expect(mockTriggerBuild).not.toHaveBeenCalled();
  });
});
