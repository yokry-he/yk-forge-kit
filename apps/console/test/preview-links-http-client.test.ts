import { afterEach, describe, expect, it, vi } from 'vitest';
import { listPreviewLinks, revokePreviewLink } from '../src/api/preview-links';

vi.mock('../src/auth/session', () => ({ getAccessToken: vi.fn(async () => 'access.secret') }));
afterEach(() => vi.unstubAllGlobals());

describe('preview link client through shared HTTP adapter', () => {
  it.each([204, 205])('accepts an empty %s DELETE response through the real shared client', async status => {
    const fetch = vi.fn().mockResolvedValue(new Response(null, { status }));
    vi.stubGlobal('fetch', fetch);

    await expect(revokePreviewLink('a/b', 'b/c', 'c/d')).resolves.toBeUndefined();

    const [url, init] = fetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/v1/projects/a%2Fb/builds/b%2Fc/preview-links/c%2Fd');
    expect(init.method).toBe('DELETE');
    expect(new Headers(init.headers).get('Authorization')).toBe('Bearer access.secret');
    expect(init.body).toBeUndefined();
  });

  it('still parses JSON metadata and preserves empty HTTP errors', async () => {
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(Response.json([]))
      .mockResolvedValueOnce(new Response(null, { status: 403 })));
    await expect(listPreviewLinks('project', 'build')).resolves.toEqual([]);
    await expect(revokePreviewLink('project', 'build', 'link')).rejects.toMatchObject({ status: 403 });
  });

  it('does not hide malformed JSON in successful responses that require a JSON body', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{', { status: 200 })));
    await expect(listPreviewLinks('project', 'build')).rejects.toBeInstanceOf(SyntaxError);
  });
});
