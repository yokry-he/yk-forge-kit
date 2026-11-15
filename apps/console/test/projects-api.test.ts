import { afterEach, describe, expect, it, vi } from 'vitest';
import { ProjectApiError, listProjects, saveProject } from '../src/api/projects';
import { listProjectAssets, planProjectAsset } from '../src/api/project-assets';
import { listProjectMembers, updateProjectMemberRole } from '../src/api/project-members';
import { issueInvitation, listInvitations, redeemInvitation, revokeInvitation } from '../src/api/invitations';
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

  it('loads project members and submits scoped role updates', async () => {
    const fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ members: [], currentRole: null, currentUserId: null }) });
    vi.stubGlobal('fetch', fetch);
    await listProjectMembers('my-app');
    await updateProjectMemberRole('my-app', 'user-id', 'viewer');
    expect(fetch).toHaveBeenNthCalledWith(1, '/api/v1/projects/my-app/members', expect.any(Object));
    expect(fetch).toHaveBeenNthCalledWith(2, '/api/v1/projects/my-app/members/user-id', expect.objectContaining({ method: 'PATCH', body: '{"role":"viewer"}' }));
  });

  it('issues, lists and redeems scoped one-time invitations', async () => {
    const fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ code: 'a'.repeat(43) }) });
    vi.stubGlobal('fetch', fetch);
    await issueInvitation('my-app', 'editor');
    await listInvitations('my-app');
    await redeemInvitation('a'.repeat(43));
    await revokeInvitation('my-app', 'invitation-id');
    expect(fetch).toHaveBeenNthCalledWith(1, '/api/v1/projects/my-app/invitations', expect.objectContaining({ method: 'POST', body: '{"role":"editor"}' }));
    expect(fetch).toHaveBeenNthCalledWith(2, '/api/v1/projects/my-app/invitations', expect.any(Object));
    expect(fetch).toHaveBeenNthCalledWith(3, '/api/v1/invitations/redeem', expect.objectContaining({ method: 'POST', body: JSON.stringify({ code: 'a'.repeat(43) }) }));
    expect(fetch).toHaveBeenNthCalledWith(4, '/api/v1/projects/my-app/invitations/invitation-id', expect.objectContaining({ method: 'DELETE' }));
  });
});
