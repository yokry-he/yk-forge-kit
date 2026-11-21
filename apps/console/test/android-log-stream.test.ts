import { afterEach, describe, expect, it, vi } from 'vitest';
import { flushPromises } from '@vue/test-utils';
import { effectScope, nextTick, ref } from 'vue';
import { AndroidJobSchema } from '@forgekit/contracts';
import { useAndroidLogStream } from '../src/composables/useAndroidLogStream';
import { createAndroidStreamTicket, listAndroidLogs } from '../src/api/android';
vi.mock('../src/api/android', () => ({ createAndroidStreamTicket: vi.fn(), listAndroidLogs: vi.fn(), androidLogStreamUrl: () => '/stream' }));
const id = '11111111-1111-4111-8111-111111111111';
class FakeSource {
  static latest: FakeSource;
  listeners: Record<string, (event: unknown) => void> = {}; close = vi.fn(); onerror?: () => void;
  constructor(_url: string) { FakeSource.latest = this; }
  addEventListener(name: string, listener: (event: unknown) => void) { this.listeners[name] = listener; }
  emit(name: string, data: unknown, lastEventId = '') { this.listeners[name]?.({ data: JSON.stringify(data), lastEventId }); }
}
afterEach(() => { vi.clearAllMocks(); vi.unstubAllGlobals(); });
describe('Android log resume protocol', () => {
  it('fills sequence gaps, validates job status and closes terminal streams', async () => {
    vi.stubGlobal('EventSource', FakeSource); vi.mocked(createAndroidStreamTicket).mockResolvedValue({ ticket: 'a'.repeat(43), expiresAt: '2030-01-01T00:00:00Z' });
    const scope = effectScope(); const stream = scope.run(() => useAndroidLogStream(ref(id), ref(id)))!;
    try {
      await nextTick(); await Promise.resolve();
      const chunk = (seq: number) => ({ seq, stream: 'system' as const, content: '安全日志\n', ts: '2026-11-20T00:00:00Z' });
      vi.mocked(listAndroidLogs).mockResolvedValue([{ ...chunk(1), jobId: id }]);
      FakeSource.latest.emit('log', chunk(2), '2');
      await flushPromises();
      expect(stream.chunks.value.map(chunk => chunk.seq)).toEqual([1, 2]);
      const job = AndroidJobSchema.parse({ id, projectId: id, settings: { packageName: 'com.example.demo', appId: '__UNI__TEST123', appKey: 'synthetic-appkey', versionName: '1.0.0', versionCode: 1 }, triggeredBy: id, input: { buildType: 'debug', kind: 'apk' }, status: 'succeeded', errorCode: null, artifact: null,
        startedAt: null, finishedAt: null, createdAt: '2026-11-22T00:00:00Z', updatedAt: '2026-11-22T00:00:00Z' });
      FakeSource.latest.emit('status', { job: job });
      FakeSource.latest.emit('end', { jobId: id, status: 'succeeded', lastSeq: 2 });
      expect(stream.state.value).toBe('ended'); expect(stream.job.value?.id).toBe(id); expect(FakeSource.latest.close).toHaveBeenCalled();
    } finally { scope.stop(); }
  });
});
