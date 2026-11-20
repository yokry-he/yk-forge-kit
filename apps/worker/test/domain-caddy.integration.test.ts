import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile, access } from 'node:fs/promises';
import { createServer } from 'node:net';
import { request as httpsRequest } from 'node:https';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { describe, expect, it } from 'vitest';
import { boundedCommand } from '../src/ssh-command';
import { domainCommand } from '../src/domain-ssh';
async function port() {
  const server = createServer(); await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('port_missing');
  await new Promise<void>(resolve => server.close(() => resolve())); return address.port;
}
describe.skipIf(process.env.FORGEKIT_CADDY_INTEGRATION !== '1')('B13 real Caddy internal CA and atomic reload (no Docker)', () => {
  it('issues before serving, reapplies idempotently, restores on reload failure and removes one route without affecting others', async () => {
    const work = await mkdtemp(join(tmpdir(), 'b13-'));
    const root = join(work, '.forgekit-caddy'), site = join(work, 'current');
    await mkdir(root, { mode: 0o700 }); await mkdir(site);
    await writeFile(join(site, 'index.html'), 'B13 healthy static site'); await writeFile(join(site, '.forgekit-complete'), '');
    const settings = { httpPort: await port(), httpsPort: await port() };
    const config = { admin: { listen: 'unix/' + join(root, 'admin.sock') }, storage: { module: 'file_system', root: join(root, 'data') } };
    await writeFile(join(root, 'caddy.json'), JSON.stringify(config)); await writeFile(join(root, 'state.json'), '{}');
    await writeFile(join(root, 'settings.json'), JSON.stringify(settings));
    const child = spawn('caddy', ['run', '--config', join(root, 'caddy.json')], { stdio: 'ignore', env: { ...process.env, XDG_CONFIG_HOME: work } });
    const exited = new Promise<void>(resolve => child.once('close', () => resolve()));
    let spawnError: Error | undefined;
    child.once('error', error => { spawnError = error; });
    const blocker = createServer();
    const input = { basePath: work, siteRoot: site, id: randomUUID(), hostname: 'one.b13.test', tlsMode: 'internal', action: 'verify' };
    const execute = (value = input) => boundedCommand('sh', ['-c', domainCommand(value)], AbortSignal.timeout(20000));
    try {
      let ready = false;
      for (let i = 0; i < 80; ++i) {
        if (spawnError) throw spawnError;
        if (child.exitCode !== null) throw new Error('caddy_exited_before_ready');
        try { await access(join(root, 'admin.sock')); ready = true; break; } catch { await delay(50); }
      }
      if (!ready) throw new Error('caddy_startup_timeout');
      const issued = await execute(); expect(issued).toContain('B13_RESULT:');
      const cert = JSON.parse(issued.trim().slice('B13_RESULT:'.length)) as { expiresAt: string; fingerprint: string };
      expect(new Date(cert.expiresAt).getTime()).toBeGreaterThan(Date.now()); expect(cert.fingerprint).toMatch(/^[a-f0-9]{64}$/);
      // Verify the issued chain and hostname with the fixture CA, independently of the remote probe.
      const ca = await readFile(join(root, 'data/pki/authorities/local/root.crt'));
      // Match the Docker E2E's public CA export: this process must create the
      // local 0600 file, even when a privileged CLI reads the source certificate.
      const caFile = join(work, 'client-root.crt');
      await writeFile(caFile, ca, { mode: 0o600 });
      const curl = spawnSync('curl', ['--disable', '--fail', '--silent', '--show-error', '--verbose', '--noproxy', '*',
        '--connect-timeout', '2', '--max-time', '5', '--cacert', caFile,
        '--resolve', `${input.hostname}:${settings.httpsPort}:127.0.0.1`, `https://${input.hostname}:${settings.httpsPort}/`],
      { encoding: 'utf8', timeout: 10000, maxBuffer: 65536 });
      expect(curl.error, curl.stderr).toBeUndefined();
      expect(curl.status, curl.stderr).toBe(0);
      expect(curl.stdout).toBe('B13 healthy static site');
      const fetchSite = (hostname: string) => new Promise<{ status: number; body: string }>((resolve, reject) => {
        const request = httpsRequest({ hostname: '127.0.0.1', port: settings.httpsPort, servername: hostname, ca,
          headers: { host: hostname }, agent: false }, response => {
          let body = ''; response.setEncoding('utf8');
          response.on('data', (chunk: string) => { body += chunk; });
          response.on('end', () => resolve({ status: response.statusCode ?? 0, body }));
        });
        request.setTimeout(2000, () => request.destroy(new Error('https_probe_timeout')));
        request.on('error', reject); request.end();
      });
      expect(await fetchSite(input.hostname)).toEqual({ status: 200, body: 'B13 healthy static site' });
      expect(await execute()).toBe(issued);
      expect(await execute({ ...input, action: 'refresh' })).toBe(issued);
      const second = { ...input, id: randomUUID(), hostname: 'two.b13.test' };
      expect(await execute(second)).toContain('B13_RESULT:');
      const before = await readFile(join(root, 'caddy.json'), 'utf8');
      const stateBefore = await readFile(join(root, 'state.json'), 'utf8');
      const missing = await execute({ ...input, id: randomUUID(), hostname: 'missing.b13.test', siteRoot: join(work, 'missing') });
      expect(missing).toContain('B13_ERROR:domain_release_missing');
      expect(await readFile(join(root, 'caddy.json'), 'utf8')).toBe(before);
      // A syntactically valid config that cannot bind must fail reload and keep the old server serving.
      await new Promise<void>(resolve => blocker.listen(0, '0.0.0.0', resolve));
      const address = blocker.address(); if (!address || typeof address === 'string') throw new Error('port_missing');
      await writeFile(join(root, 'settings.json'), JSON.stringify({ ...settings, httpsPort: address.port }));
      const rejected = await execute({ ...input, id: randomUUID(), hostname: 'bad.b13.test' });
      expect(rejected).toContain('B13_ERROR:domain_reload_failed');
      expect(await readFile(join(root, 'caddy.json'), 'utf8')).toBe(before);
      expect(await readFile(join(root, 'state.json'), 'utf8')).toBe(stateBefore);
      await writeFile(join(root, 'settings.json'), JSON.stringify(settings));
      expect(await execute({ ...input, action: 'refresh' })).toBe(issued);
      // Recover an interrupted apply's config + state before inspecting another certificate.
      await writeFile(join(root, 'previous.json'), JSON.stringify({ config: JSON.parse(before), state: JSON.parse(stateBefore) }));
      await writeFile(join(root, 'state.json'), '{}');
      expect(await execute({ ...input, action: 'refresh' })).toBe(issued);
      expect(await execute({ ...input, action: 'remove' })).toContain('B13_RESULT:{}');
      expect(await execute({ ...input, action: 'remove' })).toContain('B13_RESULT:{}');
      expect(await execute({ ...second, action: 'refresh' })).toContain('B13_RESULT:');
      // Removed subjects may reject the TLS handshake after Caddy drops their automation policy.
      const removed = await fetchSite(input.hostname).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'EPROTO') throw error;
        return { status: 0, body: '' };
      });
      expect([0, 404]).toContain(removed.status);
      expect(await fetchSite(second.hostname)).toEqual({ status: 200, body: 'B13 healthy static site' });
      expect(await execute({ ...input, action: 'refresh' })).toContain('B13_ERROR:domain_not_configured');
    } finally {
      blocker.close(); child.kill('SIGTERM');
      const timer = setTimeout(() => child.kill('SIGKILL'), 1000);
      await exited; clearTimeout(timer); await rm(work, { recursive: true, force: true });
    }
  }, 60000);
});
