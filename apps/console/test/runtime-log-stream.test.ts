import { afterEach, describe, expect, it, vi } from 'vitest';
import { flushPromises } from '@vue/test-utils';
import { effectScope, nextTick, ref } from 'vue';
import { RuntimeLogSessionSchema } from '@forgekit/contracts';
import { useRuntimeLogStream } from '../src/composables/useRuntimeLogStream';
import { createRuntimeStreamTicket, listRuntimeLogs } from '../src/api/runtime-logs';
vi.mock('../src/api/runtime-logs', () => ({ createRuntimeStreamTicket: vi.fn(), listRuntimeLogs: vi.fn(), runtimeLogStreamUrl: () => '/stream', cancelRuntimeSession: vi.fn().mockResolvedValue(undefined) }));
const id = '11111111-1111-4111-8111-111111111111';
class FakeSource {
  static latest: FakeSource;
  listeners: Record<string, (event: unknown) => void> = {}; close = vi.fn(); onerror?: () => void;
  constructor(_url: string) { FakeSource.latest = this; }
  addEventListener(name: string, listener: (event: unknown) => void) { this.listeners[name] = listener; }
  emit(name: string, data: unknown, lastEventId = '') { this.listeners[name]?.({ data: JSON.stringify(data), lastEventId }); }
}
afterEach(() => { vi.clearAllMocks(); vi.unstubAllGlobals(); });
describe('runtime log resume protocol', () => {
  it('fills sequence gaps, validates session status and closes terminal streams', async () => {
    vi.stubGlobal('EventSource', FakeSource); vi.mocked(createRuntimeStreamTicket).mockResolvedValue({ ticket: 'a'.repeat(43), expiresAt: '2035-01-15T00:00:00.000Z' });
    const scope = effectScope(); const stream = scope.run(() => useRuntimeLogStream(ref(id), ref(id)))!;
    try {
      await nextTick(); await Promise.resolve();
      const chunk = (seq: number) => ({ seq, stream: 'system' as const, content: '安全日志\n', ts: '2026-11-20T00:00:00Z' });
      vi.mocked(listRuntimeLogs).mockResolvedValue([{ ...chunk(1), sessionId: id }]);
      FakeSource.latest.emit('log', chunk(2), '2');
      await flushPromises();
      expect(stream.chunks.value.map(chunk => chunk.seq)).toEqual([1, 2]);
      const job = RuntimeLogSessionSchema.parse({ id, projectId: id, domainId: id, deployTargetId: id, source: 'caddy-access', errorCode: null, status: 'ended',
        createdAt: '2026-11-20T00:00:00Z', expiresAt: '2026-11-20T00:01:00Z' });
      FakeSource.latest.emit('status', { session: job });
      FakeSource.latest.emit('end', { sessionId: id, status: 'ended', lastSeq: 2 });
      expect(stream.state.value).toBe('ended'); expect(stream.session.value?.id).toBe(id); expect(FakeSource.latest.close).toHaveBeenCalled();
    } finally { scope.stop(); }
  });
});
