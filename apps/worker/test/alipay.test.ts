import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LocalFsArtifactStore } from '@forgekit/artifact-store';
import { encryptAlipayKey, type AlipayJobRow } from '@forgekit/db';
import { AlipayJobInputSchema } from '@forgekit/contracts';
import { AlipayProcessor } from '../src/alipay-processor';
import { DockerAlipayRunner, materializeAlipay, alipayDockerArgs } from '../src/alipay-runner';
import { TemplateWorkspaceSource } from '../src/workspace-source';
import { buildDockerArgs } from '../src/docker-runner';
import { runAlipayCi, downloadAlipayQr, prepareAlipayProject } from '../src/alipay-ci';
import { resolveAlipayConfig } from '../src/alipay-worker';
const ci = vi.hoisted(() => ({ upload: vi.fn(), preview: vi.fn(), config: { useRuntime: vi.fn() } }));
const controls = vi.hoisted(() => ({ setSilent: vi.fn(), setSpinnerEnabled: vi.fn(), setLogLevelVerboseEnabled: vi.fn(), useDefaults: vi.fn() }));
vi.mock('minidev', () => ({ minidev: ci, ...controls }));
const pid = randomUUID(), bid = randomUUID(), jid = randomUUID(), key = randomBytes(32), secret = '-----BEGIN TEST KEY-----\nsynthetic-upload-secret\n-----END TEST KEY-----';
const input = AlipayJobInputSchema.parse({ buildId: bid, version: '1.0.0', action: 'upload_preview' });
const job: AlipayJobRow = { id: jid, projectId: pid, buildId: bid, appId: '0000000000000000', toolId: 'synthetic-tool', input,
  status: 'queued', triggeredBy: randomUUID(), createdAt: new Date(), updatedAt: new Date(), startedAt: null, finishedAt: null, errorCode: null, qrArtifactKey: null };
const build = { id: bid, projectId: pid, template: 'uniapp', target: 'mp-alipay', status: 'succeeded', artifactKey: 'artifact', artifactSha256: 'digest' };
afterEach(() => { vi.restoreAllMocks(); vi.clearAllMocks(); });
function setup(overrides = {}) {
  const jobs = { get: vi.fn().mockResolvedValue(job), config: vi.fn().mockResolvedValue({ appId: job.appId, toolId: job.toolId, encryptedPrivateKey: encryptAlipayKey(secret, key, pid) }), transition: vi.fn() };
  const builds = { get: vi.fn().mockResolvedValue({ ...build, ...overrides }) };
  const logs = { append: vi.fn() }, runner = { run: vi.fn().mockResolvedValue('qr-key') }, remove = vi.fn();
  const processor = new AlipayProcessor(jobs, builds, logs, runner, key, remove);
  return { jobs, builds, logs, runner, processor, remove };
}
describe('B20 isolated Alipay processing', () => {
  it('uses the official runtime-only auth API, supports experience promotion and generates a private raster QR', async () => {
    const root = await mkdtemp(join(tmpdir(), 'b20-sdk-'));
    try {
      ci.upload.mockResolvedValue({ version: '1.0.0', experienceQrCodeUrl: 'https://mdn.alipayobjects.com/experience.jpg' }); ci.preview.mockResolvedValue({ qrcodeUrl: 'https://mdn.alipayobjects.com/mock.jpg', version: 'preview' });
      const image = vi.fn<typeof fetch>().mockResolvedValue(new Response(Buffer.from([255,216,1,255,217])));
      await runAlipayCi({ ...input, target: 'experience', appId: job.appId, toolId: job.toolId }, secret, root, () => {}, image);
      expect(ci.config.useRuntime).toHaveBeenNthCalledWith(1, { 'alipay.authentication': { privateKey: secret, toolId: job.toolId } });
      expect(ci.config.useRuntime).toHaveBeenLastCalledWith({ 'alipay.authentication': { privateKey: '', toolId: '' } });
      expect(ci.upload).toHaveBeenCalledWith({ appId: job.appId, project: '/tmp/project', clientType: 'alipay', version: '1.0.0', versionDescription: '', experience: true });
      expect(ci.preview).toHaveBeenCalledWith(expect.objectContaining({ project: '/tmp/project', sourceMap: false, parallel: false }));
      expect(await readFile(join(root, 'qrcode.img'))).toEqual(Buffer.from([255,216,1,255,217]));
      ci.upload.mockClear(); ci.preview.mockClear();
      await runAlipayCi({ ...input, action: 'upload', appId: job.appId, toolId: job.toolId }, secret, root);
      expect(ci.upload).toHaveBeenCalledWith(expect.objectContaining({ experience: false })); expect(ci.preview).not.toHaveBeenCalled();
      ci.upload.mockRejectedValueOnce(new Error(secret));
      await expect(runAlipayCi({ ...input, appId: job.appId, toolId: job.toolId }, secret, root)).rejects.toThrow();
      expect(ci.config.useRuntime).toHaveBeenLastCalledWith({ 'alipay.authentication': { privateKey: '', toolId: '' } });
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  it('does not report experience success without the official confirmation result', async () => {
    ci.upload.mockResolvedValueOnce({ version: '1.0.0' });
    await expect(runAlipayCi({ ...input, action: 'upload', target: 'experience', appId: job.appId, toolId: job.toolId }, secret)).rejects.toThrow('alipay_experience_unconfirmed');
  });
  it('limits QR downloads to HTTPS official hosts, refuses redirects, invalid bodies and oversized images', async () => {
    const image = vi.fn<typeof fetch>();
    for (const url of ['http://alipay.com/x', 'https://alipay.com.evil.example/x', 'https://127.0.0.1/x', 'https://user:pass@alipay.com/x', 'https://alipay.com:8080/x']) await expect(downloadAlipayQr(url, image)).rejects.toThrow();
    expect(image).not.toHaveBeenCalled();
    image.mockResolvedValueOnce(new Response('<html>failure</html>'));
    await expect(downloadAlipayQr('https://mdn.alipayobjects.com/x', image)).rejects.toThrow('alipay_qr_invalid');
    expect(image).toHaveBeenCalledWith(expect.any(URL), expect.objectContaining({ redirect: 'error' }));
    image.mockResolvedValueOnce(new Response(Buffer.alloc(1048577)));
    await expect(downloadAlipayQr('https://mdn.alipayobjects.com/x', image)).rejects.toThrow('alipay_qr_size');
  });
  it('replaces untrusted CLI configuration with fixed uniapp-compatible Alipay settings, preserving source maps', async () => {
    const root = await mkdtemp(join(tmpdir(), 'b20-prepare-'));
    try {
      const source = join(root, 'source'), project = join(root, 'project'); await mkdir(source);
      await writeFile(join(source, 'mini.project.json'), JSON.stringify({ plugins: { attacker: 'run.js' }, miniprogramRoot: '../../' }));
      await writeFile(join(source, '.forgekit-empty-config.json'), '{"compiler.version.cube":"untrusted"}');
      const code = '//# sourceMappingURL=app.js.map'; await writeFile(join(source, 'app.js'), code);
      await prepareAlipayProject({ ...input, appId: job.appId, toolId: job.toolId }, source, project, join(root, 'global.json'));
      const config = JSON.parse(await readFile(join(project, 'mini.project.json'), 'utf8'));
      expect(config).toMatchObject({ appid: job.appId, format: 2, enableAppxNg: true, component2: true });
      expect(config).not.toHaveProperty('plugins'); expect(config).not.toHaveProperty('miniprogramRoot');
      expect(await readFile(join(project, '.forgekit-empty-config.json'), 'utf8')).toBe('{}');
      expect(await readFile(join(project, 'app.js'), 'utf8')).toBe(code);
    } finally { await rm(root, { recursive: true, force: true }); }
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
    expect(s.jobs.transition).toHaveBeenLastCalledWith(jid, 'running', 'failed', 'alipay_execution_failed');
  });
  it.each([null, { appId: '1111111111111111', toolId: job.toolId }, { appId: job.appId, toolId: 'changed-tool' }])('fails safely when config identity changes or is removed: %j', async config => {
    const s = setup(); s.jobs.config.mockResolvedValueOnce(config);
    await s.processor.process({ jobId: jid }, jid);
    expect(s.runner.run).not.toHaveBeenCalled();
    expect(s.jobs.transition).toHaveBeenLastCalledWith(jid, 'running', 'failed', 'alipay_execution_failed');
  });
  it('does not repeat ambiguous running or terminal jobs; validates queue identity', async () => {
    const s = setup();
    for (const status of ['running', 'succeeded', 'failed']) { s.jobs.get.mockResolvedValueOnce({ ...job, status }); await s.processor.process({ jobId: jid }, jid); }
    expect(s.runner.run).not.toHaveBeenCalled(); expect(s.jobs.transition).not.toHaveBeenCalled();
    await expect(s.processor.process({ jobId: jid }, randomUUID())).rejects.toThrow('alipay_job_id_invalid');
  });
  it('uses fixed failures and finishes even when logs fail; cleanup on database failure', async () => {
    const s = setup(); s.runner.run.mockRejectedValueOnce(new Error(secret));
    await s.processor.process({ jobId: jid }, jid); expect(JSON.stringify(s.logs.append.mock.calls)).not.toContain(secret);
    expect(s.jobs.transition).toHaveBeenLastCalledWith(jid, 'running', 'failed', 'alipay_execution_failed');
    const noLogs = setup(); noLogs.logs.append.mockRejectedValue(new Error(secret));
    await noLogs.processor.process({ jobId: jid }, jid); expect(noLogs.jobs.transition).toHaveBeenLastCalledWith(jid, 'running', 'failed', 'alipay_execution_failed');
    const failedSave = setup(); failedSave.jobs.transition.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('db_failed')).mockResolvedValueOnce(undefined);
    await failedSave.processor.process({ jobId: jid }, jid); expect(failedSave.remove).toHaveBeenCalledWith('qr-key');
  });
  it('aborts running work on shutdown and rejects more work', async () => {
    const s = setup();
    s.runner.run.mockImplementationOnce(async (_job, _artifact, _privateKey, _logs, signal) => { s.processor.shutdown(); signal.throwIfAborted(); return null; });
    await s.processor.process({ jobId: jid }, jid); expect(s.jobs.transition).toHaveBeenLastCalledWith(jid, 'running', 'failed', 'alipay_timeout_or_shutdown');
    await expect(s.processor.process({ jobId: jid }, jid)).rejects.toThrow('alipay_worker_stopping');
  });
  it('enforces isolation arguments and requires a dedicated egress network', () => {
    const args = alipayDockerArgs({ image: 'forgekit-alipay:local', network: 'alipay-egress' }, '/tmp/task', 'job', 1000, 1000);
    for (const arg of ['--read-only', '--cap-drop=ALL', 'no-new-privileges', '--pull=never', '--log-driver', '300']) expect(args).toContain(arg);
    expect(args).toContain('--interactive');
    expect(args[args.indexOf('--workdir') + 1]).toBe('/tmp');
    expect(args[args.indexOf('--tmpfs') + 1]).toBe('/tmp:rw,nosuid,nodev,size=768m,mode=1777');
    expect(args).toContain('type=bind,source=/tmp/task/input,target=/input,readonly'); expect(args.join(' ')).not.toContain(secret);
    for (const network of ['host', 'bridge', 'none', '', '--privileged']) expect(() => alipayDockerArgs({ image: 'image', network }, '/tmp/task', 'job', 1000, 1000)).toThrow();
    expect(() => alipayDockerArgs({ image: 'image', network: 'egress' }, '/tmp/task', 'job', 0, 0)).toThrow();
    expect(resolveAlipayConfig({})).toBeNull();
    expect(() => resolveAlipayConfig({ FORGEKIT_ALIPAY_IMAGE: 'image' })).toThrow();
  });
  it('renders the uniapp mini-program build plan', async () => {
    const work = await mkdtemp(join(tmpdir(), 'b20-source-'));
    try {
      const source = new TemplateWorkspaceSource(async () => ({ name: 'b20-demo', template: 'uniapp', features: [] }));
      const plan = await source.prepare({ ...build, sourceRef: 'template:uniapp' } as never, work, new AbortController().signal);
      expect(plan).toEqual({ script: 'build:mp-alipay', outputDirectory: 'dist/build/mp-alipay' });
      expect(await readFile(join(work, 'src/manifest.json'), 'utf8')).toContain('mp-alipay');
      const args = buildDockerArgs({ image: 'node:22', installNetwork: 'none', timeoutMs: 1000, maxLogBytes: 1000, memoryMb: 2048, cpus: 2, pidsLimit: 256 }, { workspace: work, name: 'test', phase: 'build', script: plan.script, uid: 1000, gid: 1000 });
      expect(args.at(-1)).toContain('run build:mp-alipay');
    } finally { await rm(work, { recursive: true, force: true }); }
  });
  it('verifies build digest, publishes only QR artifact, redacts split output and cleans containers', async () => {
    const root = await mkdtemp(join(tmpdir(), 'b20-runner-'));
    try {
      vi.spyOn(process, 'getuid').mockReturnValue(1000); vi.spyOn(process, 'getgid').mockReturnValue(1000);
      const store = new LocalFsArtifactStore(join(root, 'store')), source = join(root, 'source'); await mkdir(source);
      for (const [path, text] of Object.entries({ 'app.js': '//app', 'app.json': '{"pages":["pages/index/index"]}', 'mini.project.json': '{}' })) await writeFile(join(source, path), text);
      const artifact = await store.put(bid, source, new AbortController().signal), qr = Buffer.from([255, 216, 1, 255, 217]);
      const execute = vi.fn(async (args, _signal, logs, variables, stdin) => {
        if (args[0] === 'run') {
          const output = args[args.indexOf('--mount') + 1] as string;
          const work = output.split('source=')[1]!.split('/input,')[0]!;
          await expect(readFile(join(work, 'input/private.key'))).rejects.toMatchObject({ code: 'ENOENT' });
          expect(variables).toBeUndefined(); expect(stdin).toEqual(Buffer.from(secret));
          await writeFile(join(work, 'output/qrcode.img'), qr);
          await writeFile(join(work, 'output/unwanted.txt'), 'never publish');
          await logs.consume('stdout', (async function* () { yield Buffer.from(secret.slice(0, 30)); yield Buffer.from(secret.slice(30) + '\n'); })());
        } return 0;
      });
      const lines: string[] = [], runner = new DockerAlipayRunner(store, { image: 'image', network: 'egress', workspaceRoot: root }, { execute });
      const qrKey = await runner.run(job, artifact, Buffer.from(secret), { write: async (_stream, content) => { lines.push(content); } }, new AbortController().signal);
      expect(lines.join('')).not.toContain('synthetic-upload-secret');
      expect(execute.mock.calls.map(call => call[0][0])).toEqual(['run', 'kill', 'rm']);
      const files: string[] = []; for await (const file of store.list(qrKey!)) files.push(file); expect(files).toEqual(['qrcode.img']);
      const file = await store.open(qrKey!, 'qrcode.img'); const chunks = []; for await (const chunk of file.body) chunks.push(chunk); expect(Buffer.concat(chunks)).toEqual(qr);
      const invalid = join(root, 'invalid'); await mkdir(invalid);
      await expect(materializeAlipay(store, { ...artifact, sha256: '0'.repeat(64) }, invalid, new AbortController().signal)).rejects.toThrow('alipay_artifact_integrity');
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  it('keeps the signing key out of source-map filesystem reads during upload and preview', async () => {
    const root = await mkdtemp(join(tmpdir(), 'b20-source-map-'));
    try {
      const store = new LocalFsArtifactStore(join(root, 'store')), source = join(root, 'source'); await mkdir(source);
      const map = { version: 3, sources: ['../../input/private.key'], names: [], mappings: 'AAAA' };
      const script = 'console.log("fixture");\n//# sourceMappingURL=data:application/json;base64,' + Buffer.from(JSON.stringify(map)).toString('base64');
      for (const [path, text] of Object.entries({ 'app.js': script, 'app.json': '{"pages":["pages/index/index"]}', 'mini.project.json': '{}' })) await writeFile(join(source, path), text);
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
        const compileProject = () => compile({ project: { projectPath: '/tmp/project' } });
        ci.upload.mockImplementationOnce(compileProject);
        ci.preview.mockImplementationOnce(async () => { await compileProject(); return { qrcodeUrl: 'https://mdn.alipayobjects.com/mock.jpg', version: 'preview' }; });
        const image = vi.fn<typeof fetch>().mockResolvedValue(new Response(Buffer.from([255,216,1,255,217])));
        await runAlipayCi({ ...input, appId: job.appId, toolId: job.toolId }, stdin?.toString('utf8') ?? '', join(work, 'output'), () => {}, image);
        expect(generated).toHaveLength(2);
        for (const content of generated) expect(content).not.toContain('synthetic-upload-secret');
        expect(variables).toBeUndefined(); expect(stdin).toEqual(Buffer.from(secret));
        await writeFile(join(work, 'output/qrcode.img'), Buffer.from([255, 216, 1, 255, 217]));
        return 0;
      });
      const runner = new DockerAlipayRunner(store, { image: 'image', network: 'egress', workspaceRoot: root }, { execute });
      await runner.run(job, artifact, Buffer.from(secret), { write: async () => {} }, new AbortController().signal);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
