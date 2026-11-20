import { afterEach, describe, expect, it, vi } from 'vitest';
import { flushPromises } from '@vue/test-utils';
import { effectScope, nextTick, ref } from 'vue';
import { DeploymentSchema } from '@forgekit/contracts';
import { useDeployLogStream } from '../src/composables/useDeployLogStream';
import { createDeployStreamTicket, listDeployLogs } from '../src/api/deploys';
vi.mock('../src/api/deploys', () => ({ createDeployStreamTicket: vi.fn(), listDeployLogs: vi.fn(), deployLogStreamUrl: () => '/stream' }));
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
  it('fills sequence gaps, validates deployment status and closes terminal streams', async () => {
    vi.stubGlobal('EventSource', FakeSource); vi.mocked(createDeployStreamTicket).mockResolvedValue({ ticket: 'a'.repeat(43), expiresAt: '2099-01-01T00:00:00Z' });
    const scope = effectScope(); const stream = scope.run(() => useDeployLogStream(ref(id), ref(id)))!;
    try {
      await nextTick(); await Promise.resolve();
      const chunk = (seq: number) => ({ seq, stream: 'system' as const, content: '安全日志\n', ts: '2026-11-20T00:00:00Z' });
      vi.mocked(listDeployLogs).mockResolvedValue([{ ...chunk(1), deploymentId: id }]);
      FakeSource.latest.emit('log', chunk(2), '2');
      await flushPromises();
      expect(stream.chunks.value.map(chunk => chunk.seq)).toEqual([1, 2]);
      const job = DeploymentSchema.parse({ id, projectId: id, buildId: id, deployTargetId: id, environmentId: id, status: 'succeeded',
        startedAt: null, finishedAt: null, createdAt: '2026-11-20T00:00:00Z', updatedAt: '2026-11-20T00:00:00Z' });
      FakeSource.latest.emit('status', { deployment: job });
      FakeSource.latest.emit('end', { deploymentId: id, status: 'succeeded', lastSeq: 2 });
      expect(stream.state.value).toBe('ended'); expect(stream.deployment.value?.id).toBe(id); expect(FakeSource.latest.close).toHaveBeenCalled();
    } finally { scope.stop(); }
  });
});
