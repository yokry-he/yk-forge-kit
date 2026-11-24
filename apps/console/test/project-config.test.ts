import { afterEach, describe, expect, it, vi } from 'vitest';
import { getWeappConfig, listWeappJobs } from '../src/api/weapp';
import { getAlipayConfig } from '../src/api/alipay';
import { getAndroidConfig } from '../src/api/android';

vi.mock('../src/auth/session', () => ({ getAccessToken: vi.fn(async () => null) }));
afterEach(() => vi.unstubAllGlobals());

describe.each([
  ['weapp', getWeappConfig], ['alipay', getAlipayConfig], ['android', getAndroidConfig],
] as const)('%s optional setup', (_name, read) => {
  it.each([null, { configured: false }])('accepts an explicit unconfigured response: %j', async data => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => data }));
    expect(await read('project')).toBeNull();
  });
  it('treats only a config-read 404 as missing setup', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 404, json: async () => ({ message: 'missing config' }) }));
    expect(await read('project')).toBeNull();
    await expect(listWeappJobs('project')).rejects.toMatchObject({ status: 404 });
  });
  it.each([403, 500, 503])('preserves HTTP %i failures', async status => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status, json: async () => ({ configured: false }) }));
    await expect(read('project')).rejects.toMatchObject({ status });
  });
  it('preserves network and malformed data failures', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('offline')));
    await expect(read('project')).rejects.toMatchObject({ status: 0 });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ hasPrivateKey: false }) }));
    await expect(read('project')).rejects.toThrow();
  });
});
