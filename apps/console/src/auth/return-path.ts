/** Only internal project routes may survive an external OIDC round trip. */
export function safeProjectReturnPath(value: unknown): string {
  if (typeof value !== 'string' || value.length > 512 || !/^\/projects(?:\/|[?#]|$)/.test(value) ||
      value.startsWith('//') || /[\\\u0000-\u001f\u007f]/.test(value)) return '/projects';
  return value;
}

export function returnPathFromOidcState(value: unknown): string {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !('returnTo' in value)) return '/projects';
  return safeProjectReturnPath(value.returnTo);
}

export function requiresOidcProjectAccess(path: string): boolean {
  return path === '/projects' || path.startsWith('/projects/');
}
