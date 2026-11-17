import { describe, expect, it } from 'vitest';
import { parseDisplayName } from '../src/identity-accounts.service';

describe('account display name input', () => {
  it('normalizes whitespace and Unicode without changing identity fields', () => {
    expect(parseDisplayName({ displayName: '  Yokry  ' })).toBe('Yokry');
    expect(parseDisplayName({ displayName: 'e\u0301' })).toBe('é');
    expect(parseDisplayName({ displayName: '小明 😀' })).toBe('小明 😀');
  });

  it('rejects empty, long, dangerous or mass-assignment payloads', () => {
    for (const body of [null, [], {}, { displayName: 123 }, { displayName: '' },
      { displayName: ' '.repeat(10) }, { displayName: 'a'.repeat(61) },
      { displayName: 'hello\nworld' }, { displayName: '\u202eAlice' },
      { displayName: 'Alice', id: 'other-account' }, { displayName: 'Alice', role: 'owner' }]) {
      expect(() => parseDisplayName(body)).toThrow();
    }
  });
});
