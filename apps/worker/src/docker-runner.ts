import { randomUUID } from 'node:crypto';
import { chmod, lstat, mkdir, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkedPath, type ArtifactMetadata, type ArtifactStore } from './artifact-store';
import { CappedBuildLogs, redactBuildLog } from './build-logs';
import { DockerCli, type DockerCommand } from './docker-cli';
import type { BuildLogSink, BuildRecord, BuildRunner } from './runner';
import type { WorkspaceSource } from './workspace-source';

export interface DockerRunnerOptions {
  image: string;
  runtime?: string;
  installNetwork: 'outbound' | 'none' | 'registry';
  registryNetwork?: string;
  registryProxy?: string;
  workspaceRoot?: string;
  timeoutMs: number;
  maxLogBytes: number;
  memoryMb: number;
  cpus: number;
  pidsLimit: number;
}

export function buildDockerArgs(options: DockerRunnerOptions, input: {
  name: string; workspace: string; phase: 'install' | 'build'; script: 'build' | 'generate';
  uid: number; gid: number;
}): string[] {
  if (input.uid <= 0 || input.gid < 0 || /[,\r\n]/.test(input.workspace)) throw new Error('unsafe_docker_workspace_or_user');
  const network = input.phase === 'build' || options.installNetwork === 'none' ? 'none'
    : options.installNetwork === 'registry' ? options.registryNetwork : 'bridge';
  if (!network || (options.installNetwork === 'registry' && !options.registryProxy)) throw new Error('missing_registry_egress');
  const args = ['run', '--name', input.name, '--label', 'forgekit.build=true', '--pull=never',
    '--user', `${input.uid}:${input.gid}`, '--read-only', '--cap-drop=ALL',
    '--security-opt', 'no-new-privileges', // Docker default seccomp remains enabled.
    '--pids-limit', String(options.pidsLimit), '--memory', `${options.memoryMb}m`,
    '--memory-swap', `${options.memoryMb}m`, '--cpus', String(options.cpus),
    '--ulimit', 'nofile=1024:1024', '--ulimit', 'core=0:0', '--init',
    '--log-driver', 'none', '--network', network,
    '--tmpfs', '/tmp:rw,nosuid,nodev,size=256m,mode=1777',
    '--mount', `type=bind,source=${input.workspace},target=/workspace`, '--workdir', '/workspace',
    '--env', 'HOME=/tmp', '--env', 'CI=1', '--env', 'COREPACK_HOME=/workspace/.corepack',
    '--env', 'COREPACK_ENABLE_DOWNLOAD_PROMPT=0', '--env', 'NUXT_TELEMETRY_DISABLED=1'];
  if (options.runtime) args.push('--runtime', options.runtime);
  if (input.phase === 'install' && options.installNetwork === 'registry') {
    args.push('--env', `HTTP_PROXY=${options.registryProxy}`, '--env', `HTTPS_PROXY=${options.registryProxy}`);
  }
  // Explicit version avoids a packageManager field controlling Corepack's download target.
  const command = input.phase === 'install'
    ? 'corepack pnpm@10.18.3 install --no-frozen-lockfile --store-dir /workspace/.pnpm-store'
    : `corepack pnpm@10.18.3 run ${input.script}`;
  // Independent in-container deadline also bounds orphan execution after an abrupt worker death.
  args.push(options.image, 'timeout', '--signal=KILL', String(Math.max(1, Math.ceil(options.timeoutMs / 1000))), 'sh', '-c', command);
  return args;
}

export class DockerBuildRunner implements BuildRunner {
  constructor(private readonly source: WorkspaceSource, private readonly artifacts: ArtifactStore,
    private readonly options: DockerRunnerOptions, private readonly docker: DockerCommand = new DockerCli(),
    private readonly redact: (value: string) => string = redactBuildLog) {}

  async run(build: BuildRecord, sink: BuildLogSink, signal: AbortSignal) {
    const uid = process.getuid?.() ?? 0;
    const gid = process.getgid?.() ?? 0;
    if (uid === 0) throw new Error('docker_worker_requires_non_root');
    const controller = new AbortController();
    const abort = () => controller.abort(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    const timer = setTimeout(() => controller.abort(new Error('build_timeout')), this.options.timeoutMs);
    const logs = new CappedBuildLogs(sink, this.options.maxLogBytes, this.redact);
    let root: string | undefined;
    let artifact: ArtifactMetadata | undefined;
    let containersRemoved = true;
    try {
      controller.signal.throwIfAborted();
      root = await mkdtemp(join(this.options.workspaceRoot ?? tmpdir(), 'forgekit-build-'));
      const workspace = join(root, 'workspace');
      await mkdir(workspace, { mode: 0o700 });
      const plan = await this.source.prepare(build, workspace, controller.signal);
      for (const phase of ['install', 'build'] as const) {
        controller.signal.throwIfAborted();
        const name = `forgekit-${build.id}-${phase}-${randomUUID()}`;
        const args = buildDockerArgs(this.options, { name, workspace, phase, script: plan.script, uid, gid });
        let code: number;
        containersRemoved = false;
        try { code = await this.docker.execute(args, controller.signal, logs); }
        finally {
          // Cleanup uses an independent deadline because the build signal may already be aborted.
          // Kill first (a finished/nonexistent container returns nonzero); rm -f is authoritative.
          try { await this.docker.execute(['kill', name], AbortSignal.timeout(10000)); }
          finally {
            const removed = await this.docker.execute(['rm', '--force', name], AbortSignal.timeout(10000));
            if (removed !== 0) throw new Error('docker_cleanup_failed');
            containersRemoved = true;
          }
        }
        controller.signal.throwIfAborted();
        if (code !== 0) return { exitCode: code };
      }
      const candidates = plan.outputDirectory ? [plan.outputDirectory] : ['dist', '.output/public'];
      let output: string | undefined;
      for (const candidate of candidates) {
        try { output = await checkedPath(workspace, candidate, true); break; }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      }
      if (!output) throw new Error('build_output_missing');
      await checkedPath(output, 'index.html');
      artifact = await this.artifacts.put(build.id, output, controller.signal);
      controller.signal.throwIfAborted();
      return { exitCode: 0, artifact, runnerInfo: { runnerId: 'docker-cli', image: this.options.image } };
    } catch (error) {
      if (artifact) await this.artifacts.remove(artifact.key);
      throw error;
    } finally {
      // An unconfirmed daemon cleanup can leave an active writer. Preserve the private directory
      // for operator recovery rather than traversing attacker-mutated paths on the host.
      try { if (root && containersRemoved) await removeWorkspace(root); }
      finally { clearTimeout(timer); signal.removeEventListener('abort', abort); }
    }
  }
}

/** Only after container removal: restore owner directory permissions without following symlinks. */
async function removeWorkspace(root: string): Promise<void> {
  const pending = [root];
  while (pending.length) {
    const path = pending.pop()!;
    const stat = await lstat(path);
    if (!stat.isDirectory() || stat.isSymbolicLink()) continue;
    await chmod(path, 0o700);
    for (const name of await readdir(path)) pending.push(join(path, name));
  }
  await rm(root, { recursive: true, force: true });
}
