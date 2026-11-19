import { apiRequest } from './projects';

export interface VerifiedIdentity { issuer: string; subject: string }
export interface AccountProfile { id: string; displayName: string; createdAt: string }

/** Server-verified identity. Never treat a browser ID token as API authorization. */
export async function verifyCurrentIdentity(): Promise<VerifiedIdentity> {
  const value: unknown = await apiRequest<unknown>('/auth/whoami');
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      !('issuer' in value) || typeof value.issuer !== 'string' || !value.issuer ||
      !('subject' in value) || typeof value.subject !== 'string' || !value.subject) {
    throw new Error('API 返回了无效的身份信息。');
  }
  return { issuer: value.issuer, subject: value.subject };
}

/** An explicit, idempotent POST provisions the account without granting project access. */
export async function initializeCurrentAccount(): Promise<AccountProfile> {
  const value: unknown = await apiRequest<unknown>('/auth/account', { method: 'POST' });
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      !('id' in value) || typeof value.id !== 'string' || !value.id ||
      !('displayName' in value) || typeof value.displayName !== 'string') {
    throw new Error('API 返回了无效的账户信息。');
  }
  return value as AccountProfile;
}

export async function updateCurrentAccountDisplayName(displayName: string): Promise<AccountProfile> {
  return apiRequest<AccountProfile>('/auth/account', {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ displayName }),
  });
}
