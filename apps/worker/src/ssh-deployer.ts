import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, open, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { LocalFsArtifactStore } from '@forgekit/artifact-store';
import { decryptDeployKey, type DeploymentRow, type DeployTargetRow } from '@forgekit/db';
import { VariableNameSchema, DeployTargetCreateSchema } from '@forgekit/contracts';
import { boundedCommand, SshDeployError, sshArguments } from './ssh-command';
import { releaseRoot, releaseScript, retentionPlan, shellQuote } from './ssh-release';

export interface StaticDeployer {
  run(job: DeploymentRow, target: DeployTargetRow, artifact: { key: string; sha256: string }, retained: string[],
    log: (content: string) => Promise<void>, signal: AbortSignal, variables?: Readonly<Record<string, string>>): Promise<string[]>;
}
/** The OpenSSH adapter never forwards remote output into persistent logs. */
export class SshStaticDeployer implements StaticDeployer {
  constructor(private readonly store: Pick<LocalFsArtifactStore, 'list' | 'open'>, private readonly encryptionKey: Buffer) {}
  async run(job: DeploymentRow, target: DeployTargetRow, artifact: { key: string; sha256: string }, retained: string[],
    log: (content: string) => Promise<void>, signal: AbortSignal, variables: Readonly<Record<string, string>> = {}): Promise<string[]> {
    if (!job.releaseId || !target.encryptedPrivateKey) throw new SshDeployError('deploy_target_incomplete');
    // Revalidate persisted input, including legacy B07 placeholder targets.
    const validated = DeployTargetCreateSchema.omit({ privateKey: true }).parse({ name: target.name, host: target.host, port: target.port,
      username: target.username, hostKey: target.hostKey, basePath: target.basePath, retention: target.retention });
    const root = releaseRoot(validated.basePath, job.projectId, target.id);
    const work = await mkdtemp(join(tmpdir(), 'forgekit-ssh-'));
    let plaintext: Buffer | undefined;
    try {
      plaintext = decryptDeployKey(target.encryptedPrivateKey, this.encryptionKey, job.projectId, target.id);
      const keyFile = join(work, 'identity'), hostsFile = join(work, 'known_hosts');
      await writeFile(keyFile, plaintext, { mode: 0o600 }); plaintext.fill(0); plaintext = undefined;
      await writeFile(hostsFile, `forgekit-target ${validated.hostKey}\n`, { mode: 0o600 });
      // No passphrase, interactive agent or environment-based askpass is supported.
      await boundedCommand('ssh-keygen', ['-y', '-P', '', '-f', keyFile], signal);
      const plan = job.action === 'rollback' ? { keep: retained, prune: [] } : retentionPlan(job.releaseId, retained, target.retention);
      if (job.action === 'rollback' && !retained.includes(job.releaseId)) throw new SshDeployError('release_not_retained');
      let archive: string | undefined;
      if (job.action === 'deploy') {
        await log('正在校验并准备静态制品。\n');
        const source = join(work, 'site'); await mkdir(source, { mode: 0o755 });
        let total = 0, count = 0, hasIndex = false;
        const manifest: Array<[string, number, string]> = [];
        for await (const path of this.store.list(artifact.key)) {
          signal.throwIfAborted();
          if (++count > 10000 || ['.forgekit-complete', '.forgekit-env'].includes(path.split('/')[0]!)) throw new SshDeployError('artifact_entry_limit');
          const file = await this.store.open(artifact.key, path);
          await mkdir(dirname(join(source, path)), { recursive: true });
          const out = await open(join(source, path), 'wx', 0o644);
          const hash = createHash('sha256'); let size = 0;
          try {
            for await (const chunk of file.body) {
              signal.throwIfAborted(); total += chunk.length; size += chunk.length;
              if (total > 104857600) throw new SshDeployError('artifact_size_limit');
              hash.update(chunk); await out.writeFile(chunk);
            }
          } finally { file.close?.(); await out.close(); }
          manifest.push([path, size, hash.digest('hex')]); if (path === 'index.html') hasIndex = true;
        }
        const digest = createHash('sha256');
        for (const entry of manifest.sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) digest.update(JSON.stringify(entry) + '\n');
        if (!hasIndex || digest.digest('hex') !== artifact.sha256) throw new SshDeployError('artifact_integrity_failed');
        archive = join(work, 'site.tar');
        await writeFile(archive, '', { mode: 0o600, flag: 'wx' });
        // Normalize only site payload permissions, independently of the Worker's umask.
        await boundedCommand('tar', ['--mode=u=rwX,go=rX', '-cf', archive, '-C', source, '.'], signal);
        // Append a private transport entry after normalizing public site permissions.
        await writeFile(join(work, '.forgekit-env'), serializeDotEnv(variables), { mode: 0o600, flag: 'wx' });
        await boundedCommand('tar', ['--mode=0600', '-rf', archive, '-C', work, '.forgekit-env'], signal);
      }
      await log(job.action === 'rollback' ? '正在连接 SSH 主机并切换至保留版本。\n' : '正在连接 SSH 主机、上传制品并原子切换版本。\n');
      const output = await boundedCommand('ssh', sshArguments(validated, keyFile, hostsFile,
        releaseScript(root, job.id, job.releaseId, job.action === 'rollback', plan.prune, true)), signal, archive);
      if (!output.split('\n').includes('B12_DONE')) throw new SshDeployError('deploy_remote_result_invalid');
      await log('远端版本切换和保留期清理已完成。\n');
      return plan.keep;
    } finally { plaintext?.fill(0); await rm(work, { recursive: true, force: true }); }
  }
}

/** POSIX .env assignments: quoted literals, including multiline values; never execute values. */
export function serializeDotEnv(variables: Readonly<Record<string, string>>): string {
  return Object.entries(variables).sort(([a], [b]) => a.localeCompare(b))
    .map(([name, value]) => `${VariableNameSchema.parse(name)}=${shellQuote(value)}\n`).join('');
}
