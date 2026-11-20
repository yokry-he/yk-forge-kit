import { describe, expect, it } from 'vitest';
import { DomainNameSchema, DomainCreateSchema } from '../src/domains';
describe('B13 domain inputs', () => {
  it('normalizes ASCII DNS names and allows explicit IDNA labels', () => {
    expect(DomainNameSchema.parse('WWW.Example.COM')).toBe('www.example.com');
    expect(DomainNameSchema.parse('xn--fiqs8s.example')).toBe('xn--fiqs8s.example');
  });
  it.each(['example.com\r\nX:bad', 'example.com\n{}', 'example.com/../../etc', 'https://example.com', '*.example.com', 'example.com:443',
    '-bad.example.com', 'bad-.example.com', 'a..example.com', 'example.com.', '127.0.0.1', 'localhost', 'a.localhost', 'a.local', 'metadata.google.internal',
    'foo.ts.net', '中文.example', 'a'.repeat(64) + '.com', 'a.com;sh', 'a.com`id`', '{env.HOME}.example'])('rejects %j', value => {
    expect(DomainNameSchema.safeParse(value).success).toBe(false);
  });
  it('does not accept issuer, command or target connection overrides', () => {
    expect(DomainCreateSchema.safeParse({ hostname: 'site.example', deployTargetId: '11111111-1111-4111-8111-111111111111', command: 'id' }).success).toBe(false);
  });
});
