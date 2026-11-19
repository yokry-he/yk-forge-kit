import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { request } from 'node:http';
import { mkdtemp, mkdir, rm, writeFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LocalFsArtifactStore } from '@forgekit/artifact-store';
import { generatePreviewToken, hashPreviewToken } from '../src/preview-tokens';
import { previewBase, previewHost, previewUrl, tokenLabel } from '../src/preview-config';
import { createPreviewServer, htmlCsp, PREVIEW_CSP, previewPath, type PreviewDependencies } from '../src/preview-server';

const base = new URL('http://preview.localhost:3002');
const close: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of close.splice(0).reverse()) await cleanup(); });
export function get(port: number, host: string, path = '/', method = 'GET', headers: Record<string, string> = {}) {
  return new Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: string }>((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, method, headers: { host, ...headers } }, res => {
      const chunks: Buffer[] = []; res.on('data', chunk => chunks.push(Buffer.from(chunk)));
      res.on('end', () => resolve({ status: res.statusCode!, headers: res.headers, body: Buffer.concat(chunks).toString() }));
    }); req.on('error', reject); req.end();
  });
}
async function fixture(template = 'vue-web') {
  const root = await mkdtemp(join(tmpdir(), 'forgekit-preview-unit-'));
  close.push(() => rm(root, { recursive: true, force: true }));
  const source = join(root, 'source'); await mkdir(join(source, 'assets'), { recursive: true }); await mkdir(join(source, 'about'));
  await writeFile(join(source, 'index.html'), '<!doctype html><script type="module" src="/assets/main.js"></script><p>Hello</p>');
  await writeFile(join(source, 'assets/main.js'), 'console.log("asset")');
  await writeFile(join(source, 'about/index.html'), '<p>about</p>');
  await writeFile(join(source, '404.html'), '<p>Nuxt missing</p>');
  const artifacts = new LocalFsArtifactStore(join(root, 'store'));
  const buildId = randomUUID(); const artifact = await artifacts.put(buildId, source, new AbortController().signal);
  const { token, tokenHash } = generatePreviewToken();
  const link = { id: randomUUID(), buildId, createdBy: randomUUID(), createdAt: new Date(), expiresAt: new Date(Date.now() + 300_000), revokedAt: null as Date | null, lastAccessedAt: null };
  const find = vi.fn(async (hash: string) => hash === tokenHash ? link : null);
  const access = vi.fn(async () => true), log = vi.fn();
  const build = { id: buildId, status: 'succeeded', artifactKey: artifact.key, template };
  const deps = { base, links: { findValidByHash: find, recordAccess: access }, builds: { get: vi.fn(async () => build) }, artifacts, log } as unknown as PreviewDependencies;
  const server = createPreviewServer(deps); await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  close.push(() => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())));
  const port = (server.address() as { port: number }).port;
  const host = new URL(previewUrl(base, token)).host;
  return { root, artifacts, artifact, port, host, token, tokenHash, link, build, deps, access, find, log };
}
describe('preview credentials and origin routing', () => {
  it('generates unique 256-bit unpadded tokens and SHA256 hashes', () => {
    const tokens = Array.from({ length: 100 }, () => generatePreviewToken());
    expect(new Set(tokens.map(v => v.token)).size).toBe(100);
    for (const value of tokens) {
      expect(value.token).toMatch(/^[\w-]{43}$/); expect(Buffer.from(value.token, 'base64url')).toHaveLength(32);
      expect(value.tokenHash).toBe(createHash('sha256').update(value.token).digest('hex'));
    }
  });
  it('round trips all bits through a single DNS label, suitable for wildcard TLS', () => {
    expect(tokenLabel(Buffer.alloc(32).toString('base64url'))).toBe('a'.repeat(52));
    expect(tokenLabel(Buffer.alloc(32, 255).toString('base64url'))).toBe('7'.repeat(51) + 'q');
    expect(tokenLabel(Buffer.from('foobar').toString('base64url'))).toBe('mzxw6ytboi');
    for (let i = 0; i < 100; ++i) {
      const token = randomBytes(32).toString('base64url');
      const url = new URL(previewUrl(base, token));
      expect(tokenLabel(token)).toMatch(/^[a-z2-7]{52}$/);
      expect(previewHost(base, url.host)).toEqual({ token });
      expect(url.pathname).toBe('/');
    }
    for (const host of ['evil.example', 'a.preview.localhost:3002.evil', 'A'.repeat(52) + '.preview.localhost:3002',
      'a'.repeat(51) + 'b.preview.localhost:3002', 'a'.repeat(52) + '.preview.localhost:9999']) expect(previewHost(base, host)).toBeNull();
  });
  it('requires independent HTTPS origins in production and allows local wildcard hosts', () => {
    expect(previewBase({ FORGEKIT_PREVIEW_BASE_URL: base.href }).href).toBe(base.href);
    const env = { NODE_ENV: 'production', CONSOLE_ORIGIN: 'https://console.example.com', FORGEKIT_API_BASE_URL: 'https://api.example.com' };
    expect(previewBase({ ...env, FORGEKIT_PREVIEW_BASE_URL: 'https://preview.example.net' }).host).toBe('preview.example.net');
    for (const url of ['http://preview.example.net', 'https://console.example.com', 'https://sub.console.example.com', 'https://example.com',
      'https://preview.example.net/path', 'https://u:p@preview.example.net', 'http://127.0.0.1:3002', base.href]) {
      expect(() => previewBase({ ...env, FORGEKIT_PREVIEW_BASE_URL: url })).toThrow();
    }
    expect(() => previewBase({ NODE_ENV: 'production', FORGEKIT_PREVIEW_BASE_URL: 'https://preview.example.net' })).toThrow();
  });
});
describe('inline script CSP', () => {
  it.each(['<script>', '<script '])('handles 512 KiB of repeated unclosed %s tags in under 750 ms', tag => {
    const script = 'window.__NUXT__={ready:true}';
    const html = Buffer.from(`<script>${script}</script>` + tag.repeat(Math.ceil(512 * 1024 / tag.length)));
    expect(html.length).toBeLessThan(8 * 1024 * 1024);
    const start = performance.now();
    const csp = htmlCsp(html);
    const elapsed = performance.now() - start;
    expect(elapsed).toBeLessThan(750);
    const hash = createHash('sha256').update(script).digest('base64');
    expect(csp).toBe(PREVIEW_CSP.replace("script-src 'self'", `script-src 'self' 'sha256-${hash}'`));
  });

  it('hashes complete raw script bodies once, normalizes newlines and ignores an unclosed final script', () => {
    const body = 'first\r\n<script>nested\rlast';
    const hash = createHash('sha256').update('first\n<script>nested\nlast').digest('base64');
    const html = Buffer.from(`<ScRiPt type="module">${body}</SCRIPT \n><script>${body}</script><script></script><script>unfinished`);
    expect(htmlCsp(html)).toBe(PREVIEW_CSP.replace("script-src 'self'", `script-src 'self' 'sha256-${hash}'`));
    expect(htmlCsp(Buffer.from('<script>'.repeat(100)))).toBe(PREVIEW_CSP);
  });
});
describe('static preview gateway', () => {
  it('serves index, relative/root assets, MIME, HEAD and security headers without accepting cookies', async () => {
    const f = await fixture();
    const response = await get(f.port, f.host, '/', 'GET', { cookie: 'main=ignored', authorization: 'Bearer ignored' });
    expect(response.status).toBe(200); expect(response.body).toContain('/assets/main.js');
    expect(response.headers).toMatchObject({ 'content-type': 'text/html; charset=utf-8', 'cache-control': 'private, no-store',
      'referrer-policy': 'no-referrer', 'x-content-type-options': 'nosniff', 'x-frame-options': 'DENY', 'cross-origin-resource-policy': 'same-origin' });
    const csp = response.headers['content-security-policy'] as string;
    for (const directive of ["default-src 'none'", "script-src 'self'", "base-uri 'none'", "frame-ancestors 'none'", "worker-src 'none'"]) expect(csp).toContain(directive);
    expect(response.headers).not.toHaveProperty('set-cookie'); expect(response.headers).not.toHaveProperty('access-control-allow-origin');
    const asset = await get(f.port, f.host, '/assets/main.js'); expect(asset.status).toBe(200); expect(asset.headers['content-type']).toBe('text/javascript; charset=utf-8');
    expect(asset.body).toBe('console.log("asset")');
    const head = await get(f.port, f.host, '/assets/main.js', 'HEAD'); expect(head.status).toBe(200); expect(head.body).toBe('');
    expect(f.access).toHaveBeenCalledWith(f.link.id, 60_000);
  });
  it('returns one generic page for expired, revoked, unknown and unavailable builds', async () => {
    const f = await fixture();
    const unknown = await get(f.port, new URL(previewUrl(base, generatePreviewToken().token)).host);
    expect(unknown.status).toBe(404);
    f.link.expiresAt = new Date(Date.now() - 1);
    expect((await get(f.port, f.host)).body).toBe(unknown.body);
    f.link.expiresAt = new Date(Date.now() + 300_000); f.link.revokedAt = new Date();
    expect((await get(f.port, f.host)).status).toBe(404);
    f.link.revokedAt = null; f.build.status = 'failed';
    expect((await get(f.port, f.host)).status).toBe(404);
    expect(f.access).not.toHaveBeenCalled();
  });
  it('rejects traversal, double encoding, encoded separators, NUL and malformed escapes before storage access', async () => {
    const f = await fixture();
    for (const path of ['/../index.html', '/%2e%2e/index.html', '/%252e%252e/index.html', '/%2fetc/passwd',
      '/assets%5cmain.js', '/%00', '/%', '//index.html', '/a//b', '/a/./index.html']) {
      expect(() => previewPath(path)).toThrow(); expect((await get(f.port, f.host, path)).status).toBe(404);
    }
    expect(f.find).not.toHaveBeenCalled();
    await symlink(join(f.root, 'source/index.html'), join(f.root, 'store', f.artifact.key, 'escape.html'));
    expect((await get(f.port, f.host, '/escape.html')).status).toBe(404);
  });
  it('does SPA fallback only for Vue routes, never missing assets; serves Nuxt directories and 404.html', async () => {
    const vue = await fixture();
    expect((await get(vue.port, vue.host, '/nested/route')).body).toContain('Hello');
    expect((await get(vue.port, vue.host, '/assets/missing.js')).status).toBe(404);
    const nuxt = await fixture('nuxt-site');
    const directory = await get(nuxt.port, nuxt.host, '/about');
    expect(directory.status).toBe(308); expect(directory.headers.location).toBe('/about/');
    const queryDirectory = await get(nuxt.port, nuxt.host, '/about?tag=a%2Fb&tag=c&empty=');
    expect(queryDirectory.status).toBe(308); expect(queryDirectory.headers.location).toBe('/about/?tag=a%2Fb&tag=c&empty=');
    expect((await get(nuxt.port, nuxt.host, '/about/')).body).toBe('<p>about</p>');
    const missing = await get(nuxt.port, nuxt.host, '/missing'); expect(missing.status).toBe(404); expect(missing.body).toContain('Nuxt missing');
  });
  it('hashes Nuxt inline hydration scripts without granting unsafe-inline script execution', async () => {
    const f = await fixture('nuxt-site');
    const script = 'window.__NUXT__={config:{app:{baseURL:"/"}}}';
    await writeFile(join(f.root, 'store', f.artifact.key, 'index.html'), `<script>${script}</script>`);
    const response = await get(f.port, f.host);
    expect(response.headers['content-security-policy']).toContain(`'sha256-${createHash('sha256').update(script).digest('base64')}'`);
    expect(response.headers['content-security-policy']).not.toMatch(/script-src[^;]*unsafe-inline/);
    expect(response.body).toBe(`<script>${script}</script>`);
  });
  it('redacts credential-bearing host, paths, query, authorization and adapter errors from logs', async () => {
    const f = await fixture();
    await get(f.port, f.host, `/?token=${f.token}`, 'GET', { authorization: `Bearer ${f.token}`, cookie: f.token });
    await get(f.port, f.host, `/${f.token}`);
    await get(f.port, `bad-${f.token}.preview.localhost:3002`);
    vi.mocked(f.deps.builds.get).mockRejectedValueOnce(new Error(`failure: ${f.token}`));
    expect((await get(f.port, f.host)).status).toBe(503);
    const logs = JSON.stringify(f.log.mock.calls);
    for (const sensitive of [f.token, f.tokenHash, tokenLabel(f.token), f.host, 'Bearer', 'cookie']) expect(logs).not.toContain(sensitive);
    expect(logs).toContain('preview/[redacted]');
  });
  it('ignores forwarded host and fails closed when artifact disappears, rejects write methods', async () => {
    const f = await fixture();
    expect((await get(f.port, 'wrong.example', '/', 'GET', { 'x-forwarded-host': f.host })).status).toBe(404);
    await f.artifacts.remove(f.artifact.key);
    expect((await get(f.port, f.host)).status).toBe(404);
    expect((await get(f.port, f.host, '/', 'POST')).status).toBe(405);
    expect(f.access).not.toHaveBeenCalled();
  });
});
