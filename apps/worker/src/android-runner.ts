import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, open, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { checkedPath, safeRelativePath, type LocalFsArtifactStore } from '@forgekit/artifact-store';
import { AndroidArtifactSchema, AndroidSettingsSchema, AndroidJobInputSchema, type AndroidArtifact } from '@forgekit/contracts';
import type { AndroidJobRow } from '@forgekit/db';
import { renderProjectFiles } from '@forgekit/project-core';
import { CappedBuildLogs, redactBuildLog } from './build-logs';
import { buildDockerArgs, removeWorkspace, type DockerRunnerOptions } from './docker-runner';
import { DockerCli, type DockerCommand } from './docker-cli';
import type { BuildLogSink } from './runner';
export interface AndroidRunner {
  run(job: AndroidJobRow, signing: Buffer | undefined, logs: BuildLogSink, signal: AbortSignal): Promise<{ key: string; artifact: AndroidArtifact }>;
}
export interface AndroidRunnerOptions { image: string; build: DockerRunnerOptions }
/** Native assembly and signing have no egress; the signing container never mounts source. */
export function androidDockerArgs(options: AndroidRunnerOptions, work: string, name: string, phase: 'native' | 'sign', uid: number, gid: number) {
  if (uid <= 0 || gid < 0 || /[,\r\n]/.test(work) || !/^[a-zA-Z0-9][a-zA-Z0-9._/:@-]{0,254}$/.test(options.image)) throw new Error('android_isolation_config_invalid');
  return ['run', '--name', name, '--label', 'forgekit.android=true', '--pull=never', '--user', `${uid}:${gid}`,
    '--read-only', '--interactive', '--workdir', '/tmp', '--cap-drop=ALL', '--security-opt', 'no-new-privileges', '--init', '--log-driver', 'none',
    '--pids-limit', '256', '--memory', '4096m', '--memory-swap', '4096m', '--cpus', '2',
    '--ulimit', 'nofile=1024:1024', '--ulimit', 'core=0:0', '--network', 'none',
    '--tmpfs', '/tmp:rw,nosuid,nodev,size=2048m,mode=1777', '--env', 'HOME=/tmp', '--env', 'CI=1',
    '--mount', `type=bind,source=${work}/${phase === 'native' ? 'resources' : 'unsigned'},target=/input,readonly`,
    '--mount', `type=bind,source=${work}/${phase === 'native' ? 'unsigned' : 'signed'},target=/output`,
    options.image, 'timeout', '--signal=KILL', '600', 'python3', '/opt/android/package.py', phase];
}
export class DockerAndroidRunner implements AndroidRunner {
  constructor(private readonly store: Pick<LocalFsArtifactStore, 'put' | 'remove'>,
    private readonly options: AndroidRunnerOptions, private readonly docker: DockerCommand = new DockerCli()) {}
  async run(job: AndroidJobRow, signing: Buffer | undefined, sink: BuildLogSink, signal: AbortSignal) {
    const uid = process.getuid?.() ?? 0, gid = process.getgid?.() ?? 0;
    if (uid === 0) throw new Error('android_worker_requires_non_root');
    const settings = AndroidSettingsSchema.parse(job.settings), input = AndroidJobInputSchema.parse(job.input);
    if (input.buildType === 'release' && !signing) throw new Error('android_signing_required');
    // Signer diagnostics are suppressed inside the trusted entry. This second boundary protects adapters/tests.
    const secrets = signing ? Object.values(JSON.parse(signing.toString()) as Record<string, string>) : [];
    const work = await mkdtemp(join(this.options.build.workspaceRoot ?? tmpdir(), 'forgekit-android-'));
    let removed = true, published: string | undefined;
    const logs = new CappedBuildLogs(sink, 1048576, value => redactBuildLog(value, secrets));
    const execute = async (phase: string, args: (name: string) => string[], stdin?: Uint8Array) => {
      signal.throwIfAborted();
      const name = `forgekit-android-${job.id}-${phase}-${randomUUID()}`;
      removed = false;
      let code: number;
      try { code = await this.docker.execute(args(name), signal, logs, undefined, stdin); }
      finally {
        try { await this.docker.execute(['kill', name], AbortSignal.timeout(10000)); }
        finally {
          if (await this.docker.execute(['rm', '--force', name], AbortSignal.timeout(10000)) !== 0) throw new Error('android_cleanup_failed');
          removed = true;
        }
      }
      signal.throwIfAborted(); if (code !== 0) throw new Error('android_step_failed');
    };
    try {
      try {
        for (const dir of ['workspace', 'resources', 'unsigned', 'signed', 'publish']) await mkdir(join(work, dir), { mode: 0o700 });
        const workspace = join(work, 'workspace');
        // Same template-only source boundary as B09. No host paths, arbitrary Gradle or uploaded plugins.
        const files = renderProjectFiles({ name: job.source.name, template: 'uniapp', features: job.source.features });
        const manifest = JSON.parse(files['src/manifest.json']!) as Record<string, unknown>;
        Object.assign(manifest, { appid: settings.appId, versionName: settings.versionName, versionCode: String(settings.versionCode) });
        files['src/manifest.json'] = JSON.stringify(manifest);
        for (const [path, content] of Object.entries(files)) {
          signal.throwIfAborted(); safeRelativePath(path); const target = join(workspace, path);
          await mkdir(dirname(target), { recursive: true, mode: 0o700 }); await writeFile(target, content, { mode: 0o600, flag: 'wx' });
        }
        for (const phase of ['install', 'build'] as const) {
          await sink.write('system', phase === 'install' ? '准备 App 编译依赖。\n' : '离线编译 App 资源。\n');
          await execute(phase, name => buildDockerArgs(this.options.build, { name, workspace, phase, script: 'build:app', uid, gid }));
        }
        const output = await checkedPath(workspace, 'dist/build/app', true);
        for (const required of ['manifest.json', 'app-service.js']) await checkedPath(output, required);
        const manifestFile = await open(await checkedPath(output, 'manifest.json'), 'r');
        let compiled: { id?: string };
        try {
          if ((await manifestFile.stat()).size > 1048576) throw new Error('android_manifest_size');
          compiled = JSON.parse(await manifestFile.readFile('utf8')) as { id?: string };
        } finally { await manifestFile.close(); }
        if (compiled.id !== settings.appId) throw new Error('android_appid_mismatch');
        // ArtifactStore validates every entry before a new container reads compiled resources.
        // Use a temporary local store as a bounded, symlink-rejecting copy, never publish resources.
        const { LocalFsArtifactStore } = await import('@forgekit/artifact-store');
        const transfer = new LocalFsArtifactStore(join(work, 'transfer'), 104857600);
        const checked = await transfer.put(job.id, output, signal);
        // The validated snapshot directory is immutable once all compile containers are removed.
        const { cp } = await import('node:fs/promises');
        await cp(join(work, 'transfer', checked.key), join(work, 'resources', 'app'), { recursive: true });
        const metadata = JSON.stringify({ settings, input });
        await writeFile(join(work, 'resources/job.json'), metadata, { mode: 0o600 });
        await execute('native', name => androidDockerArgs(this.options, work, name, 'native', uid, gid));
        // Copy ONLY the bounded unsigned binary into the signer's mount, never project scripts or maps.
        await checkedPath(join(work, 'unsigned'), `app.${input.kind}`);
        await writeFile(join(work, 'unsigned/job.json'), metadata, { mode: 0o600 });
        await execute('sign', name => androidDockerArgs(this.options, work, name, 'sign', uid, gid), signing);
        const file = await open(await checkedPath(join(work, 'signed'), `app.${input.kind}`), 'r');
        let data: Buffer;
        try { if ((await file.stat()).size > 268435456) throw new Error('android_artifact_size'); data = await file.readFile(); }
        finally { await file.close(); }
        if (data.length < 4 || data.readUInt32LE(0) !== 0x04034b50) throw new Error('android_artifact_format');
        const artifact = AndroidArtifactSchema.parse({ kind: input.kind, size: data.length, sha256: createHash('sha256').update(data).digest('hex') });
        await writeFile(join(work, 'publish', `app.${input.kind}`), data, { mode: 0o600 });
        published = (await this.store.put(job.id, join(work, 'publish'), signal)).key;
        signal.throwIfAborted(); return { key: published, artifact };
      } finally {
        // Traverse only once every container writer is confirmed removed.
        if (removed) await removeWorkspace(work);
      }
    } catch (error) {
      // Cleanup errors must also roll back this invocation's publication before rejecting.
      if (published) await this.store.remove(published);
      throw error;
    }
  }
}
