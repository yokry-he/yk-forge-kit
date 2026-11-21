import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { LocalFsArtifactStore } from '@forgekit/artifact-store';
import { WeappJobInputSchema } from '@forgekit/contracts';
import type { WeappJobRow } from '@forgekit/db';
import { DockerWeappRunner } from '../src/weapp-runner';
const command = promisify(execFile);
describe.skipIf(process.env.FORGEKIT_DOCKER_RUNNER_TEST !== '1')('B17 actual Docker with offline SDK fixture', () => {
  it('runs the trusted entry with isolated mounts, publishes QR, handles SDK failure and cleans up', async () => {
    const root = await mkdtemp(join(tmpdir(), 'b17-container-')), network = 'b17-test-' + randomUUID();
    await command('docker', ['network', 'create', '--internal', network]);
    try {
      const store = new LocalFsArtifactStore(join(root, 'store')), source = join(root, 'source'); await mkdir(source);
      for (const [path, content] of Object.entries({ 'app.js': '//fixture', 'app.json': '{"pages":["pages/index/index"]}', 'project.config.json': '{"plugins":{"untrusted":"must-be-removed"}}' })) await writeFile(join(source, path), content);
      const id = randomUUID(), now = new Date(), artifact = await store.put(id, source, new AbortController().signal);
      const job: WeappJobRow = { id, projectId: randomUUID(), buildId: id, appId: 'wx0000000000000000', input: WeappJobInputSchema.parse({ buildId: id, version: '1.0.0', action: 'upload_preview' }),
        status: 'running', triggeredBy: randomUUID(), createdAt: now, updatedAt: now, startedAt: now, finishedAt: null, errorCode: null, qrArtifactKey: null };
      const lines: string[] = [], runner = new DockerWeappRunner(store, { image: 'forgekit-weapp-test:b17', network, workspaceRoot: root });
      const sink = { write: async (_stream: string, content: string) => { lines.push(content); } };
      const key = await runner.run(job, artifact, Buffer.from('synthetic-b17-container-key'), sink, AbortSignal.timeout(30000));
      expect(key).toBeTruthy(); expect(lines.join('')).toContain('预览二维码已生成'); expect(lines.join('')).not.toContain('synthetic-b17-container-key');
      const qr = await store.open(key!, 'qrcode.jpg'); const chunks = []; for await (const chunk of qr.body) chunks.push(chunk); expect(Buffer.concat(chunks)).toEqual(Buffer.from([255, 216, 1, 255, 217]));
      await expect(runner.run({ ...job, id: randomUUID(), input: { ...job.input, description: 'fixture-fail' } }, artifact, Buffer.from('synthetic-b17-container-key'), sink, AbortSignal.timeout(30000))).rejects.toThrow('weapp_ci_failed');
      expect(lines.join('')).not.toContain('synthetic-b17-container-key');
      expect((await readdir(root)).filter(name => name.startsWith('forgekit-weapp-'))).toEqual([]);
      const containers = await command('docker', ['ps', '-aq', '--filter', `name=forgekit-weapp-${id}-`]); expect(containers.stdout.trim()).toBe('');
    } finally { await command('docker', ['network', 'rm', network]); await rm(root, { recursive: true, force: true }); }
  }, 90000);
});
