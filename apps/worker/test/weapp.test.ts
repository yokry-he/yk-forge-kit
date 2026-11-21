import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LocalFsArtifactStore } from '@forgekit/artifact-store';
import { encryptWeappKey, type WeappJobRow } from '@forgekit/db';
import { WeappJobInputSchema } from '@forgekit/contracts';
import { WeappProcessor } from '../src/weapp-processor';
import { DockerWeappRunner, materializeWeapp, weappDockerArgs } from '../src/weapp-runner';
import { TemplateWorkspaceSource } from '../src/workspace-source';
import { buildDockerArgs } from '../src/docker-runner';
import { runWeappCi } from '../src/weapp-ci';
import { resolveWeappConfig } from '../src/weapp-worker';
const ci = vi.hoisted(() => ({ Project: vi.fn(function () {}), upload: vi.fn(), preview: vi.fn() }));
vi.mock('miniprogram-ci', () => ci);
const pid = randomUUID(), bid = randomUUID(), jid = randomUUID(), key = randomBytes(32), secret = '-----BEGIN TEST KEY-----\nsynthetic-upload-secret\n-----END TEST KEY-----';
const input = WeappJobInputSchema.parse({ buildId: bid, version: '1.0.0', action: 'upload_preview' });
const job: WeappJobRow = { id: jid, projectId: pid, buildId: bid, appId: 'wx0000000000000000', input,
  status: 'queued', triggeredBy: randomUUID(), createdAt: new Date(), updatedAt: new Date(), startedAt: null, finishedAt: null, errorCode: null, qrArtifactKey: null };
const build = { id: bid, projectId: pid, template: 'uniapp', target: 'mp-weixin', status: 'succeeded', artifactKey: 'artifact', artifactSha256: 'digest' };
afterEach(() => { vi.restoreAllMocks(); vi.clearAllMocks(); });
function setup(overrides = {}) {
  const jobs = { get: vi.fn().mockResolvedValue(job), config: vi.fn().mockResolvedValue({ appId: job.appId, encryptedPrivateKey: encryptWeappKey(secret, key, pid) }), transition: vi.fn() };
  const builds = { get: vi.fn().mockResolvedValue({ ...build, ...overrides }) };
  const logs = { append: vi.fn() }, runner = { run: vi.fn().mockResolvedValue('qr-key') }, remove = vi.fn();
  const processor = new WeappProcessor(jobs, builds, logs, runner, key, remove);
  return { jobs, builds, logs, runner, processor, remove };
}
describe('B17 isolated WeChat processing', () => {
  it('uses the mocked official SDK with dev upload and preview, fixed progress and robot', async () => {
    ci.upload.mockResolvedValue({}); ci.preview.mockResolvedValue({});
    await runWeappCi({ ...input, appId: job.appId }, secret, '/output');
    expect(ci.Project).toHaveBeenCalledWith(expect.objectContaining({ appid: job.appId, privateKey: secret, projectPath: '/tmp/project' }));
    expect(ci.Project.mock.calls[0]![0]).not.toHaveProperty('privateKeyPath');
    expect(ci.upload).toHaveBeenCalledWith(expect.objectContaining({ version: '1.0.0', robot: 1 }));
    expect(ci.preview).toHaveBeenCalledWith(expect.objectContaining({ qrcodeFormat: 'image', qrcodeOutputDest: '/output/qrcode.jpg' }));
    ci.upload.mockClear(); ci.preview.mockClear();
    await runWeappCi({ ...input, action: 'preview', appId: job.appId }, secret); expect(ci.upload).not.toHaveBeenCalled(); expect(ci.preview).toHaveBeenCalledOnce();
    ci.upload.mockRejectedValueOnce(new Error(secret));
    await expect(runWeappCi({ ...input, appId: job.appId }, secret)).rejects.toThrow();
  });
  it('persists redacted logs and QR before success and wipes decrypted buffer', async () => {
    const s = setup(); let buffer: Buffer | undefined;
    s.runner.run.mockImplementationOnce(async (_job, _artifact, privateKey, logs) => { buffer = privateKey; await logs.write('stdout', secret + '\nsecret=hidden\n'); return 'qr-key'; });
    await s.processor.process({ jobId: jid }, jid);
    expect(s.jobs.transition.mock.calls).toEqual([[jid, 'queued', 'running'], [jid, 'running', 'succeeded', null, 'qr-key']]);
    const text = JSON.stringify(s.logs.append.mock.calls); expect(text).not.toContain('synthetic-upload-secret'); expect(text).not.toContain('secret=hidden'); expect(text).toContain('[REDACTED]');
    expect(buffer?.every(byte => byte === 0)).toBe(true);
    expect(s.logs.append.mock.invocationCallOrder.at(-1)).toBeLessThan(s.jobs.transition.mock.invocationCallOrder.at(-1)!);
  });
  it.each([{ status: 'running' }, { status: 'failed' }, { target: 'h5' }, { projectId: randomUUID() }, { artifactKey: null }, { template: 'vue-web' }])('revalidates build before execution: %j', async invalid => {
    const s = setup(invalid); await s.processor.process({ jobId: jid }, jid); expect(s.runner.run).not.toHaveBeenCalled();
    expect(s.jobs.transition).toHaveBeenLastCalledWith(jid, 'running', 'failed', 'weapp_execution_failed');
  });
  it('does not repeat ambiguous running or terminal jobs; validates queue identity', async () => {
    const s = setup();
    for (const status of ['running', 'succeeded', 'failed']) { s.jobs.get.mockResolvedValueOnce({ ...job, status }); await s.processor.process({ jobId: jid }, jid); }
    expect(s.runner.run).not.toHaveBeenCalled(); expect(s.jobs.transition).not.toHaveBeenCalled();
    await expect(s.processor.process({ jobId: jid }, randomUUID())).rejects.toThrow('weapp_job_id_invalid');
  });
  it('uses fixed failures and finishes even when logs fail; cleanup on database failure', async () => {
    const s = setup(); s.runner.run.mockRejectedValueOnce(new Error(secret));
    await s.processor.process({ jobId: jid }, jid); expect(JSON.stringify(s.logs.append.mock.calls)).not.toContain(secret);
    expect(s.jobs.transition).toHaveBeenLastCalledWith(jid, 'running', 'failed', 'weapp_execution_failed');
    const noLogs = setup(); noLogs.logs.append.mockRejectedValue(new Error(secret));
    await noLogs.processor.process({ jobId: jid }, jid); expect(noLogs.jobs.transition).toHaveBeenLastCalledWith(jid, 'running', 'failed', 'weapp_execution_failed');
    const failedSave = setup(); failedSave.jobs.transition.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('db_failed')).mockResolvedValueOnce(undefined);
    await failedSave.processor.process({ jobId: jid }, jid); expect(failedSave.remove).toHaveBeenCalledWith('qr-key');
  });
  it('aborts running work on shutdown and rejects more work', async () => {
    const s = setup();
    s.runner.run.mockImplementationOnce(async (_job, _artifact, _privateKey, _logs, signal) => { s.processor.shutdown(); signal.throwIfAborted(); return null; });
    await s.processor.process({ jobId: jid }, jid); expect(s.jobs.transition).toHaveBeenLastCalledWith(jid, 'running', 'failed', 'weapp_timeout_or_shutdown');
    await expect(s.processor.process({ jobId: jid }, jid)).rejects.toThrow('weapp_worker_stopping');
  });
  it('enforces isolation arguments and requires a dedicated egress network', () => {
    const args = weappDockerArgs({ image: 'forgekit-weapp:local', network: 'weapp-egress' }, '/tmp/task', 'job', 1000, 1000);
    for (const arg of ['--read-only', '--cap-drop=ALL', 'no-new-privileges', '--pull=never', '--log-driver', '300']) expect(args).toContain(arg);
    expect(args).toContain('--interactive');
    expect(args[args.indexOf('--workdir') + 1]).toBe('/tmp');
    expect(args[args.indexOf('--tmpfs') + 1]).toBe('/tmp:rw,nosuid,nodev,size=256m,mode=1777');
    expect(args).toContain('type=bind,source=/tmp/task/input,target=/input,readonly'); expect(args.join(' ')).not.toContain(secret);
    for (const network of ['host', 'bridge', 'none', '', '--privileged']) expect(() => weappDockerArgs({ image: 'image', network }, '/tmp/task', 'job', 1000, 1000)).toThrow();
    expect(() => weappDockerArgs({ image: 'image', network: 'egress' }, '/tmp/task', 'job', 0, 0)).toThrow();
    expect(resolveWeappConfig({})).toBeNull();
    expect(() => resolveWeappConfig({ FORGEKIT_WEAPP_IMAGE: 'image' })).toThrow();
  });
  it('renders the uniapp mini-program build plan', async () => {
    const work = await mkdtemp(join(tmpdir(), 'b17-source-'));
    try {
      const source = new TemplateWorkspaceSource(async () => ({ name: 'b17-demo', template: 'uniapp', features: [] }));
      const plan = await source.prepare({ ...build, sourceRef: 'template:uniapp' } as never, work, new AbortController().signal);
      expect(plan).toEqual({ script: 'build:mp-weixin', outputDirectory: 'dist/build/mp-weixin' });
      expect(await readFile(join(work, 'src/manifest.json'), 'utf8')).toContain('mp-weixin');
      const args = buildDockerArgs({ image: 'node:22', installNetwork: 'none', timeoutMs: 1000, maxLogBytes: 1000, memoryMb: 2048, cpus: 2, pidsLimit: 256 }, { workspace: work, name: 'test', phase: 'build', script: plan.script, uid: 1000, gid: 1000 });
      expect(args.at(-1)).toContain('run build:mp-weixin');
    } finally { await rm(work, { recursive: true, force: true }); }
  });
  it('verifies build digest, publishes only QR artifact, redacts split output and cleans containers', async () => {
    const root = await mkdtemp(join(tmpdir(), 'b17-runner-'));
    try {
      vi.spyOn(process, 'getuid').mockReturnValue(1000); vi.spyOn(process, 'getgid').mockReturnValue(1000);
      const store = new LocalFsArtifactStore(join(root, 'store')), source = join(root, 'source'); await mkdir(source);
      for (const [path, text] of Object.entries({ 'app.js': '//app', 'app.json': '{"pages":["pages/index/index"]}', 'project.config.json': '{}' })) await writeFile(join(source, path), text);
      const artifact = await store.put(bid, source, new AbortController().signal), qr = Buffer.from([255, 216, 1, 255, 217]);
      const execute = vi.fn(async (args, _signal, logs, variables, stdin) => {
        if (args[0] === 'run') {
          const output = args[args.indexOf('--mount') + 1] as string;
          const work = output.split('source=')[1]!.split('/input,')[0]!;
          await expect(readFile(join(work, 'input/private.key'))).rejects.toMatchObject({ code: 'ENOENT' });
          expect(variables).toBeUndefined(); expect(stdin).toEqual(Buffer.from(secret));
          await writeFile(join(work, 'output/qrcode.jpg'), qr);
          await writeFile(join(work, 'output/unwanted.txt'), 'never publish');
          await logs.consume('stdout', (async function* () { yield Buffer.from(secret.slice(0, 30)); yield Buffer.from(secret.slice(30) + '\n'); })());
        } return 0;
      });
      const lines: string[] = [], runner = new DockerWeappRunner(store, { image: 'image', network: 'egress', workspaceRoot: root }, { execute });
      const qrKey = await runner.run(job, artifact, Buffer.from(secret), { write: async (_stream, content) => { lines.push(content); } }, new AbortController().signal);
      expect(lines.join('')).not.toContain('synthetic-upload-secret');
      expect(execute.mock.calls.map(call => call[0][0])).toEqual(['run', 'kill', 'rm']);
      const files: string[] = []; for await (const file of store.list(qrKey!)) files.push(file); expect(files).toEqual(['qrcode.jpg']);
      const file = await store.open(qrKey!, 'qrcode.jpg'); const chunks = []; for await (const chunk of file.body) chunks.push(chunk); expect(Buffer.concat(chunks)).toEqual(qr);
      const invalid = join(root, 'invalid'); await mkdir(invalid);
      await expect(materializeWeapp(store, { ...artifact, sha256: '0'.repeat(64) }, invalid, new AbortController().signal)).rejects.toThrow('weapp_artifact_integrity');
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  it('keeps the signing key out of source-map filesystem reads during upload and preview', async () => {
    const root = await mkdtemp(join(tmpdir(), 'b17-source-map-'));
    try {
      const store = new LocalFsArtifactStore(join(root, 'store')), source = join(root, 'source'); await mkdir(source);
      const map = { version: 3, sources: ['../../input/private.key'], names: [], mappings: 'AAAA' };
      const script = 'console.log("fixture");\n//# sourceMappingURL=data:application/json;base64,' + Buffer.from(JSON.stringify(map)).toString('base64');
      for (const [path, text] of Object.entries({ 'app.js': script, 'app.json': '{"pages":["pages/index/index"]}', 'project.config.json': '{}' })) await writeFile(join(source, path), text);
      const artifact = await store.put(bid, source, new AbortController().signal);
      const generated: string[] = [];
      const execute = vi.fn(async (args, _signal, _logs, variables, stdin) => {
        if (args[0] !== 'run') return 0;
        const mount = args[args.indexOf('--mount') + 1] as string;
        const work = mount.split('source=')[1]!.split('/input,')[0]!;
        // Model the container copy and the SDK loader's unrestricted source-file read.
        // On the old runner /input/private.key exists, so it enters sourcesContent.
        const compile = async ({ project }: { project: { projectPath: string; privateKey?: string; privateKeyPath?: string } }) => {
          const code = await readFile(join(work, 'input/project/app.js'), 'utf8');
          expect(code).toBe(script); // Keep maps: removing them is not the security boundary.
          const original = JSON.parse(Buffer.from(code.split('base64,')[1]!, 'base64').toString('utf8')) as typeof map;
          const sourcesContent = await Promise.all(original.sources.map(async path => {
            const absolute = resolve(dirname(join(project.projectPath, 'app.js')), path);
            try { return await readFile(join(work, absolute.slice(1)), 'utf8'); }
            catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
          }));
          generated.push(JSON.stringify({ ...original, sourcesContent }));
        };
        ci.Project.mockImplementationOnce(function (options: unknown) { return options; });
        ci.upload.mockImplementationOnce(compile); ci.preview.mockImplementationOnce(compile);
        await runWeappCi({ ...input, appId: job.appId }, stdin?.toString('utf8') ?? '/input');
        expect(generated).toHaveLength(2);
        for (const content of generated) expect(content).not.toContain('synthetic-upload-secret');
        expect(variables).toBeUndefined(); expect(stdin).toEqual(Buffer.from(secret));
        await writeFile(join(work, 'output/qrcode.jpg'), Buffer.from([255, 216, 1, 255, 217]));
        return 0;
      });
      const runner = new DockerWeappRunner(store, { image: 'image', network: 'egress', workspaceRoot: root }, { execute });
      await runner.run(job, artifact, Buffer.from(secret), { write: async () => {} }, new AbortController().signal);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
