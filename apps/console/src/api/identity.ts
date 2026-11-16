import { apiRequest } from './projects';

export interface VerifiedIdentity { issuer: string; subject: string }

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
