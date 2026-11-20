import { describe, expect, it } from 'vitest';
import { EnvironmentVariableSchema, VariableInputSchema, VariableNameSchema, EnvironmentNameSchema } from '../src/environment-variables';
describe('B14 write-only contracts', () => {
  it('validates names, reserved runtime names and byte limits without normalizing values', () => {
    for (const name of ['PUBLIC_URL', '_KEY', 'DATABASE_URL']) expect(VariableNameSchema.safeParse(name).success).toBe(true);
    for (const name of ['lower', 'A=B', '1A', 'A'.repeat(129), 'FORGEKIT_DEPLOY_ENCRYPTION_KEY', 'FORGEKIT_OTHER', 'PATH', 'NODE_OPTIONS', 'LD_PRELOAD', 'LD_AUDIT', 'DOCKER_HOST', 'DOCKER_CONFIG', 'GCONV_PATH']) expect(VariableNameSchema.safeParse(name).success).toBe(false);
    for (const value of ['hello', 'hello\nworld', '  hello  ']) expect(VariableInputSchema.parse({ kind: 'secret', value }).value).toBe(value);
    for (const value of ['', 'abc', 'abcd\na', '    ', 'nul\0value', '界'.repeat(6000)]) expect(VariableInputSchema.safeParse({ kind: 'secret', value }).success).toBe(false);
    expect(VariableInputSchema.safeParse({ kind: 'plain', value: '' }).success).toBe(true);
    expect(VariableInputSchema.safeParse({ kind: 'plain' }).success).toBe(false);
    expect(VariableInputSchema.safeParse({ kind: 'secret', value: 'value', ciphertext: 'blob' }).success).toBe(false);
    expect(EnvironmentNameSchema.safeParse('../production').success).toBe(false);
  });
  it('cannot parse a response containing a secret or ciphertext', () => {
    const row = { name: 'KEY', kind: 'secret', updatedAt: '2026-11-21T00:00:00Z', updatedBy: '11111111-1111-4111-8111-111111111111' };
    expect(EnvironmentVariableSchema.safeParse(row).success).toBe(true);
    expect(EnvironmentVariableSchema.safeParse({ ...row, value: 'secret' }).success).toBe(false);
    expect(EnvironmentVariableSchema.safeParse({ ...row, encryptedValue: 'blob' }).success).toBe(false);
  });
});
