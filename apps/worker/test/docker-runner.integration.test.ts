import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { LocalFsArtifactStore } from '../src/artifact-store';
import { DockerBuildRunner } from '../src/docker-runner';
import { TemplateWorkspaceSource, type WorkspaceSource } from '../src/workspace-source';
import { buildRecord, dockerOptions } from './fixtures';

const enabled = process.env.FORGEKIT_DOCKER_RUNNER_TEST === '1';
describe.skipIf(!enabled)('real Docker isolated template builds', () => {
  it.each(['vue-web', 'nuxt-site'])('builds %s, validates network isolation and reads index.html', async (template) => {
    vi.stubEnv('FORGEKIT_DEPLOY_ENCRYPTION_KEY', randomBytes(32).toString('hex'));
    const root = await mkdtemp(join(tmpdir(), 'forgekit-docker-integration-'));
    const store = new LocalFsArtifactStore(join(root, 'artifacts'));
    const lines: string[] = [];
    const templateSource = new TemplateWorkspaceSource(async () => ({ name: 'docker-smoke', template, features: [] }));
    const source: WorkspaceSource = { prepare: async (build, workspace, signal) => {
      const plan = await templateSource.prepare(build, workspace, signal);
      // Runs INSIDE the actual build container before the template's own build/generate script.
      await writeFile(join(workspace, 'isolation-check.cjs'), `
const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
assert.notEqual(process.getuid(), 0);
assert.equal(process.env.DATABASE_URL, undefined);
assert.equal(process.env.REDIS_URL, undefined);
assert.equal(process.env.FORGEKIT_DEPLOY_ENCRYPTION_KEY, undefined);
assert.equal(process.env.B14_TEST_PLAIN, 'b14-visible-value');
assert.equal(process.env.B14_TEST_SECRET, 'b14-build-fixture-secret');
console.log(process.env.B14_TEST_SECRET);
console.error(process.env.B14_TEST_SECRET);
assert.equal(fs.existsSync('/var/run/docker.sock'), false);
assert.throws(() => fs.writeFileSync('/rootfs-write-probe', 'denied'));
assert.match(fs.readFileSync('/proc/self/status', 'utf8'), /CapEff:\\s+0+\\n/);
assert.match(fs.readFileSync('/proc/self/status', 'utf8'), /NoNewPrivs:\\s+1\\n/);
assert.match(fs.readFileSync('/proc/self/status', 'utf8'), /Seccomp:\\s+2\\n/);
assert.equal(Object.keys(require('node:os').networkInterfaces()).filter(name => name !== 'lo').length, 0);
const socket = net.connect({ host: '1.1.1.1', port: 443 });
socket.setTimeout(2000);
socket.on('connect', () => { socket.destroy(); console.error('network unexpectedly reachable'); process.exitCode = 1; });
socket.on('timeout', () => { socket.destroy(); console.error('network isolation check timed out'); process.exitCode = 1; });
socket.on('error', () => console.log('forgekit-network-blocked'));
`);
      const path = join(workspace, 'package.json');
      const manifest = JSON.parse(await readFile(path, 'utf8')) as { scripts: Record<string, string> };
      manifest.scripts[plan.script] = `node isolation-check.cjs && ${manifest.scripts[plan.script]}`;
      await writeFile(path, JSON.stringify(manifest));
      return plan;
    } };
    try {
      const runner = new DockerBuildRunner(source, store, { ...dockerOptions,
        image: process.env.FORGEKIT_BUILD_IMAGE ?? 'node:22', workspaceRoot: root,
        memoryMb: 4096, timeoutMs: 600000, maxLogBytes: 4 * 1048576 }, undefined, undefined, async () => ({
          values: { B14_TEST_PLAIN: 'b14-visible-value', B14_TEST_SECRET: 'b14-build-fixture-secret' }, secrets: ['b14-build-fixture-secret'],
        }));
      const result = await runner.run(buildRecord(template), { write: async (_stream, line) => { lines.push(line); } }, new AbortController().signal);
      expect(result.exitCode, lines.join('')).toBe(0);
      expect(lines.join('')).toContain('forgekit-network-blocked');
      expect(lines.join('')).not.toContain('b14-build-fixture-secret');
      expect(lines.join('')).toContain('[REDACTED]');
      expect(result.artifact?.sha256).toMatch(/^[a-f0-9]{64}$/);
      const file = await store.open(result.artifact!.key, 'index.html');
      let html = ''; for await (const chunk of file.body) html += Buffer.from(chunk).toString('utf8');
      expect(html.toLowerCase()).toContain('<html'); expect(file.size).toBeGreaterThan(0);
      expect((await readdir(root)).filter((name) => name.startsWith('forgekit-build-'))).toEqual([]);
    } finally { vi.unstubAllEnvs(); await rm(root, { recursive: true, force: true }); }
  }, 660000);
});
