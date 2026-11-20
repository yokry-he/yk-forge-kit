import { describe, expect, it, vi } from 'vitest';
import { Resolver } from 'node:dns/promises';
import { NodeDomainDnsVerifier } from '../src/domain-dns';
function fixture() {
  const resolver = new Resolver();
  const resolve4 = vi.spyOn(resolver, 'resolve4').mockResolvedValue(['192.0.2.10']);
  const resolve6 = vi.spyOn(resolver, 'resolve6').mockResolvedValue([]);
  const txt = vi.spyOn(resolver, 'resolveTxt').mockResolvedValue([['forgekit-domain=', 'token']]);
  const cancel = vi.spyOn(resolver, 'cancel');
  return { dns: new NodeDomainDnsVerifier(() => resolver), resolve4, resolve6, txt, cancel };
}
describe('domain ownership and routing DNS', () => {
  it('requires both domain-specific TXT and all A/AAAA addresses to match the SSH host', async () => {
    const { dns, txt, resolve4, resolve6, cancel } = fixture();
    expect(await dns.verify('site.example', '192.0.2.10', 'token')).toBe(true);
    expect(txt).toHaveBeenCalledWith('_forgekit-challenge.site.example');
    txt.mockResolvedValueOnce([['forgekit-domain=another-tenant']]);
    expect(await dns.verify('site.example', '192.0.2.10', 'token')).toBe(false);
    resolve6.mockResolvedValueOnce(['2001:db8::1']);
    expect(await dns.verify('site.example', '192.0.2.10', 'token')).toBe(false);
    resolve4.mockResolvedValueOnce([]);
    expect(await dns.verify('site.example', '192.0.2.10', 'token')).toBe(false);
    expect(cancel).toHaveBeenCalledTimes(4);
  });
  it('resolves the host separately, rejects resolver failures and always cancels pending requests', async () => {
    const { dns, resolve4, cancel } = fixture();
    resolve4.mockImplementation(async name => name === 'host.example' ? ['192.0.2.10', '192.0.2.11'] : ['192.0.2.10']);
    expect(await dns.verify('site.example', 'host.example', 'token')).toBe(true);
    resolve4.mockRejectedValueOnce(Object.assign(new Error('sensitive DNS detail'), { code: 'ETIMEOUT' }));
    await expect(dns.verify('site.example', 'host.example', 'token')).rejects.toThrow('domain_dns_unavailable');
    expect(cancel).toHaveBeenCalledTimes(2);
  });
});
