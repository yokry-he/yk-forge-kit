import { afterEach, describe, expect, it, vi } from 'vitest';
import { listBuilds, createBuildStreamTicket, buildLogStreamUrl } from '../src/api/builds';
import { ProjectApiError } from '../src/api/projects';
vi.mock('../src/auth/session', () => ({ getAccessToken: vi.fn(async () => 'access.secret') }));
afterEach(() => vi.unstubAllGlobals());
describe('build client through shared HTTP adapter', () => {
  it('inherits Bearer for REST and ticket POST while stream URL only contains its ticket', async () => {
    const ticket = 'a'.repeat(43);
    const fetch = vi.fn().mockResolvedValueOnce({ ok: true, json: async () => [] }).mockResolvedValueOnce({ ok: true, json: async () => ({ ticket, expiresAt: '2026-11-19T00:00:00.000Z' }) });
    vi.stubGlobal('fetch', fetch); await listBuilds('project-uuid', { limit: 50 });
    await createBuildStreamTicket('project-uuid', 'build-uuid');
    expect(fetch.mock.calls[0]![0]).toBe('/api/v1/projects/project-uuid/builds?limit=50');
    for (const [url, init] of fetch.mock.calls as [string, RequestInit][]) {
      expect(url).not.toContain('access.secret'); expect(new Headers(init.headers).get('authorization')).toBe('Bearer access.secret');
    }
    expect(fetch.mock.calls[1]![1].method).toBe('POST');
    const streamUrl = buildLogStreamUrl('project-uuid', 'build-uuid', { after: 7, ticket });
    expect(streamUrl).toContain(`after=7&ticket=${ticket}`); expect(streamUrl).not.toContain('access.secret');
  });
  it('propagates explicit 401 and maps a network failure to status zero', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 401, json: async () => ({ message: 'unauthorized' }) }));
    await expect(listBuilds('uuid')).rejects.toMatchObject({ status: 401 });
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('network')));
    await expect(listBuilds('uuid')).rejects.toBeInstanceOf(ProjectApiError);
    await expect(listBuilds('uuid')).rejects.toMatchObject({ status: 0 });
  });
});
