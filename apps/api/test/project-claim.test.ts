import { describe, expect, it } from 'vitest';
import { parseClaimArgs } from '../src/claim-project-cli';

describe('legacy project claim CLI arguments', () => {
  it('defaults to a dry-run and requires every identifier', () => {
    expect(parseClaimArgs(['--', '--slug', 'demo', '--issuer', 'https://idp.example.test/realms/x', '--subject', 'abc']))
      .toEqual({ kind: 'claim', slug: 'demo', issuer: 'https://idp.example.test/realms/x', subject: 'abc', apply: false });
    expect(parseClaimArgs(['--slug', 'demo', '--issuer', 'https://idp.example.test', '--subject', 'abc', '--yes']).kind).toBe('claim');
    expect(parseClaimArgs(['--list'])).toEqual({ kind: 'list' });
  });

  it('keeps subjects verbatim with the --key=value form', () => {
    expect(parseClaimArgs(['--slug=demo', '--issuer=https://idp.example.test', '--subject=--odd sub ', '--yes']))
      .toEqual({ kind: 'claim', slug: 'demo', issuer: 'https://idp.example.test', subject: '--odd sub ', apply: true });
    expect(parseClaimArgs(['--slug', 'demo', '--issuer', 'https://i', '--subject=--']).kind).toBe('claim');
  });

  it('rejects incomplete, duplicated or unknown arguments', () => {
    expect(() => parseClaimArgs([])).toThrow();
    expect(() => parseClaimArgs(['--slug', 'demo', '--issuer', 'https://idp.example.test'])).toThrow();
    expect(() => parseClaimArgs(['--slug', '--issuer', 'https://idp.example.test', '--subject', 'abc'])).toThrow();
    expect(() => parseClaimArgs(['--slug', 'a', '--slug', 'b', '--issuer', 'https://i', '--subject', 's'])).toThrow();
    expect(() => parseClaimArgs(['--slug', 'demo', '--issuer', 'https://i', '--subject', 's', '--force'])).toThrow();
    expect(() => parseClaimArgs(['--list', '--yes'])).toThrow();
  });
});
