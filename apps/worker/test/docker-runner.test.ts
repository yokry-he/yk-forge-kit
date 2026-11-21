import { EventEmitter } from 'node:events';
import { chmod, mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough, Writable } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LocalFsArtifactStore } from '../src/artifact-store';
import { DockerBuildRunner, buildDockerArgs } from '../src/docker-runner';
import { DockerCli, type DockerCommand, type DockerSpawn } from '../src/docker-cli';
import { TemplateWorkspaceSource, type WorkspaceSource } from '../src/workspace-source';
import { resolveDockerConfig, resolveWorkerConfig } from '../src/config';
import { CappedBuildLogs } from '../src/build-logs';
import { buildRecord, dockerOptions } from './fixtures';

const roots: string[] = [];
afterEach(async () => { vi.useRealTimers(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
const sink = { write: async () => {} };
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'forgekit-runner-test-')); roots.push(root);
  const work = join(root, 'work'); await mkdir(work);
  const source: WorkspaceSource = { prepare: async (_build, path) => {
    await mkdir(join(path, 'dist')); await writeFile(join(path, 'dist/index.html'), '<html>test</html>');
    return { script: 'build', outputDirectory: 'dist' };
  } };
  return { root, work, source, store: new LocalFsArtifactStore(join(root, 'artifacts')) };
}
describe('Docker arguments and configuration', () => {
  it('hardens both phases, grants only the per-build mount and never inherits platform environment', () => {
    for (const phase of ['install', 'build'] as const) {
      const args = buildDockerArgs({ ...dockerOptions, runtime: 'runsc' }, {
        phase, name: 'own-container', workspace: '/tmp/build-1', uid: 1001, gid: 1001, script: 'build',
      });
      for (const flag of ['--read-only', '--cap-drop=ALL', 'no-new-privileges', '--pids-limit', '--memory', '--memory-swap', '--cpus', '--tmpfs', 'runsc']) {
        expect(args).toContain(flag);
      }
      expect(args[args.indexOf('--user') + 1]).toBe('1001:1001');
      expect(args[args.indexOf('--network') + 1]).toBe(phase === 'build' ? 'none' : 'bridge');
      expect(args.filter((v) => v === '--mount')).toHaveLength(1);
      expect(args).not.toContain('--privileged');
      expect(args.join(' ')).not.toMatch(/docker.sock|DATABASE_URL|REDIS_URL|seccomp=unconfined|--env-file|--pid=host/);
    }
  });
  it('supports registry proxy policy only for install; build never receives proxy configuration', () => {
    const options = { ...dockerOptions, installNetwork: 'registry' as const, registryNetwork: 'forgekit-registry', registryProxy: 'http://proxy:3128' };
    const input = { name: 'own', workspace: '/tmp/work', uid: 1000, gid: 1000, script: 'generate' as const };
    expect(buildDockerArgs(options, { ...input, phase: 'install' })).toContain('HTTPS_PROXY=http://proxy:3128');
    const args = buildDockerArgs(options, { ...input, phase: 'build' });
    expect(args).not.toContain('HTTPS_PROXY=http://proxy:3128'); expect(args).toContain('none');
    expect(args.at(-1)).toBe('corepack pnpm@10.18.3 run generate');
  });
  it('defaults to noop; Docker requires explicit artifact storage and defaults to no install network', () => {
    const env = { DATABASE_URL: 'mysql://u:p@localhost/test', REDIS_URL: 'redis://localhost/15' };
    expect(resolveWorkerConfig(env).runner).toBe('noop');
    expect(() => resolveWorkerConfig({ ...env, FORGEKIT_BUILD_RUNNER: 'docker' })).toThrow();
    expect(resolveDockerConfig({ FORGEKIT_ARTIFACT_DIR: '/tmp/artifacts' }).installNetwork).toBe('none');
    for (const patch of [{ FORGEKIT_BUILD_RUNTIME: '--privileged' }, { FORGEKIT_BUILD_CPUS: '0' },
      { FORGEKIT_BUILD_IMAGE: '--privileged' }, { FORGEKIT_BUILD_INSTALL_NETWORK: 'host' },
      { FORGEKIT_BUILD_INSTALL_NETWORK: 'registry', FORGEKIT_BUILD_REGISTRY_NETWORK: 'host', FORGEKIT_BUILD_REGISTRY_PROXY: 'http://proxy' }]) {
      expect(() => resolveDockerConfig({ FORGEKIT_ARTIFACT_DIR: '/tmp/artifacts', ...patch })).toThrow();
    }
  });
});
describe('Docker runner lifecycle with fake command process', () => {
  it('publishes output after two isolated phases and removes containers before workspace', async () => {
    const f = await fixture(); const calls: string[][] = [];
    const docker: DockerCommand = { execute: async (args) => { calls.push(args); expect(await readdir(f.work)).toHaveLength(1); return 0; } };
    const runner = new DockerBuildRunner(f.source, f.store, { ...dockerOptions, workspaceRoot: f.work }, docker);
    const result = await runner.run(buildRecord(), sink, new AbortController().signal);
    expect(result.exitCode).toBe(0); expect(result.artifact?.size).toBe(17);
    expect(calls.map((args) => args[0])).toEqual(['run', 'kill', 'rm', 'run', 'kill', 'rm']);
    expect(calls[3]?.[calls[3].indexOf('--network') + 1]).toBe('none');
    expect(await readdir(f.work)).toEqual([]);
  });
  it.each(['cancel', 'timeout', 'log failure', 'nonzero'] as const)('cleans only its own container and workspace after %s', async (reason) => {
    const f = await fixture(); const calls: string[][] = [];
    const controller = new AbortController();
    let started!: () => void;
    const starting = new Promise<void>((resolve) => { started = resolve; });
    const docker: DockerCommand = { execute: async (args, signal) => {
      calls.push(args);
      if (args[0] !== 'run') return 0;
      started();
      if (reason === 'nonzero') return 17;
      if (reason === 'log failure') throw new Error('build_log_limit');
      return new Promise<number>((_resolve, reject) => {
        if (signal.aborted) reject(signal.reason);
        else signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      });
    } };
    const runner = new DockerBuildRunner(f.source, f.store, { ...dockerOptions, workspaceRoot: f.work, timeoutMs: reason === 'timeout' ? 1000 : 60000 }, docker);
    const pending = runner.run(buildRecord(), sink, controller.signal);
    const checked = reason === 'nonzero' ? expect(pending).resolves.toEqual({ exitCode: 17 }) : expect(pending).rejects.toThrow();
    await starting;
    if (reason === 'cancel') controller.abort(new Error('canceled'));
    await checked;
    const name = calls[0]?.[2];
    expect(name).toMatch(/^forgekit-/);
    expect(calls.slice(1)).toEqual([['kill', name], ['rm', '--force', name]]);
    expect(await readdir(f.work)).toEqual([]);
  });
  it('attempts rm even when kill throws, and surfaces cleanup errors', async () => {
    const f = await fixture(); const calls: string[] = [];
    const docker: DockerCommand = { execute: async (args) => {
      calls.push(args[0]!); if (args[0] === 'kill') throw new Error('kill failed'); return args[0] === 'rm' ? 1 : 0;
    } };
    await expect(new DockerBuildRunner(f.source, f.store, { ...dockerOptions, workspaceRoot: f.work }, docker)
      .run(buildRecord(), sink, new AbortController().signal)).rejects.toThrow('docker_cleanup_failed');
    expect(calls).toEqual(['run', 'kill', 'rm']);
    // Do not traverse a directory which may still have an active untrusted container writer.
    expect(await readdir(f.work)).toHaveLength(1);
  });
  it('removes owner-unreadable directories left by user code after confirming container deletion', async () => {
    const f = await fixture();
    const source: WorkspaceSource = { prepare: async (_build, path) => {
      await mkdir(join(path, 'blocked')); await writeFile(join(path, 'blocked/file'), 'x');
      await chmod(join(path, 'blocked'), 0);
      return { script: 'build' };
    } };
    const docker: DockerCommand = { execute: async (args) => args[0] === 'run' ? 17 : 0 };
    const result = await new DockerBuildRunner(source, f.store, { ...dockerOptions, workspaceRoot: f.work }, docker)
      .run(buildRecord(), sink, new AbortController().signal);
    expect(result.exitCode).toBe(17); expect(await readdir(f.work)).toEqual([]);
  });
  it.each(['vue-web', 'nuxt-site'])('renders registered %s from project metadata and selects the static build plan', async (template) => {
    const f = await fixture();
    const source = new TemplateWorkspaceSource(async () => ({ name: 'project-name', template, features: template === 'vue-web' ? ['router'] : [] }));
    const plan = await source.prepare(buildRecord(template), f.work, new AbortController().signal);
    const manifest = JSON.parse(await readFile(join(f.work, 'package.json'), 'utf8'));
    expect(manifest.name).toBe('project-name');
    if (template === 'vue-web') expect(manifest.dependencies['vue-router']).toBeTruthy();
    expect(plan).toEqual(template === 'vue-web' ? { script: 'build', outputDirectory: 'dist' }
      : { script: 'generate', outputDirectory: '.output/public' });
  });
  it('rejects unsupported source references before running any code', async () => {
    const f = await fixture(); const docker = { execute: vi.fn(async () => 0) };
    const source = new TemplateWorkspaceSource(async () => ({ name: 'test', template: 'vue-web', features: [] }));
    await expect(new DockerBuildRunner(source, f.store, { ...dockerOptions, workspaceRoot: f.work }, docker)
      .run({ ...buildRecord(), sourceRef: '../../etc/passwd' }, sink, new AbortController().signal)).rejects.toThrow('unsupported_build_source');
    expect(docker.execute).not.toHaveBeenCalled(); expect(await readdir(f.work)).toEqual([]);
  });
});
describe('CLI child lifecycle', () => {
  it('sends a synthetic signing key through stdin and closes the pipe', async () => {
    const stdin = new PassThrough(), stdout = new PassThrough(), stderr = new PassThrough();
    const chunks: Buffer[] = []; stdin.on('data', chunk => chunks.push(chunk));
    const fake = Object.assign(new EventEmitter(), { stdin, stdout, stderr, exitCode: null as number | null, signalCode: null, kill: vi.fn() });
    stdin.on('finish', () => { fake.exitCode = 0; stdout.end(); stderr.end(); fake.emit('close', 0); });
    const start = vi.fn(() => fake as unknown as ReturnType<DockerSpawn>);
    const key = Buffer.from('synthetic-b17-stdin-placeholder');
    expect(await new DockerCli(start).execute(['run', '--interactive'], new AbortController().signal, undefined, undefined, key)).toBe(0);
    expect(Buffer.concat(chunks)).toEqual(key); expect(stdin.writableEnded).toBe(true);
    expect(start).toHaveBeenCalledWith(['run', '--interactive'], undefined);
  });
  it('stops the CLI and reports a fixed error when secret stdin delivery fails', async () => {
    const stdin = new Writable({ write(_chunk, _encoding, callback) { callback(new Error('synthetic-secret-do-not-log')); } });
    const stdout = new PassThrough(), stderr = new PassThrough();
    const fake = Object.assign(new EventEmitter(), { stdin, stdout, stderr, exitCode: null as number | null, signalCode: null,
      kill: vi.fn(() => { queueMicrotask(() => { fake.exitCode = 1; stdout.end(); stderr.end(); fake.emit('close', 1); }); return true; }) });
    const cli = new DockerCli(() => fake as unknown as ReturnType<DockerSpawn>);
    await expect(cli.execute(['run', '--interactive'], new AbortController().signal, undefined, undefined, Buffer.from('synthetic-placeholder'))).rejects.toThrow('docker_cli_input_error');
    expect(fake.kill).toHaveBeenCalledWith('SIGTERM');
  });
  it('aborts and waits for its own fake child to close', async () => {
    const stdout = new PassThrough(); const stderr = new PassThrough();
    const fake = Object.assign(new EventEmitter(), { stdout, stderr, exitCode: null, signalCode: null,
      kill: vi.fn((_signal: string) => {
        queueMicrotask(() => { stdout.end(); stderr.end(); fake.emit('close', null); }); return true;
      }) });
    const controller = new AbortController();
    const cli = new DockerCli(() => fake as unknown as ReturnType<DockerSpawn>);
    const pending = cli.execute(['run', '--name', 'own'], controller.signal);
    controller.abort(new Error('canceled'));
    await expect(pending).rejects.toThrow('canceled');
    expect(fake.kill).toHaveBeenCalledWith('SIGTERM');
  });
  it('stops its fake child when log persistence fails', async () => {
    const stdout = new PassThrough(); const stderr = new PassThrough();
    const fake = Object.assign(new EventEmitter(), { stdout, stderr, exitCode: null as number | null, signalCode: null,
      kill: vi.fn((_signal: string) => {
        queueMicrotask(() => { fake.exitCode = 1; stdout.end(); stderr.end(); fake.emit('close', 1); }); return true;
      }) });
    const cli = new DockerCli(() => fake as unknown as ReturnType<DockerSpawn>);
    const logs = new CappedBuildLogs({ write: async () => { throw new Error('log_store_unavailable'); } }, 1000);
    const pending = cli.execute(['run', '--name', 'own'], new AbortController().signal, logs);
    stdout.write('some output\n');
    await expect(pending).rejects.toThrow('log_store_unavailable');
    expect(fake.kill).toHaveBeenCalledWith('SIGTERM');
  });
  it('escalates to SIGKILL only for its own stubborn fake child', async () => {
    vi.useFakeTimers();
    const stdout = new PassThrough(); const stderr = new PassThrough();
    const fake = Object.assign(new EventEmitter(), { stdout, stderr, exitCode: null as number | null, signalCode: null,
      kill: vi.fn((signal: string) => {
        if (signal === 'SIGKILL') queueMicrotask(() => { fake.exitCode = 1; stdout.end(); stderr.end(); fake.emit('close', null); });
        return true;
      }) });
    const controller = new AbortController();
    const cli = new DockerCli(() => fake as unknown as ReturnType<DockerSpawn>);
    const pending = cli.execute(['run', '--name', 'own'], controller.signal);
    const checked = expect(pending).rejects.toThrow('canceled');
    controller.abort(new Error('canceled'));
    await vi.advanceTimersByTimeAsync(1001); await checked;
    expect(fake.kill.mock.calls.map(([signal]) => signal)).toEqual(['SIGTERM', 'SIGKILL']);
  });
});

describe('B14 Docker environment and log boundary', () => {
  it('injects only selected project variables in build phase, without secret argv or the platform key', async () => {
    const f = await fixture(), secret = 'b14-docker-output-secret';
    const persisted: string[] = [], runs: string[][] = [];
    const docker: DockerCommand = { execute: async (args, _signal, logs, variables) => {
      if (args[0] !== 'run') return 0;
      runs.push(args);
      expect(args.join(' ')).not.toContain(secret);
      expect(args.join(' ')).not.toContain('FORGEKIT_DEPLOY_ENCRYPTION_KEY');
      if (runs.length === 1) { expect(variables).toBeUndefined(); expect(args).not.toContain('APP_TOKEN'); }
      else {
        expect(variables).toEqual({ APP_TOKEN: secret, API_URL: 'https://example.test' });
        expect(args).toContain('APP_TOKEN'); expect(args).toContain('API_URL');
        async function* output() { yield Buffer.from('echo ' + secret.slice(0, 8)); yield Buffer.from(secret.slice(8) + '\n'); }
        await logs!.consume('stdout', output()); await logs!.consume('stderr', output());
      }
      return 0;
    } };
    const resolve = vi.fn(async () => ({ values: { APP_TOKEN: secret, API_URL: 'https://example.test' }, secrets: [secret] }));
    const runner = new DockerBuildRunner(f.source, f.store, { ...dockerOptions, workspaceRoot: f.work }, docker, undefined, resolve);
    const build = buildRecord();
    expect((await runner.run(build, { write: async (_stream, value) => { persisted.push(value); } }, new AbortController().signal)).exitCode).toBe(0);
    expect(resolve).toHaveBeenCalledWith(build);
    expect(persisted.join('')).not.toContain(secret); expect(persisted.join('')).toContain('[REDACTED]');
    expect(runs).toHaveLength(2);
  });
  it('rejects persisted reserved names before invoking Docker', async () => {
    const f = await fixture(), execute = vi.fn(async () => 0);
    const runner = new DockerBuildRunner(f.source, f.store, { ...dockerOptions, workspaceRoot: f.work }, { execute }, undefined,
      async () => ({ values: { FORGEKIT_DEPLOY_ENCRYPTION_KEY: 'must-not-pass' }, secrets: [] }));
    await expect(runner.run(buildRecord(), sink, new AbortController().signal)).rejects.toThrow();
    // Install receives no variables; reserved names are rejected before the build container.
    expect(execute.mock.calls).toHaveLength(3);
  });
});
