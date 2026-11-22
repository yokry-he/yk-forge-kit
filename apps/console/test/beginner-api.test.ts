import { afterEach, describe, expect, it, vi } from 'vitest';
import { classifyNeed, getBeginnerConfig, saveBeginnerConfig, deleteBeginnerConfig } from '../src/api/beginner';
import { getAccessToken } from '../src/auth/session';
vi.mock('../src/auth/session', () => ({ getAccessToken: vi.fn(async () => 'oidc-token') }));
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
describe('B21 HTTP client', () => {
  it('waits beyond the server AI deadline while retaining the normal auth transport', async () => {
    const fetcher = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ source: 'keywords' }) });
    vi.stubGlobal('fetch', fetcher); const timeout = vi.spyOn(AbortSignal, 'timeout');
    await classifyNeed('A company site');
    expect(timeout).toHaveBeenCalledWith(15_000);
    const [path, init] = fetcher.mock.calls[0] as [string, RequestInit];
    expect(path).toBe('/api/v1/beginner/classify'); expect(init.body).toBe(JSON.stringify({ description: 'A company site' }));
    expect(new Headers(init.headers).get('Authorization')).toBe('Bearer oidc-token'); expect(getAccessToken).toHaveBeenCalled();
  });
  it('uses redacted reads, write-only updates and idempotent DELETE without a JSON body', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce({ ok: true, json: async () => ({ configured: true }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ configured: true }) })
      .mockResolvedValueOnce({ ok: true, status: 204 });
    vi.stubGlobal('fetch', fetcher);
    expect(await getBeginnerConfig()).toEqual({ configured: true });
    await saveBeginnerConfig({ provider: 'DeepSeek', baseUrl: 'https://api.deepseek.com', model: 'deepseek-chat', apiKey: '' });
    await deleteBeginnerConfig();
    expect(fetcher.mock.calls.map(c => c[0])).toEqual(Array(3).fill('/api/v1/beginner/ai-config'));
    expect(fetcher.mock.calls[1]![1]).toMatchObject({ method: 'PUT' });
    expect(JSON.parse(fetcher.mock.calls[1]![1].body).apiKey).toBe('');
    expect(fetcher.mock.calls[2]![1]).toMatchObject({ method: 'DELETE' });
    expect(fetcher.mock.calls[2]![1].body).toBeUndefined();
  });
});
