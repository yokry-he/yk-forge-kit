export type FrontendAuthConfig = { mode: 'local' } | { mode: 'oidc'; authority: string; clientId: string; resource?: string };

export function parseFrontendAuthConfig(env: Record<string, string | undefined>): FrontendAuthConfig {
  const mode = env.VITE_AUTH_MODE ?? 'local';
  if (mode === 'local') return { mode };
  if (mode !== 'oidc') throw new Error('VITE_AUTH_MODE 仅支持 local 或 oidc。');
  const authority = env.VITE_OIDC_AUTHORITY;
  const clientId = env.VITE_OIDC_CLIENT_ID;
  if (!authority || !clientId || clientId.trim() !== clientId) throw new Error('需要配置 OIDC Authority 和 Client ID。');
  let parsed: URL;
  try { parsed = new URL(authority); }
  catch { throw new Error('OIDC Authority 地址无效。'); }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.hash || parsed.search) {
    throw new Error('OIDC Authority 必须使用 HTTPS 且不包含凭证或查询参数。');
  }
  return { mode, authority, clientId, ...(env.VITE_OIDC_RESOURCE ? { resource: env.VITE_OIDC_RESOURCE } : {}) };
}
