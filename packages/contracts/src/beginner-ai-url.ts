/** Browser-safe checks shared by the form contract and the server DNS guard. */
export function isPublicBeginnerAddress(address: string): boolean {
  try {
    // WHATWG canonicalization also handles shortened/octal/hex IPv4 and IPv6 literals.
    const host = new URL(address.includes(':') ? `http://[${address.replace(/^\[|\]$/g, '')}]/` : `http://${address}/`).hostname;
    if (host.startsWith('[')) {
      const groups = host.slice(1, -1).split(':');
      const first = Number.parseInt(groups[0] || '0', 16);
      // Only global unicast; excludes unspecified, loopback, mapped/compatible IPv4,
      // NAT64, link/site/unique-local and multicast (including metadata endpoints).
      if (first < 0x2000 || first > 0x3fff) return false;
      const second = Number.parseInt(groups[1] || '0', 16);
      // Special-use, documentation and 6to4 transition ranges are not destinations.
      return !(first === 0x2001 && (second < 0x200 || second === 0xdb8)) && first !== 0x2002 && first < 0x3fff;
    }
    if (!/^\d+\.\d+\.\d+\.\d+$/.test(host)) return false;
    if (host === '168.63.129.16') return false; // Azure platform virtual IP.
    const [a = 0, b = 0, c = 0] = host.split('.').map(Number);
    return !(a === 0 || a === 10 || a === 127 || a >= 224 ||
      a === 100 && b >= 64 && b <= 127 || a === 169 && b === 254 ||
      a === 172 && b >= 16 && b <= 31 || a === 192 && (b === 168 || b === 0 || b === 2 || b === 88 && c === 99) ||
      a === 198 && (b === 18 || b === 19 || b === 51 && c === 100) || a === 203 && b === 0 && c === 113);
  } catch { return false; }
}

export function isSafeBeginnerBaseUrl(value: string): boolean {
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || value.includes('?') || value.includes('#') || url.port) return false;
    const hostname = url.hostname.replace(/\.$/, '').toLowerCase();
    if (hostname === 'localhost' || hostname.endsWith('.localhost') || !hostname) return false;
    return hostname.startsWith('[') || /^[\d.]+$/.test(hostname) ? isPublicBeginnerAddress(hostname) : true;
  } catch { return false; }
}
