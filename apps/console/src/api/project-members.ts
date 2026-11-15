import type { ProjectMembersResponse } from '@forgekit/contracts';
import { projectRequest } from './projects';

export function listProjectMembers(slug: string): Promise<ProjectMembersResponse> {
  return projectRequest<ProjectMembersResponse>(`/${encodeURIComponent(slug)}/members`);
}

export function updateProjectMemberRole(slug: string, userId: string, role: 'editor' | 'viewer'): Promise<{ userId: string; role: string }> {
  return projectRequest(`/${encodeURIComponent(slug)}/members/${encodeURIComponent(userId)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ role }),
  });
}
