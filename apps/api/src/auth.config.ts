import type { OidcVerifierConfig } from '@forgekit/identity-core';

type Environment = Record<string, string | undefined>;
export type AuthConfig = { mode: 'local' } | { mode: 'oidc'; verifier: OidcVerifierConfig };

/** Fail closed for production or public interfaces. Local mode never impersonates a user. */
export function resolveAuthConfig(env: Environment): AuthConfig {
  const mode = env.AUTH_MODE ?? (env.NODE_ENV === 'production' ? 'oidc' : 'local');
  if (mode === 'local') {
    const host = env.API_HOST ?? '127.0.0.1';
    if (env.NODE_ENV === 'production' || !['127.0.0.1', '::1', 'localhost'].includes(host)) {
      throw new Error('本地认证模式仅允许非生产环境监听本机回环地址。');
    }
    return { mode: 'local' };
  }
  if (mode !== 'oidc') throw new Error('AUTH_MODE 仅支持 local 或 oidc。');
  if (!env.OIDC_ISSUER || !env.OIDC_API_AUDIENCE || !env.OIDC_JWKS_URL) {
    throw new Error('OIDC 模式必须配置 OIDC_ISSUER、OIDC_API_AUDIENCE、OIDC_JWKS_URL。');
  }
  return { mode: 'oidc', verifier: { issuer: env.OIDC_ISSUER, audience: env.OIDC_API_AUDIENCE, jwksUrl: env.OIDC_JWKS_URL } };
}

