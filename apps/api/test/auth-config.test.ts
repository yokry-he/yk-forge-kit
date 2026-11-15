import { afterEach, describe, expect, it, vi } from 'vitest';
import { ForbiddenException, ServiceUnavailableException } from '@nestjs/common';
import { allowUnauthenticatedProjectRoutes, resolveAuthConfig } from '../src/auth.config';
import { AuthService } from '../src/auth.service';
import { ProjectApiGuard } from '../src/project-api.guard';

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

  it('blocks project routes in OIDC mode until membership enforcement exists', () => {
    vi.stubEnv('AUTH_MODE', 'oidc');
    vi.stubEnv('OIDC_ISSUER', 'https://idp.example.test');
    vi.stubEnv('OIDC_API_AUDIENCE', 'forgekit-api');
    vi.stubEnv('OIDC_JWKS_URL', 'https://idp.example.test/certs');
    const guard = new ProjectApiGuard();
    expect(() => guard.canActivate({} as never)).toThrow(ForbiddenException);
  });
  it('requires OIDC settings in production and rejects unknown modes', () => {
    expect(() => resolveAuthConfig({ NODE_ENV: 'production' })).toThrow();
    expect(() => resolveAuthConfig({ AUTH_MODE: 'off' })).toThrow();
  });
  it('accepts explicit OIDC verifier settings', () => {
    const config = resolveAuthConfig({ AUTH_MODE: 'oidc', OIDC_ISSUER: 'https://idp.example.test', OIDC_API_AUDIENCE: 'forgekit-api', OIDC_JWKS_URL: 'https://idp.example.test/certs' });
    expect(config.mode).toBe('oidc');
    expect(allowUnauthenticatedProjectRoutes(config)).toBe(false);
    expect(allowUnauthenticatedProjectRoutes({ mode: 'local' })).toBe(true);
  });
});
