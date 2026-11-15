import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose';

export interface OidcVerifierConfig {
  issuer: string;
  audience: string;
  jwksUrl: string;
}

export interface AuthenticatedSubject {
  issuer: string;
  subject: string;
}

export function validateOidcVerifierConfig(config: OidcVerifierConfig): OidcVerifierConfig {
  let issuer: URL;
  let jwks: URL;
  try {
    issuer = new URL(config.issuer);
    jwks = new URL(config.jwksUrl);
  } catch { throw new Error('OIDC issuer/JWKS 地址格式无效。'); }
  if (issuer.protocol !== 'https:' || jwks.protocol !== 'https:' || issuer.username || issuer.password || jwks.username || jwks.password ||
      issuer.hash || issuer.search || jwks.hash || jwks.search || issuer.origin !== jwks.origin || !config.audience?.trim() || config.audience !== config.audience.trim()) {
    throw new Error('OIDC 配置必须使用同源 HTTPS issuer/JWKS 和非空 API audience。');
  }
  return config;
}

/** Verification only. This does not perform login, session handling or project authorization. */
export function createOidcTokenVerifier(config: OidcVerifierConfig, keySet?: JWTVerifyGetKey) {
  const trusted = validateOidcVerifierConfig(config);
  const keys = keySet ?? createRemoteJWKSet(new URL(trusted.jwksUrl), { timeoutDuration: 3000, cooldownDuration: 30_000 });
  return async (token: string): Promise<AuthenticatedSubject> => {
    if (typeof token !== 'string' || token.length === 0 || token.length > 16_384) throw new Error('访问令牌长度无效。');
    const { payload } = await jwtVerify(token, keys, {
      issuer: trusted.issuer,
      audience: trusted.audience,
      algorithms: ['RS256', 'ES256'],
      clockTolerance: 5,
    });
    if (!payload.sub || typeof payload.exp !== 'number' || typeof payload.iat !== 'number' || payload.iat > Date.now() / 1000 + 5) {
      throw new Error('访问令牌缺少必要声明或签发时间无效。');
    }
    return { issuer: trusted.issuer, subject: payload.sub };
  };
}
