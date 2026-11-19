import { createServer, type ServerResponse } from 'node:http';
import { createHash } from 'node:crypto';
import { extname } from 'node:path';
import { safeRelativePath, type ArtifactStore } from '@forgekit/artifact-store';
import type { BuildRepository, PreviewLinkRepository } from '@forgekit/db';
import { previewHost } from './preview-config';
import { hashPreviewToken } from './preview-tokens';

type File = Awaited<ReturnType<ArtifactStore['open']>>;
export interface PreviewDependencies {
  base: URL;
  links: Pick<PreviewLinkRepository, 'findValidByHash' | 'recordAccess'>;
  builds: Pick<BuildRepository, 'get'>;
  artifacts: Pick<ArtifactStore, 'open'>;
  log: (event: { route: string; method: string; status: number }) => void;
}
export const PREVIEW_CSP = "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; worker-src 'none'";
export function previewHeaders(response: ServerResponse): void {
  response.setHeader('Content-Security-Policy', PREVIEW_CSP);
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('Referrer-Policy', 'no-referrer');
  response.setHeader('X-Frame-Options', 'DENY');
  response.setHeader('Cache-Control', 'private, no-store');
  response.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  response.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  response.setHeader('Origin-Agent-Cluster', '?1');
}
// Never serialize raw request URL/Host, query, headers or errors (including malformed credentials).
export function redactPreviewRequest(): string { return 'preview/[redacted]'; }
export function previewPath(rawUrl: string): string {
  const raw = rawUrl.split('?')[0]!;
  if (!raw.startsWith('/') || raw.startsWith('//') || /%2f|%5c/i.test(raw)) throw new Error('unsafe_preview_path');
  const decoded = decodeURIComponent(raw);
  const path = decoded.slice(1).replace(/\/$/, '');
  if (path) safeRelativePath(path);
  return path;
}
const mime: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.txt': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.webp': 'image/webp', '.avif': 'image/avif', '.ico': 'image/x-icon', '.woff': 'font/woff', '.woff2': 'font/woff2',
  '.wasm': 'application/wasm', '.xml': 'application/xml; charset=utf-8', '.webmanifest': 'application/manifest+json',
};
function missing(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return code === 'ENOENT' || code === 'ENOTDIR' || (error instanceof Error && error.message === 'unsafe_artifact_entry');
}
async function selectFile(store: Pick<ArtifactStore, 'open'>, key: string, path: string, nuxt: boolean): Promise<{ file: File; name: string; status: number } | null> {
  const candidates = path ? [path, `${path}/index.html`] : ['index.html'];
  if (path && !extname(path) && !nuxt) candidates.push('index.html');
  if (nuxt) candidates.push('404.html');
  for (const name of candidates) {
    try { return { file: await store.open(key, name), name, status: name === '404.html' && path !== '404.html' ? 404 : 200 }; }
    catch (error) { if (!missing(error)) throw error; }
  }
  return null;
}
/** Hash exactly the inline script bytes delivered; Nuxt hydration needs no unsafe-inline permission. */
export function htmlCsp(html: Buffer): string {
  const hashes = new Set<string>();
  const source = html.toString('utf8');
  const opening = /<script\b/gi;
  const closing = /<\/script\s*>/gi;
  // Each search moves forward over disjoint ranges. In particular, an unclosed
  // script ends the scan instead of retrying the remaining input at every <script>.
  while (opening.exec(source)) {
    const start = source.indexOf('>', opening.lastIndex);
    if (start === -1) break;
    closing.lastIndex = start + 1;
    const end = closing.exec(source);
    if (!end) break;
    const script = source.slice(start + 1, end.index);
    if (script) hashes.add(`'sha256-${createHash('sha256').update(script.replace(/\r\n?/g, '\n')).digest('base64')}'`);
    opening.lastIndex = closing.lastIndex;
  }
  return PREVIEW_CSP.replace("script-src 'self'", `script-src 'self'${hashes.size ? ' ' + [...hashes].join(' ') : ''}`);
}
export function createPreviewServer(deps: PreviewDependencies) {
  const server = createServer({ maxHeaderSize: 16384 }, async (request, response) => {
    previewHeaders(response);
    response.on('finish', () => deps.log({ route: redactPreviewRequest(), method: request.method === 'HEAD' ? 'HEAD' : request.method === 'GET' ? 'GET' : 'OTHER', status: response.statusCode }));
    const fail = (status = 404) => {
      response.statusCode = status;
      response.setHeader('Content-Type', 'text/html; charset=utf-8');
      response.end(request.method === 'HEAD' ? undefined : '<!doctype html><meta charset="utf-8"><title>Preview unavailable</title><p>Preview unavailable.</p>');
    };
    let body: AsyncIterable<Uint8Array> | undefined;
    let closeFile: (() => void) | undefined;
    try {
      if (request.method !== 'GET' && request.method !== 'HEAD') { response.setHeader('Allow', 'GET, HEAD'); fail(405); return; }
      const credential = previewHost(deps.base, request.headers.host);
      if (!credential) { fail(); return; }
      const path = previewPath(request.url ?? '');
      // Cookie/Authorization/forwarded headers play no role in bearer authorization and are never forwarded.
      const link = await deps.links.findValidByHash(hashPreviewToken(credential.token));
      if (!link || link.revokedAt || link.expiresAt.getTime() <= Date.now()) { fail(); return; }
      const build = await deps.builds.get(link.buildId);
      if (!build || build.status !== 'succeeded' || !build.artifactKey) { fail(); return; }
      const selected = await selectFile(deps.artifacts, build.artifactKey, path, build.template === 'nuxt-site');
      if (!selected) { fail(); return; }
      body = selected.file.body; closeFile = selected.file.close;
      if (path && selected.name === `${path}/index.html` && !(request.url ?? '').split('?')[0]!.endsWith('/')) {
        response.statusCode = 308;
        const rawUrl = request.url ?? '';
        const queryIndex = rawUrl.indexOf('?');
        const query = queryIndex === -1 ? '' : rawUrl.slice(queryIndex);
        response.setHeader('Location', '/' + path.split('/').map(encodeURIComponent).join('/') + '/' + query);
        response.end(); return;
      }
      const contentType = mime[extname(selected.name).toLowerCase()] ?? 'application/octet-stream';
      let html: Buffer | undefined;
      if (contentType.startsWith('text/html')) {
        // Limit per-request memory; published artifact budgets are not an HTML buffering budget.
        if (selected.file.size > 8 * 1024 * 1024) { fail(); return; }
        const chunks: Buffer[] = []; let size = 0;
        for await (const chunk of body) {
          size += chunk.length;
          if (size > 8 * 1024 * 1024) throw new Error('preview_html_limit');
          chunks.push(Buffer.from(chunk));
        }
        html = Buffer.concat(chunks);
        response.setHeader('Content-Security-Policy', htmlCsp(html));
      }
      // Atomic DB predicate throttles writes across gateway instances; access checks above never use a cache.
      await deps.links.recordAccess(link.id, 60_000);
      response.statusCode = selected.status;
      response.setHeader('Content-Type', contentType);
      response.setHeader('Content-Length', html?.length ?? selected.file.size);
      if (request.method === 'HEAD') { response.end(); return; }
      if (html) { response.end(html); return; }
      for await (const chunk of body) {
        if (response.destroyed) break;
        if (!response.write(chunk)) {
          await new Promise<void>(resolve => {
            const done = () => { response.off('drain', done); response.off('close', done); resolve(); };
            response.once('drain', done); response.once('close', done);
          });
        }
      }
      response.end();
    } catch (error) {
      // Do not log error objects: adapters and parsers may include credential-bearing input.
      if (response.headersSent) response.destroy();
      else fail(error instanceof URIError || (error instanceof Error && /unsafe_/.test(error.message)) ? 404 : 503);
    } finally {
      if (closeFile) closeFile();
      else if (body) {
        try { await body[Symbol.asyncIterator]().return?.(); } catch { response.destroy(); }
      }
    }
  });
  server.requestTimeout = 15_000;
  server.headersTimeout = 10_000;
  server.keepAliveTimeout = 5_000;
  return server;
}
