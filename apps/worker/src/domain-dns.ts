import { Resolver } from 'node:dns/promises';
import { isIP } from 'node:net';
import { DomainNameSchema } from '@forgekit/contracts';
export class DomainError extends Error {}
export interface DomainDnsVerifier { verify(hostname: string, host: string, token: string): Promise<boolean> }
export class NodeDomainDnsVerifier implements DomainDnsVerifier {
  constructor(private readonly createResolver = () => new Resolver({ timeout: 2000, tries: 2 })) {}
  async verify(hostname: string, host: string, token: string) {
    DomainNameSchema.parse(hostname);
    const resolver = this.createResolver();
    const empty = async <T>(request: Promise<T[]>): Promise<T[]> => {
      try { return await request; }
      catch (error) {
        if (['ENODATA', 'ENOTFOUND'].includes((error as NodeJS.ErrnoException).code ?? '')) return [];
        throw new DomainError('domain_dns_unavailable');
      }
    };
    try {
      const [v4, v6, host4, host6, txt] = await Promise.all([
        empty(resolver.resolve4(hostname)), empty(resolver.resolve6(hostname)),
        isIP(host) ? Promise.resolve([host]) : empty(resolver.resolve4(host)),
        isIP(host) ? Promise.resolve<string[]>([]) : empty(resolver.resolve6(host)),
        empty(resolver.resolveTxt('_forgekit-challenge.' + hostname)),
      ]);
      const addresses = [...v4, ...v6], expected = new Set([...host4, ...host6]);
      return addresses.length > 0 && addresses.length <= 64 && addresses.every(address => expected.has(address)) &&
        txt.length <= 64 && txt.some(parts => parts.join('') === 'forgekit-domain=' + token);
    } finally { resolver.cancel(); }
  }
}
