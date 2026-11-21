import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { chmod, mkdtemp, mkdir, writeFile, readFile, readdir, rm, stat, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LocalFsArtifactStore } from '@forgekit/artifact-store';
import { encryptAndroidSigning, AndroidConflictError, type AndroidJobRow } from '@forgekit/db';
import type { BuildLogSink } from '../src/runner';
import { AndroidProcessor } from '../src/android-processor';
import { DockerAndroidRunner, androidDockerArgs } from '../src/android-runner';
import { removeWorkspace } from '../src/docker-runner';
import * as dockerRunner from '../src/docker-runner';
import type { DockerCommand } from '../src/docker-cli';
import { resolveAndroidConfig } from '../src/android-worker';
const id = randomUUID(), key = randomBytes(32);
const settings = { packageName: 'com.example.demo', appId: '__UNI__TEST123', appKey: 'synthetic-appkey', versionName: '1.0.0', versionCode: 1 };
const signing = { keystore: 'dGVzdGtleQ==', alias: 'release', storePassword: 'store-password', keyPassword: 'key-password' };
const job: AndroidJobRow = { id, projectId: id, settings, source: { name: 'android-demo', features: [] }, input: { buildType: 'release', kind: 'apk' }, status: 'queued', triggeredBy: id, errorCode: null, artifact: null, artifactKey: null, createdAt: new Date(), updatedAt: new Date(), startedAt: null, finishedAt: null };
const binary = Buffer.from([0x50, 0x4b, 3, 4, 1, 2, 3]);
const artifact = { kind: 'apk' as const, size: binary.length, sha256: createHash('sha256').update(binary).digest('hex') };
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });
function setup() {
  const jobs = { get: vi.fn().mockResolvedValue(job), config: vi.fn().mockResolvedValue({ settings, encryptedSigning: encryptAndroidSigning(JSON.stringify(signing), key, id) }), transition: vi.fn().mockResolvedValue(undefined) };
  const logs = { append: vi.fn() }, runner = { run: vi.fn<(_job: AndroidJobRow, secret: Buffer | undefined, logs: BuildLogSink, signal: AbortSignal) => Promise<{ key: string; artifact: typeof artifact }>>().mockResolvedValue({ key: 'artifact', artifact }) }, remove = vi.fn();
  return { jobs, logs, runner, remove, processor: new AndroidProcessor(jobs, logs, runner, key, remove) };
}
describe('B18 queued packaging processor', () => {
  it('redacts all signing values, publishes metadata after logs and wipes the secret buffer', async () => {
    const s = setup(); let buffer: Buffer | undefined;
    s.runner.run.mockImplementationOnce(async (_job, secret, logs) => { buffer = secret; await logs.write('stderr', Object.values(signing).join('\n')); return { key: 'artifact', artifact }; });
    await s.processor.process({ jobId: id }, id);
    const text = JSON.stringify(s.logs.append.mock.calls); for (const secret of Object.values(signing)) expect(text).not.toContain(secret);
    expect(text).toContain('[REDACTED]'); expect(buffer?.every(byte => byte === 0)).toBe(true);
    expect(s.jobs.transition).toHaveBeenLastCalledWith(id, 'running', 'succeeded', null, 'artifact', artifact);
    expect(s.logs.append.mock.invocationCallOrder.at(-1)).toBeLessThan(s.jobs.transition.mock.invocationCallOrder.at(-1)!);
  });
  it('debug builds never decrypt or receive the release signing key', async () => {
    const s = setup(); s.jobs.get.mockResolvedValueOnce({ ...job, input: { buildType: 'debug', kind: 'apk' } });
    await s.processor.process({ jobId: id }, id); expect(s.jobs.config).not.toHaveBeenCalled(); expect(s.runner.run.mock.calls[0]?.[1]).toBeUndefined();
  });
  it('never reruns terminal or reclaimed jobs; validates payload and queue identity', async () => {
    const s = setup();
    for (const status of ['running', 'succeeded', 'failed']) { s.jobs.get.mockResolvedValueOnce({ ...job, status }); await s.processor.process({ jobId: id }, id); }
    expect(s.runner.run).not.toHaveBeenCalled(); expect(s.jobs.transition).toHaveBeenCalledWith(id, 'running', 'failed', 'android_worker_lost');
    await expect(s.processor.process({ jobId: id }, randomUUID())).rejects.toThrow('android_job_id_invalid');
  });
  it('handles configuration deletion/changes, malformed encrypted data, execution and log failures without secrets', async () => {
    for (const config of [null, { settings, encryptedSigning: 'malformed' }, { settings: { ...settings, packageName: 'com.changed.demo' }, encryptedSigning: 'bad' }]) {
      const s = setup(); s.jobs.config.mockResolvedValueOnce(config); await s.processor.process({ jobId: id }, id);
      expect(s.runner.run).not.toHaveBeenCalled(); expect(s.jobs.transition).toHaveBeenLastCalledWith(id, 'running', 'failed', 'android_execution_failed');
    }
    const s = setup(); s.logs.append.mockRejectedValue(new Error(signing.storePassword)); await s.processor.process({ jobId: id }, id);
    expect(s.jobs.transition).toHaveBeenLastCalledWith(id, 'running', 'failed', 'android_execution_failed');
  });
  it('removes published files if success cannot commit, and tolerates a canceled CAS', async () => {
    const s = setup(); s.jobs.transition.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new AndroidConflictError());
    await s.processor.process({ jobId: id }, id); expect(s.remove).toHaveBeenCalledWith('artifact');
    expect(s.jobs.transition).toHaveBeenLastCalledWith(id, 'running', 'failed', 'android_execution_failed');
  });
  it('aborts work for cancel and shutdown, waits for runner cleanup, rejects new intake', async () => {
    vi.useFakeTimers(); const s = setup(); s.jobs.get.mockResolvedValueOnce(job).mockResolvedValue({ ...job, status: 'running', errorCode: 'android_cancel_requested' });
    let cleaned = false;
    s.runner.run.mockImplementationOnce(async (_job, _secret, _logs, signal) => {
      await new Promise<void>(resolve => signal.addEventListener('abort', () => { cleaned = true; resolve(); }, { once: true })); signal.throwIfAborted(); return { key: 'x', artifact };
    });
    const task = s.processor.process({ jobId: id }, id); await vi.advanceTimersByTimeAsync(1100); await task;
    expect(cleaned).toBe(true); expect(s.jobs.transition).toHaveBeenLastCalledWith(id, 'running', 'failed', 'android_aborted');
    s.processor.shutdown(); await expect(s.processor.process({ jobId: id }, id)).rejects.toThrow('android_worker_stopping');
  });
});
const options = { image: 'forgekit-android:b18', build: { image: 'node:22.21.1-bookworm', installNetwork: 'none' as const, timeoutMs: 600000, maxLogBytes: 1048576, memoryMb: 2048, cpus: 2, pidsLimit: 256 } };
describe('B18 Docker adapter', () => {
  it('enforces offline isolation and mounts only stage inputs; refuses root and unsafe images/paths', () => {
    const args = androidDockerArgs(options, '/tmp/task', 'name', 'sign', 1000, 1000);
    for (const flag of ['--read-only', '--cap-drop=ALL', 'no-new-privileges', '--pull=never', '--interactive', '--log-driver']) expect(args).toContain(flag);
    expect(args[args.indexOf('--network') + 1]).toBe('none');
    expect(args).toContain('type=bind,source=/tmp/task/unsigned,target=/input,readonly');
    expect(args.join(' ')).not.toMatch(/workspace|docker.sock|privileged|store-password/);
    expect(() => androidDockerArgs(options, '/tmp/a,b', 'name', 'sign', 1000, 1000)).toThrow();
    expect(() => androidDockerArgs(options, '/tmp/a', 'name', 'sign', 0, 0)).toThrow();
    expect(resolveAndroidConfig({})).toBeNull(); expect(() => resolveAndroidConfig({ FORGEKIT_ANDROID_IMAGE: '--bad' })).toThrow();
  });
  it.each(['success', 'failed', 'symlink', 'cleanup-failed', 'abort', 'restricted-000', 'restricted-0555', 'workspace-cleanup-failed'] as const)('runs isolated phases, verifies artifact metadata and cleans containers: %s', async mode => {
    vi.spyOn(process, 'getuid').mockReturnValue(1000); vi.spyOn(process, 'getgid').mockReturnValue(1000);
    const root = await mkdtemp(join(tmpdir(), 'b18-runner-')), controller = new AbortController();
    const store = new LocalFsArtifactStore(join(root, 'artifacts')); const sink = { write: vi.fn() };
    const put = vi.spyOn(store, 'put'), remove = vi.spyOn(store, 'remove');
    const restricted = mode === 'restricted-000' || mode === 'restricted-0555';
    const external = join(root, 'external');
    if (restricted) { await mkdir(external, { mode: 0o755 }); await writeFile(join(external, 'keep'), 'untouched'); }
    const commands: string[][] = [], secret = Buffer.from(JSON.stringify(signing));
    const docker: DockerCommand = { execute: async (args, _signal, logs, _variables, stdin) => {
      commands.push(args);
      if (args[0] === 'rm') return mode === 'cleanup-failed' ? 1 : 0;
      if (args[0] !== 'run') return 0;
      const mounts = args.filter(a => a.startsWith('type=bind'));
      const host = (value: string) => value.split('source=')[1]!.split(',target=')[0]!;
      const phase = args.at(-1);
      if (phase === 'sign') {
        expect(stdin?.toString()).toBe(secret.toString()); expect(mounts.join(' ')).not.toContain('workspace');
        expect(await readdir(host(mounts[0]!))).toEqual(expect.arrayContaining(['app.apk', 'job.json']));
        await logs?.consume('stdout', (async function* () { yield Buffer.from('store-'); yield Buffer.from('password\n'); })());
        await writeFile(join(host(mounts[1]!), 'app.apk'), binary);
      } else if (phase === 'native') {
        expect(stdin).toBeUndefined(); expect(args[args.indexOf('--network') + 1]).toBe('none');
        expect(await readFile(join(host(mounts[0]!), 'app/manifest.json'), 'utf8')).toContain(settings.appId);
        await writeFile(join(host(mounts[1]!), 'app.apk'), binary);
      } else {
        expect(stdin).toBeUndefined();
        const workspace = host(mounts[0]!);
        expect(await readFile(join(workspace, 'src/manifest.json'), 'utf8')).not.toContain(signing.storePassword);
        if (phase?.includes(' install ') && restricted) {
          const blocked = join(workspace, 'node_modules/blocked');
          await mkdir(join(blocked, 'nested'), { recursive: true }); await writeFile(join(blocked, 'nested/file'), 'cache');
          await symlink(external, join(blocked, 'external'));
          await chmod(join(blocked, 'nested'), 0);
          await chmod(blocked, mode === 'restricted-000' ? 0 : 0o555);
        }
        if (mode === 'workspace-cleanup-failed' && phase?.includes('run build:app')) {
          vi.spyOn(dockerRunner, 'removeWorkspace').mockRejectedValueOnce(new Error('injected_workspace_cleanup_failure'));
        }
        if (args.at(-1)?.includes('run build:app')) {
          if (mode === 'failed') return 1;
          if (mode === 'abort') { controller.abort(); controller.signal.throwIfAborted(); }
          const output = join(workspace, 'dist/build/app'); await mkdir(output, { recursive: true });
          await writeFile(join(output, 'manifest.json'), JSON.stringify({ id: settings.appId })); await writeFile(join(output, 'app-service.js'), 'compiled');
          if (mode === 'symlink') await symlink('/etc/passwd', join(output, 'escape'));
        }
      }
      return 0;
    } };
    try {
      const runner = new DockerAndroidRunner(store, { ...options, build: { ...options.build, workspaceRoot: root } }, docker);
      if (mode !== 'success' && !restricted) await expect(runner.run(job, secret, sink, controller.signal)).rejects.toThrow(mode === 'workspace-cleanup-failed' ? 'injected_workspace_cleanup_failure' : undefined);
      else {
        const result = await runner.run(job, secret, sink, controller.signal); expect(result.artifact).toEqual(artifact);
        expect(await readdir(join(root, 'artifacts', result.key))).toEqual(['app.apk']);
        expect(JSON.stringify(sink.write.mock.calls)).not.toContain(signing.storePassword); expect(JSON.stringify(sink.write.mock.calls)).toContain('[REDACTED]');
        expect(remove).not.toHaveBeenCalled();
      }
      if (restricted) {
        expect(await readFile(join(external, 'keep'), 'utf8')).toBe('untouched');
        expect((await stat(external)).mode & 0o777).toBe(0o755);
      }
      if (mode === 'workspace-cleanup-failed') {
        expect(put).toHaveBeenCalledOnce(); const published = await put.mock.results[0]!.value;
        expect(remove).toHaveBeenCalledExactlyOnceWith(published.key);
        await expect(stat(join(root, 'artifacts', published.key))).rejects.toMatchObject({ code: 'ENOENT' });
      }
      const runs = commands.filter(args => args[0] === 'run');
      expect(commands.filter(args => args[0] === 'rm')).toHaveLength(runs.length);
      expect(commands.filter(args => args[0] === 'kill')).toHaveLength(runs.length);
      const leftovers = (await readdir(root)).filter(name => name.startsWith('forgekit-android-'));
      expect(leftovers.length).toBe(mode === 'cleanup-failed' || mode === 'workspace-cleanup-failed' ? 1 : 0);
    } finally { vi.restoreAllMocks(); await removeWorkspace(root); }
  });
});
