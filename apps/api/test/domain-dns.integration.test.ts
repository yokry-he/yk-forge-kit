import { describe, expect, it } from 'vitest';
import { startDomainDnsFixture } from './domain-dns-fixture';

describe('B13 loopback DNS ownership integration', () => {
  it('requires matching A and domain-specific TXT records through a real DNS resolver', async () => {
    const dns = await startDomainDnsFixture();
    const name = 'site.b13.test', challenge = '_forgekit-challenge.' + name;
    try {
      expect(await dns.verifier.verify(name, '127.0.0.1', 'token')).toBe(false);
      dns.records.set(name, { address: '127.0.0.1' });
      dns.records.set(challenge, { txt: 'forgekit-domain=another-tenant' });
      expect(await dns.verifier.verify(name, '127.0.0.1', 'token')).toBe(false);
      dns.records.set(challenge, { txt: 'forgekit-domain=token' });
      expect(await dns.verifier.verify(name, '127.0.0.1', 'token')).toBe(true);
      dns.records.set(name, { address: '127.0.0.2' });
      expect(await dns.verifier.verify(name, '127.0.0.1', 'token')).toBe(false);
      dns.records.set('host.b13.test', { address: '127.0.0.2' });
      expect(await dns.verifier.verify(name, 'host.b13.test', 'token')).toBe(true);
    } finally { await dns.close(); }
  }, 5000);
});
