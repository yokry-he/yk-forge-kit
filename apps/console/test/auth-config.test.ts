import { describe, expect, it } from 'vitest';
import { parseFrontendAuthConfig } from '../src/auth/config';

describe('frontend OIDC configuration', () => {
  it('defaults to local development without assuming an identity provider', () => {
    expect(parseFrontendAuthConfig({})).toEqual({ mode: 'local' });
  });
  it('requires a trusted HTTPS authority and public client identifier', () => {
    expect(() => parseFrontendAuthConfig({ VITE_AUTH_MODE: 'oidc' })).toThrow();
    expect(() => parseFrontendAuthConfig({ VITE_AUTH_MODE: 'oidc', VITE_OIDC_AUTHORITY: 'http://idp.test', VITE_OIDC_CLIENT_ID: 'spa' })).toThrow();
    expect(() => parseFrontendAuthConfig({ VITE_AUTH_MODE: 'disabled' })).toThrow();
  });
  it('accepts standard provider-neutral settings', () => {
    expect(parseFrontendAuthConfig({
      VITE_AUTH_MODE: 'oidc', VITE_OIDC_AUTHORITY: 'https://idp.example.test/realms/forgekit',
      VITE_OIDC_CLIENT_ID: 'forgekit-web', VITE_OIDC_RESOURCE: 'forgekit-api',
    })).toEqual({ mode: 'oidc', authority: 'https://idp.example.test/realms/forgekit', clientId: 'forgekit-web', resource: 'forgekit-api' });
  });
  it('only permits HTTP Keycloak on explicit Vite development localhost', () => {
    const env = { VITE_AUTH_MODE: 'oidc', VITE_OIDC_AUTHORITY: 'http://127.0.0.1:18080/realms/forgekit-dev',
      VITE_OIDC_CLIENT_ID: 'forgekit-web', VITE_OIDC_DEV_ALLOW_HTTP_LOOPBACK: 'true' };
    expect(() => parseFrontendAuthConfig(env)).toThrow();
    expect(() => parseFrontendAuthConfig({ ...env, DEV: false })).toThrow();
    expect(parseFrontendAuthConfig({ ...env, DEV: true })).toMatchObject({ mode: 'oidc', allowHttpLoopback: true });
    expect(() => parseFrontendAuthConfig({ ...env, DEV: true, VITE_OIDC_AUTHORITY: 'http://idp.example.test' })).toThrow();
  });
});
