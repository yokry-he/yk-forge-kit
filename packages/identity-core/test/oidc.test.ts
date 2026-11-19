import { describe, expect, it } from 'vitest';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from 'jose';
import { createOidcTokenVerifier, validateOidcVerifierConfig } from '../src/oidc';

const config = { issuer: 'https://idp.example.test/realms/forgekit', audience: 'forgekit-api', jwksUrl: 'https://idp.example.test/certs' };

describe('OIDC token verification', () => {
  it('rejects unsafe or incomplete verifier configuration', () => {
    expect(() => validateOidcVerifierConfig({ ...config, jwksUrl: 'http://idp.example.test/certs' })).toThrow();
    expect(() => validateOidcVerifierConfig({ ...config, issuer: 'http://127.0.0.1:18080/realms/dev', jwksUrl: 'http://127.0.0.1:18080/jwks' })).toThrow();
    expect(validateOidcVerifierConfig({ ...config, issuer: 'http://127.0.0.1:18080/realms/dev', jwksUrl: 'http://127.0.0.1:18080/jwks', allowHttpLoopback: true }).allowHttpLoopback).toBe(true);
    expect(() => validateOidcVerifierConfig({ ...config, issuer: 'http://idp.example.test/realms/dev', jwksUrl: 'http://idp.example.test/certs', allowHttpLoopback: true })).toThrow();
    expect(() => validateOidcVerifierConfig({ ...config, jwksUrl: 'https://other.example.test/certs' })).toThrow();
    expect(() => validateOidcVerifierConfig({ ...config, audience: '' })).toThrow();
    expect(() => validateOidcVerifierConfig({ ...config, issuer: `${config.issuer}?untrusted=true` })).toThrow();
  });

  it('verifies signature, issuer, audience and expiry against trusted keys', async () => {
    const { publicKey, privateKey } = await generateKeyPair('RS256');
    const jwk = await exportJWK(publicKey);
    const verify = createOidcTokenVerifier(config, createLocalJWKSet({ keys: [{ ...jwk, kid: 'dev-key', alg: 'RS256', use: 'sig' }] }));
    const sign = (issuer = config.issuer, audience = config.audience, expiry = '5m') => new SignJWT({})
      .setProtectedHeader({ alg: 'RS256', kid: 'dev-key' })
      .setIssuer(issuer).setAudience(audience).setSubject('user-42').setIssuedAt().setExpirationTime(expiry).sign(privateKey);

    expect(await verify(await sign())).toEqual({ issuer: config.issuer, subject: 'user-42' });
    await expect(verify(await sign('https://evil.example.test'))).rejects.toThrow();
    await expect(verify(await sign(config.issuer, 'wrong-api'))).rejects.toThrow();
    await expect(verify(await sign(config.issuer, config.audience, '-1m'))).rejects.toThrow();
    const { privateKey: stranger } = await generateKeyPair('RS256');
    const forged = await new SignJWT({}).setProtectedHeader({ alg: 'RS256', kid: 'dev-key' })
      .setIssuer(config.issuer).setAudience(config.audience).setSubject('attacker').setIssuedAt().setExpirationTime('5m').sign(stranger);
    await expect(verify(forged)).rejects.toThrow();
  });
});
