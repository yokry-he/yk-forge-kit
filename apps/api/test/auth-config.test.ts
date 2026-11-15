import { afterEach, describe, expect, it, vi } from 'vitest';
import { ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import { resolveAuthConfig } from '../src/auth.config';
import { AuthService } from '../src/auth.service';
import { ProjectApiGuard } from '../src/project-api.guard';
import { requireProjectAuth, type ProjectAuthRequest } from '../src/project-auth-context';

afterEach(() => vi.unstubAllEnvs());

describe('authentication configuration safety', () => {
  it('allows local development on loopback only', () => {
    expect(resolveAuthConfig({ API_HOST: '127.0.0.1' })).toEqual({ mode: 'local' });
    expect(() => resolveAuthConfig({ API_HOST: '0.0.0.0', AUTH_MODE: 'local' })).toThrow();
    expect(() => resolveAuthConfig({ API_HOST: '127.0.0.1', NODE_ENV: 'production', AUTH_MODE: 'local' })).toThrow();
  });

  it('does not invent a user in local mode', async () => {
    vi.stubEnv('AUTH_MODE', 'local');
    vi.stubEnv('API_HOST', '127.0.0.1');
    vi.stubEnv('NODE_ENV', 'development');
    await expect(new AuthService().whoami(undefined)).rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  it('requires a verified subject for project routes in OIDC mode', async () => {
    vi.stubEnv('AUTH_MODE', 'oidc');
    vi.stubEnv('OIDC_ISSUER', 'https://idp.example.test');
    vi.stubEnv('OIDC_API_AUDIENCE', 'forgekit-api');
    vi.stubEnv('OIDC_JWKS_URL', 'https://idp.example.test/certs');
    const authenticate = vi.fn().mockResolvedValue({ issuer: 'https://idp.example.test', subject: 'alice' });
    const guard = new ProjectApiGuard({ authenticate } as unknown as AuthService);
    const request: ProjectAuthRequest = { headers: { authorization: 'Bearer signed.jwt.value' } };
    const context = { switchToHttp: () => ({ getRequest: () => request }) };
    expect(await guard.canActivate(context as never)).toBe(true);
    expect(authenticate).toHaveBeenCalledWith('Bearer signed.jwt.value');
    expect(requireProjectAuth(request)).toEqual({ mode: 'oidc', issuer: 'https://idp.example.test', subject: 'alice' });
    authenticate.mockRejectedValueOnce(new UnauthorizedException());
    await expect(guard.canActivate(context as never)).rejects.toBeInstanceOf(UnauthorizedException);
    expect(() => requireProjectAuth({ headers: {} })).toThrow(UnauthorizedException);
  });
  it('requires OIDC settings in production and rejects unknown modes', () => {
    expect(() => resolveAuthConfig({ NODE_ENV: 'production' })).toThrow();
    expect(() => resolveAuthConfig({ AUTH_MODE: 'off' })).toThrow();
  });
  it('accepts explicit OIDC verifier settings', () => {
    const config = resolveAuthConfig({ AUTH_MODE: 'oidc', OIDC_ISSUER: 'https://idp.example.test', OIDC_API_AUDIENCE: 'forgekit-api', OIDC_JWKS_URL: 'https://idp.example.test/certs' });
    expect(config.mode).toBe('oidc');
  });
});
