import { Injectable, ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import { createOidcTokenVerifier, type AuthenticatedSubject } from '@forgekit/identity-core';
import { resolveAuthConfig } from './auth.config';

@Injectable()
export class AuthService {
  private readonly verifier: ((token: string) => Promise<AuthenticatedSubject>) | null;

  constructor() {
    const config = resolveAuthConfig(process.env);
    this.verifier = config.mode === 'oidc' ? createOidcTokenVerifier(config.verifier) : null;
  }

  async authenticate(authorization: string | undefined): Promise<AuthenticatedSubject> {
    if (!this.verifier) throw new ServiceUnavailableException('本机模式尚未启用 OIDC 登录。');
    const match = /^Bearer ([A-Za-z0-9_.-]+)$/.exec(authorization ?? '');
    if (!match?.[1]) throw new UnauthorizedException('缺少有效 Bearer 令牌。');
    try { return await this.verifier(match[1]); }
    catch { throw new UnauthorizedException('令牌验证失败。'); }
  }

  whoami(authorization: string | undefined): Promise<AuthenticatedSubject> {
    return this.authenticate(authorization);
  }
}
