/** Both API and gateway use this exact origin mapping; no forwarded headers are trusted. */
export function previewBase(env: Record<string, string | undefined>): URL {
  let base: URL;
  try { base = new URL(env.FORGEKIT_PREVIEW_BASE_URL ?? ''); }
  catch { throw new Error('FORGEKIT_PREVIEW_BASE_URL 必须配置为独立预览 origin。'); }
  const local = base.hostname === 'localhost' || base.hostname.endsWith('.localhost');
  if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password || base.pathname !== '/' || base.search || base.hash ||
      (!local && base.protocol !== 'https:') || !base.hostname.split('.').every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label)) || /^\d+(\.\d+){3}$/.test(base.hostname)) {
    throw new Error('预览地址需要 HTTPS 域名；本地开发可使用 HTTP *.localhost。');
  }
  for (const main of [env.CONSOLE_ORIGIN ?? 'http://localhost:5173', env.FORGEKIT_API_BASE_URL ?? 'http://localhost:3001']) {
    const app = new URL(main);
    if (app.hostname === base.hostname || app.hostname.endsWith(`.${base.hostname}`) || base.hostname.endsWith(`.${app.hostname}`)) {
      // localhost ports are development-only; the preview still uses child hosts, never main cookies.
      if (!(local && env.NODE_ENV !== 'production' && app.hostname === 'localhost')) throw new Error('预览域名不能与控制面共享 host 或父子域。');
    }
  }
  if (env.NODE_ENV === 'production' && (local || !env.CONSOLE_ORIGIN || !env.FORGEKIT_API_BASE_URL)) {
    throw new Error('生产预览须显式配置控制台/API origin 与独立 HTTPS 预览域名。');
  }
  // One lowercase base32 label carries all 256 credential bits and supports wildcard TLS.
  if (base.hostname.length + 53 > 253) throw new Error('预览域名过长。');
  return base;
}

const alphabet = 'abcdefghijklmnopqrstuvwxyz234567';
/** RFC 4648 unpadded base32 for DNS: lowercase, no underscores, one 52-character label. */
export function tokenLabel(token: string): string {
  let bits = 0, value = 0, output = '';
  for (const byte of Buffer.from(token, 'base64url')) {
    value = (value << 8) | byte; bits += 8;
    while (bits >= 5) { bits -= 5; output += alphabet[(value >>> bits) & 31]; }
    value &= (1 << bits) - 1;
  }
  if (bits) output += alphabet[(value << (5 - bits)) & 31];
  return output;
}
export function previewUrl(base: URL, token: string): string {
  const url = new URL(base);
  url.hostname = `${tokenLabel(token)}.${base.hostname}`;
  return url.href;
}
export function previewHost(base: URL, host: string | undefined): { token: string } | null {
  if (!host || host.length > 260 || host !== host.toLowerCase()) return null;
  const suffix = `.${base.host}`;
  if (!host.endsWith(suffix)) return null;
  const label = host.slice(0, -suffix.length);
  if (!/^[a-z2-7]{52}$/.test(label)) return null;
  let bits = 0, value = 0;
  const bytes: number[] = [];
  for (const char of label) {
    value = (value << 5) | alphabet.indexOf(char); bits += 5;
    if (bits >= 8) { bits -= 8; bytes.push((value >>> bits) & 255); }
    value &= (1 << bits) - 1;
  }
  const token = Buffer.from(bytes).toString('base64url');
  if (tokenLabel(token) !== label) return null; // Reject noncanonical padding bits.
  return { token };
}
