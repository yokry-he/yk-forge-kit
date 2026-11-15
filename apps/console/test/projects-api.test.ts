import { afterEach, describe, expect, it, vi } from 'vitest';
import { ProjectApiError, listProjects, saveProject } from '../src/api/projects';
import { listProjectAssets, planProjectAsset } from '../src/api/project-assets';
import { getAccessToken } from '../src/auth/session';

vi.mock('../src/auth/session', () => ({ getAccessToken: vi.fn(async () => null) }));

afterEach(() => vi.unstubAllGlobals());

describe('project API client', () => {
  it('lists project records from the backend', async () => {
    const fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => [{ id: 'abc', slug: 'test' }] });
    vi.stubGlobal('fetch', fetch);
    expect(await listProjects()).toHaveLength(1);
    expect(fetch).toHaveBeenCalledWith('/api/v1/projects', expect.objectContaining({ signal: expect.any(AbortSignal) }));
  });

  it('sends a JSON project configuration', async () => {
    const fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ slug: 'demo' }) });
    vi.stubGlobal('fetch', fetch);
    await saveProject({ name: 'demo', template: 'vue-web', features: ['theme'] });
    expect(fetch).toHaveBeenCalledWith('/api/v1/projects', expect.objectContaining({
      method: 'POST', body: JSON.stringify({ name: 'demo', template: 'vue-web', features: ['theme'] }),
    }));
  });

  it('attaches a bearer access token without placing it in the URL or body', async () => {
    vi.mocked(getAccessToken).mockResolvedValueOnce('signed.access.token');
    const fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => [] });
    vi.stubGlobal('fetch', fetch);
    await listProjects();
    const [url, init] = fetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/v1/projects');
    expect(new Headers(init.headers).get('Authorization')).toBe('Bearer signed.access.token');
    expect(init.body).toBeUndefined();
  });

  it('reports duplicate project names', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 409, json: async () => ({ message: '项目名称已存在。' }) }));
    await expect(saveProject({ name: 'demo', template: 'vue-web', features: [] }))
      .rejects.toMatchObject({ message: '项目名称已存在。', status: 409 });
  });

  it('distinguishes network failure from HTTP errors', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));
    await expect(listProjects()).rejects.toBeInstanceOf(ProjectApiError);
    await expect(listProjects()).rejects.toMatchObject({ status: 0 });
  });

  it('loads and plans assets under the selected project', async () => {
    const fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => [] });
    vi.stubGlobal('fetch', fetch);
    await listProjectAssets('my-app');
    await planProjectAsset('my-app', 'official.theme');
    expect(fetch).toHaveBeenNthCalledWith(1, '/api/v1/projects/my-app/assets', expect.any(Object));
    expect(fetch).toHaveBeenNthCalledWith(2, '/api/v1/projects/my-app/assets', expect.objectContaining({ method: 'POST', body: '{"assetId":"official.theme"}' }));
  });
});
