import { materializeMiniProgram } from './mini-program-artifact';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, open, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkedPath, type LocalFsArtifactStore } from '@forgekit/artifact-store';
import { AlipayJobInputSchema, qrImageType } from '@forgekit/contracts';
import type { AlipayJobRow } from '@forgekit/db';
import { CappedBuildLogs, redactBuildLog } from './build-logs';
import { DockerCli, type DockerCommand } from './docker-cli';
import type { BuildLogSink } from './runner';
export interface AlipayRunner {
  run(job: AlipayJobRow, artifact: { key: string; sha256: string }, privateKey: Buffer, logs: BuildLogSink, signal: AbortSignal): Promise<string | null>;
}
export interface AlipayRunnerOptions { image: string; network: string; workspaceRoot?: string }
export function alipayDockerArgs(options: AlipayRunnerOptions, work: string, name: string, uid: number, gid: number) {
  if (uid <= 0 || gid < 0 || /[,\r\n]/.test(work) || !/^[a-zA-Z0-9][a-zA-Z0-9._/:@-]{0,254}$/.test(options.image) ||
    !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,63}$/.test(options.network) || ['host', 'bridge', 'default', 'none'].includes(options.network)) throw new Error('alipay_isolation_config_invalid');
  return ['run', '--name', name, '--label', 'forgekit.alipay=true', '--pull=never', '--user', `${uid}:${gid}`,
    '--read-only', '--interactive', '--workdir', '/tmp', '--cap-drop=ALL', '--security-opt', 'no-new-privileges', '--init', '--log-driver', 'none',
    '--pids-limit', '256', '--memory', '2048m', '--memory-swap', '2048m', '--cpus', '2',
    '--ulimit', 'nofile=1024:1024', '--ulimit', 'core=0:0', '--network', options.network,
    '--tmpfs', '/tmp:rw,nosuid,nodev,size=768m,mode=1777', '--env', 'HOME=/tmp', '--env', 'CI=1',
    '--mount', `type=bind,source=${work}/input,target=/input,readonly`,
    '--mount', `type=bind,source=${work}/output,target=/output`,
    options.image, 'timeout', '--signal=KILL', '300', 'node', '/opt/alipay/dist/alipay-ci.js'];
}
/** Separate from the offline build: only this short-lived container receives the upload key. */
export class DockerAlipayRunner implements AlipayRunner {
  constructor(private readonly store: Pick<LocalFsArtifactStore, 'list' | 'open' | 'put' | 'remove'>,
    private readonly options: AlipayRunnerOptions, private readonly docker: DockerCommand = new DockerCli()) {}
  async run(job: AlipayJobRow, artifact: { key: string; sha256: string }, privateKey: Buffer, sink: BuildLogSink, signal: AbortSignal) {
    const uid = process.getuid?.() ?? 0, gid = process.getgid?.() ?? 0;
    if (uid === 0) throw new Error('alipay_worker_requires_non_root');
    const input = AlipayJobInputSchema.parse(job.input);
    const work = await mkdtemp(join(this.options.workspaceRoot ?? tmpdir(), 'forgekit-alipay-'));
    const name = `forgekit-alipay-${job.id}-${randomUUID()}`;
    let removed = true, qrKey: string | null = null;
    try {
      const project = join(work, 'input/project'); await mkdir(project, { recursive: true, mode: 0o700 });
      await mkdir(join(work, 'output'), { mode: 0o700 });
      await materializeAlipay(this.store, artifact, project, signal);
      await writeFile(join(work, 'input/job.json'), JSON.stringify({ ...input, appId: job.appId, toolId: job.toolId }), { mode: 0o600, flag: 'wx' });
      const logs = new CappedBuildLogs(sink, 65536, value => redactBuildLog(value, [privateKey.toString('utf8')]));
      const args = alipayDockerArgs(this.options, work, name, uid, gid);
      removed = false;
      let code;
      // The key never enters a mounted file, argv or environment. The trusted entry drains
      // stdin before loading the SDK, so source-map filesystem reads cannot recover it.
      try { code = await this.docker.execute(args, signal, logs, undefined, privateKey); }
      finally {
        try { await this.docker.execute(['kill', name], AbortSignal.timeout(10000)); }
        finally {
          if (await this.docker.execute(['rm', '--force', name], AbortSignal.timeout(10000)) !== 0) throw new Error('alipay_cleanup_failed');
          removed = true;
        }
      }
      signal.throwIfAborted();
      if (code !== 0) throw new Error('alipay_ci_failed');
      if (input.action !== 'upload') {
        const qr = await checkedPath(join(work, 'output'), 'qrcode.img');
        const handle = await open(qr, 'r');
        let data: Buffer;
        try { if ((await handle.stat()).size > 1048576) throw new Error('alipay_qr_size'); data = await handle.readFile(); }
        finally { await handle.close(); }
        qrImageType(data);
        // Publish only the validated image, never arbitrary SDK/container output.
        const publish = join(work, 'publish'); await mkdir(publish, { mode: 0o700 });
        await writeFile(join(publish, 'qrcode.img'), data, { mode: 0o600 });
        qrKey = (await this.store.put(job.id, publish, signal)).key;
      }
      signal.throwIfAborted(); return qrKey;
    } catch (error) { if (qrKey) await this.store.remove(qrKey); throw error; }
    finally { if (removed) await rm(work, { recursive: true, force: true }); }
  }
}
export const materializeAlipay = (store: Pick<LocalFsArtifactStore, 'list' | 'open'>, artifact: { key: string; sha256: string }, directory: string, signal: AbortSignal) =>
  materializeMiniProgram(store, artifact, directory, signal, 'alipay', ['app.js', 'app.json', 'mini.project.json']);
