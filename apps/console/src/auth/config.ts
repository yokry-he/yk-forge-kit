export type FrontendAuthConfig = { mode: 'local' } | { mode: 'oidc'; authority: string; clientId: string; resource?: string; allowHttpLoopback?: boolean };

export function parseFrontendAuthConfig(env: Record<string, string | boolean | undefined>): FrontendAuthConfig {
  const mode = env.VITE_AUTH_MODE ?? 'local';
  if (mode === 'local') return { mode };
  if (mode !== 'oidc') throw new Error('VITE_AUTH_MODE 仅支持 local 或 oidc。');
  const authority = env.VITE_OIDC_AUTHORITY;
  const clientId = env.VITE_OIDC_CLIENT_ID;
  if (typeof authority !== 'string' || typeof clientId !== 'string' || !authority || !clientId || clientId.trim() !== clientId) throw new Error('需要配置 OIDC Authority 和 Client ID。');
  let parsed: URL;
  try { parsed = new URL(authority); }
  catch { throw new Error('OIDC Authority 地址无效。'); }
  const allowHttpLoopback = env.DEV === true && env.VITE_OIDC_DEV_ALLOW_HTTP_LOOPBACK === 'true';
  const localHttp = allowHttpLoopback && parsed.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(parsed.hostname);
  if ((parsed.protocol !== 'https:' && !localHttp) || parsed.username || parsed.password || parsed.hash || parsed.search) {
    throw new Error('OIDC Authority 必须使用 HTTPS 且不包含凭证或查询参数。');
  }
  return { mode, authority, clientId,
    ...(typeof env.VITE_OIDC_RESOURCE === 'string' && env.VITE_OIDC_RESOURCE ? { resource: env.VITE_OIDC_RESOURCE } : {}),
    ...(localHttp ? { allowHttpLoopback: true } : {}) };
}
