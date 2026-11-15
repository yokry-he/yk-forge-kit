import { apiRequest, projectRequest } from './projects';

export interface IssuedInvitation { code: string; role: 'editor' | 'viewer'; expiresAt: string }
export interface InvitationSummary { id: string; role: 'editor' | 'viewer'; createdAt: string; expiresAt: string; redeemedAt: string | null }

export function issueInvitation(slug: string, role: 'editor' | 'viewer'): Promise<IssuedInvitation> {
  return projectRequest<IssuedInvitation>(`/${encodeURIComponent(slug)}/invitations`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ role }),
  });
}

export function listInvitations(slug: string): Promise<InvitationSummary[]> {
  return projectRequest<InvitationSummary[]>(`/${encodeURIComponent(slug)}/invitations`);
}

export function redeemInvitation(code: string): Promise<{ projectSlug: string; role: 'editor' | 'viewer' }> {
  return apiRequest('/invitations/redeem', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code }),
  });
}
