import { afterEach, describe, expect, it, vi } from 'vitest';
import { flushPromises } from '@vue/test-utils';
import { effectScope, nextTick, ref } from 'vue';
import { WeappJobSchema } from '@forgekit/contracts';
import { useWeappLogStream } from '../src/composables/useWeappLogStream';
import { createWeappStreamTicket, listWeappLogs } from '../src/api/weapp';
vi.mock('../src/api/weapp', () => ({ createWeappStreamTicket: vi.fn(), listWeappLogs: vi.fn(), weappLogStreamUrl: () => '/stream' }));
const id = '11111111-1111-4111-8111-111111111111';
class FakeSource {
  static latest: FakeSource;
  listeners: Record<string, (event: unknown) => void> = {}; close = vi.fn(); onerror?: () => void;
  constructor(_url: string) { FakeSource.latest = this; }
  addEventListener(name: string, listener: (event: unknown) => void) { this.listeners[name] = listener; }
  emit(name: string, data: unknown, lastEventId = '') { this.listeners[name]?.({ data: JSON.stringify(data), lastEventId }); }
}
afterEach(() => { vi.clearAllMocks(); vi.unstubAllGlobals(); });
describe('deploy log resume protocol', () => {
  it('fills sequence gaps, validates job status and closes terminal streams', async () => {
    vi.stubGlobal('EventSource', FakeSource); vi.mocked(createWeappStreamTicket).mockResolvedValue({ ticket: 'a'.repeat(43), expiresAt: '2030-01-01T00:00:00Z' });
    const scope = effectScope(); const stream = scope.run(() => useWeappLogStream(ref(id), ref(id)))!;
    try {
      await nextTick(); await Promise.resolve();
      const chunk = (seq: number) => ({ seq, stream: 'system' as const, content: '安全日志\n', ts: '2026-11-20T00:00:00Z' });
      vi.mocked(listWeappLogs).mockResolvedValue([{ ...chunk(1), jobId: id }]);
      FakeSource.latest.emit('log', chunk(2), '2');
      await flushPromises();
      expect(stream.chunks.value.map(chunk => chunk.seq)).toEqual([1, 2]);
      const job = WeappJobSchema.parse({ id, projectId: id, buildId: id, appId: 'wx0000000000000000', triggeredBy: id, input: { buildId: id, version: '1.0.0', action: 'preview' }, status: 'succeeded', errorCode: null, hasQrCode: true,
        startedAt: null, finishedAt: null, createdAt: '2026-11-22T00:00:00Z', updatedAt: '2026-11-22T00:00:00Z' });
      FakeSource.latest.emit('status', { job: job });
      FakeSource.latest.emit('end', { jobId: id, status: 'succeeded', lastSeq: 2 });
      expect(stream.state.value).toBe('ended'); expect(stream.job.value?.id).toBe(id); expect(FakeSource.latest.close).toHaveBeenCalled();
    } finally { scope.stop(); }
  });
});
