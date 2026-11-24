import { describe, expect, it } from 'vitest';
import { workerErrorDetails } from '../src/diagnostics';

describe('worker error diagnostics', () => {
  it('keeps messages, stack locations and nested causes', () => {
    const cause = new Error('Redis connection refused');
    const result = workerErrorDetails(new Error('startup failed', { cause }), {}).error;
    expect(result).toContain('Error: startup failed');
    expect(result).toContain('diagnostics.test.ts:');
    expect(result).toContain('Caused by: Error: Redis connection refused');
  });

  it('redacts URL userinfo for all protocols, standalone secrets, keys, tokens and PEM', () => {
    const databasePassword = 'db:private-value';
    const key = 'unit-test-encryption-value';
    const pem = '-----BEGIN PRIVATE KEY-----\nprivate-pem-line\n-----END PRIVATE KEY-----';
    const error = new Error(`cannot connect mysql://db-user:db%3Aprivate-value@localhost/test, redis://:redis-auth@localhost/0\n` +
      `driver password '${databasePassword}'; key ${key}; password="unknown passphrase-tail" api_key=unknown-key; ` +
      `Authorization: Bearer unknown-token; eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ0ZXN0In0.signature\n${pem}`);
    const result = workerErrorDetails(error, {
      DATABASE_URL: 'mysql://db-user:db%3Aprivate-value@localhost/test', FORGEKIT_DEPLOY_ENCRYPTION_KEY: key,
    }).error;
    for (const secret of [databasePassword, 'db%3Aprivate-value', 'db-user', 'redis-auth', key,
      'unknown', 'passphrase-tail', 'unknown-key', 'unknown-token', 'private-pem-line', 'signature']) expect(result).not.toContain(secret);
    expect(result).toContain('cannot connect mysql://[REDACTED]@localhost/test');
    expect(result).toContain('redis://[REDACTED]@localhost/0');
    expect(result).toContain('diagnostics.test.ts:');
  });

  it('redacts short configured passwords and JSON-escaped multiline secrets', () => {
    const secret = 'first-secret-line\nsecond-secret-line';
    const result = workerErrorDetails(new Error(`password x; ${JSON.stringify(secret)}`), {
      DATABASE_URL: 'mysql://user:x@localhost/test', OIDC_CLIENT_SECRET: secret,
    }).error;
    expect(result).not.toContain('password x');
    expect(result).not.toContain('first-secret-line');
    expect(result).not.toContain('second-secret-line');
  });

  it.each(['test"quoted-suffix', 'test\\"quoted-suffix', 'test\\quoted-suffix', 'test"\nquoted-suffix'])(
    'redacts configured JSON-escaped credentials before generic substitutions (case %#)', password => {
      const result = workerErrorDetails(new Error(
        `connection failed: ${JSON.stringify({ password })}; value ${JSON.stringify(password)}; retry later`,
      ), { DATABASE_PASSWORD: password, LEGACY_PASSWORD: 'test' }).error;
      expect(result).not.toContain('quoted-suffix');
      expect(result).toContain('connection failed: {"password":[REDACTED]}');
      expect(result).toContain('value "[REDACTED]"; retry later');
    },
  );

  it.each([
    JSON.stringify({ password: 'test"quoted-suffix' }),
    JSON.stringify({ password: 'test\\"quoted-suffix' }),
    JSON.stringify({ password: 'test\\' }),
    "password='test\\'quoted-suffix'",
  ])('redacts complete quoted credentials with escaped characters (case %#)', credential => {
    const result = workerErrorDetails(new Error(`connection failed: ${credential}; retry later`), {}).error;
    expect(result).not.toContain('quoted-suffix');
    expect(result).toContain(credential.startsWith('{') ? '{"password":[REDACTED]}' : 'password=[REDACTED]');
    expect(result).toContain('; retry later');
  });

  it('handles circular causes and never serializes arbitrary thrown config objects', () => {
    const error = new Error('cycle'); error.cause = error;
    expect(workerErrorDetails(error, {}).error).toContain('[circular cause]');
    expect(workerErrorDetails({ password: 'private' }, {}).error).toBe('Unknown worker error');
  });
});
