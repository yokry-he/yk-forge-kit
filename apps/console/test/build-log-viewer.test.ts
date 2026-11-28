// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { enableAutoUnmount, mount } from '@vue/test-utils';
import { nextTick } from 'vue';
import type { BuildLogChunk } from '@forgekit/contracts';
import BuildLogViewer from '../src/components/builds/BuildLogViewer.vue';
import * as logText from '../src/utils/build-log-text';

vi.mock('../src/auth/session', () => ({ oidcEnabled: false }));
vi.mock('../src/api/builds', () => ({
  createBuildStreamTicket: vi.fn(),
  listBuildLogs: vi.fn(),
  buildLogStreamUrl: () => '/logs/stream',
}));

class FakeEventSource extends EventTarget {
  static last: FakeEventSource;
  onerror = null;
  close = vi.fn();
  constructor() { super(); FakeEventSource.last = this; }
  emitLog(seq: number, stream: BuildLogChunk['stream'], content: string) {
    const chunk: BuildLogChunk = { seq, stream, content, ts: '2026-01-01T00:00:00.000Z' };
    this.dispatchEvent(new MessageEvent('log', { data: JSON.stringify(chunk), lastEventId: String(seq) }));
  }
}

enableAutoUnmount(afterEach);
beforeEach(() => { vi.stubGlobal('EventSource', FakeEventSource); });
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('BuildLogViewer with the real log stream composable', () => {
  it('names the log card and groups status, labelled auto-scroll and refresh in its header', () => {
    const wrapper = mount(BuildLogViewer, { props: { projectId: 'project-1', buildId: 'build-1' } });
    expect(wrapper.get('header h2').text()).toBe('构建日志');
    expect(wrapper.get('header [role="status"]').exists()).toBe(true);
    expect(wrapper.get('header label').text()).toBe('自动滚动');
    expect(wrapper.get('header label input').attributes('type')).toBe('checkbox');
    expect(wrapper.get('header button').text()).toBe('刷新日志');
    expect(wrapper.get('[aria-label="构建日志内容"]').attributes('tabindex')).toBe('0');
  });
  it('removes split ANSI controls while rendering HTML as literal text', async () => {
    const wrapper = mount(BuildLogViewer, { props: { projectId: 'project-1', buildId: 'build-1' } });
    FakeEventSource.last.emitLog(1, 'stdout', '\x1b[3'); await nextTick();
    FakeEventSource.last.emitLog(2, 'stdout', '1m<b>safe</b>\x1b[0m'); await nextTick();
    expect(wrapper.get('pre').text()).toBe('<b>safe</b>');
    expect(wrapper.find('b').exists()).toBe(false);
  });

  it('sanitizes only in the composable and retains interleaved stderr during stdout OSC', async () => {
    const createSanitizer = vi.spyOn(logText, 'createBuildLogTextSanitizer');
    const wrapper = mount(BuildLogViewer, { props: { projectId: 'project-1', buildId: 'build-1' } });
    FakeEventSource.last.emitLog(1, 'stdout', '\x1b]0;hidden'); await nextTick();
    FakeEventSource.last.emitLog(2, 'stderr', 'BUILD FAILED'); await nextTick();
    FakeEventSource.last.emitLog(3, 'stdout', '\x07done\n'); await nextTick();
    expect(wrapper.get('.build-log-stderr').text()).toBe('BUILD FAILED');
    expect(wrapper.get('pre').element.textContent).toBe('BUILD FAILEDdone\n');
    expect(createSanitizer).toHaveBeenCalledTimes(3);
  });
});
