import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('optional development Keycloak realm', () => {
  const realm = JSON.parse(readFileSync(new URL('../../../infra/keycloak/forgekit-dev-realm.json', import.meta.url), 'utf8'));
  const web = realm.clients.find((client: { clientId: string }) => client.clientId === 'forgekit-web');

  it('only enables public authorization code with S256 PKCE', () => {
    expect(web).toBeDefined();
    expect(web.publicClient).toBe(true);
    expect(web.standardFlowEnabled).toBe(true);
    expect(web.implicitFlowEnabled).toBe(false);
    expect(web.directAccessGrantsEnabled).toBe(false);
    expect(web.serviceAccountsEnabled).toBe(false);
    expect(web.attributes['pkce.code.challenge.method']).toBe('S256');
  });

  it('pins localhost callbacks and grants the API audience in access tokens only', () => {
    expect(web.redirectUris).toHaveLength(4);
    expect(web.redirectUris.every((uri: string) => /^http:\/\/(127\.0\.0\.1|localhost):5173\/auth\/(callback|logout-callback)$/.test(uri))).toBe(true);
    expect(web.webOrigins).toEqual(['http://127.0.0.1:5173', 'http://localhost:5173']);
    const mapper = web.protocolMappers.find((entry: { protocolMapper: string }) => entry.protocolMapper === 'oidc-audience-mapper');
    expect(mapper.config).toMatchObject({ 'included.custom.audience': 'forgekit-api', 'access.token.claim': 'true', 'id.token.claim': 'false' });
  });

  it('does not seed credentials or enable public registration', () => {
    expect(realm.registrationAllowed).toBe(false);
    expect(realm.users).toBeUndefined();
    expect(realm.clients.every((client: { secret?: string }) => client.secret === undefined)).toBe(true);
  });
});
