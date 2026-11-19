import { PreviewLinkCreateRequestSchema, PreviewLinkCreateResponseSchema, PreviewLinkSchema } from '@forgekit/contracts';
import { projectRequest } from './projects';
function path(projectId: string, buildId: string): string {
  return `/${encodeURIComponent(projectId)}/builds/${encodeURIComponent(buildId)}/preview-links`;
}
export function createPreviewLink(projectId: string, buildId: string, ttlSeconds?: number) {
  const input = PreviewLinkCreateRequestSchema.parse({ ttlSeconds });
  return projectRequest<unknown>(path(projectId, buildId), { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input) }).then(data => PreviewLinkCreateResponseSchema.parse(data));
}
export function listPreviewLinks(projectId: string, buildId: string) {
  return projectRequest<unknown>(path(projectId, buildId)).then(data => PreviewLinkSchema.array().parse(data));
}
export function revokePreviewLink(projectId: string, buildId: string, linkId: string): Promise<void> {
  return projectRequest<void>(`${path(projectId, buildId)}/${encodeURIComponent(linkId)}`, { method: 'DELETE' });
}
