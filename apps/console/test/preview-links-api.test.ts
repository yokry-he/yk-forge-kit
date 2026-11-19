import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createPreviewLink, listPreviewLinks, revokePreviewLink } from '../src/api/preview-links';
import { projectRequest } from '../src/api/projects';
vi.mock('../src/api/projects', () => ({ projectRequest: vi.fn() }));
const request = vi.mocked(projectRequest);
const id = '11111111-1111-4111-8111-111111111111';
const metadata = { id, buildId: id, createdBy: id, createdAt: '2026-11-19T00:00:00.000Z', expiresAt: '2099-01-01T00:00:00.000Z', revokedAt: null, lastAccessedAt: null };
beforeEach(() => { request.mockReset(); });
describe('preview link API client', () => {
  it('uses the existing authenticated project client and strict creation contract', async () => {
    const result = { previewLink: metadata, token: 'a'.repeat(43), url: 'https://credential.preview.example/' };
    request.mockResolvedValue(result);
    expect(await createPreviewLink(id, id)).toEqual(result);
    expect(request).toHaveBeenCalledWith(`/${id}/builds/${id}/preview-links`, expect.objectContaining({ method: 'POST', body: '{"ttlSeconds":86400}' }));
  });
  it('rejects out-of-bound TTLs before sending requests', async () => {
    for (const ttl of [299, 604801, 1.5]) expect(() => createPreviewLink(id, id, ttl)).toThrow();
    expect(request).not.toHaveBeenCalled();
  });
  it('lists only strict metadata, rejecting token, URL and digest leakage', async () => {
    request.mockResolvedValue([metadata]); expect(await listPreviewLinks(id, id)).toEqual([metadata]);
    for (const field of ['token', 'url', 'tokenHash']) {
      request.mockResolvedValue([{ ...metadata, [field]: 'secret' }]); await expect(listPreviewLinks(id, id)).rejects.toThrow();
    }
  });
  it('encodes identifiers for DELETE and preserves existing auth/error behavior', async () => {
    request.mockResolvedValue(undefined); await revokePreviewLink('a/b', 'b/c', 'c/d');
    expect(request).toHaveBeenCalledWith('/a%2Fb/builds/b%2Fc/preview-links/c%2Fd', { method: 'DELETE' });
    const error = new Error('network'); request.mockRejectedValue(error);
    await expect(listPreviewLinks(id, id)).rejects.toBe(error);
  });
});
