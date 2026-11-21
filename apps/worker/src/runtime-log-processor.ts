import { RUNTIME_LOG_LIMITS as limits, RuntimeLogJobSchema, type RuntimeLogInput } from '@forgekit/contracts';
import { type RuntimeLogRepository, type DeployRepository, type DomainRepository, type ResolvedVariables } from '@forgekit/db';
import { CappedBuildLogs, redactBuildLog } from './build-logs';
import { SshDeployError } from './ssh-command';
import type { RuntimeLogHost } from './runtime-log-ssh';

/** JSON metadata filters; the keyword is a literal substring on the redacted text, never a remote expression. */
export function runtimeLineMatches(line: string, input: RuntimeLogInput, startedAt: Date): boolean {
  if (input.keyword && !line.includes(input.keyword)) return false;
  if (input.level === 'all' && input.windowMinutes === 0) return true;
  let value: { level?: unknown; ts?: unknown };
  try { value = JSON.parse(line) as typeof value; } catch { return false; }
  if (!value || typeof value !== 'object') return false;
  if (input.level !== 'all' && (typeof value.level !== 'string' || value.level.toLowerCase() !== input.level)) return false;
  if (input.windowMinutes) {
    const ts = typeof value.ts === 'number' ? value.ts * 1000 : typeof value.ts === 'string' ? Date.parse(value.ts) : NaN;
    if (!Number.isFinite(ts) || ts < startedAt.getTime() - input.windowMinutes * 60000 || ts > Date.now() + 60000) return false;
  }
  return true;
}
export class RuntimeLogProcessor {
  private readonly active = new Set<AbortController>();
  private stopping = false;
  constructor(private readonly sessions: Pick<RuntimeLogRepository, 'get' | 'start' | 'append' | 'finish'>,
    private readonly targets: Pick<DeployRepository, 'target'>, private readonly domains: Pick<DomainRepository, 'get'>,
    private readonly host: RuntimeLogHost,
    private readonly variables: (projectId: string) => Promise<ResolvedVariables>) {}
  shutdown() { this.stopping = true; for (const abort of this.active) abort.abort(); }
  async process(payload: unknown, jobId: string | undefined) {
    const { sessionId } = RuntimeLogJobSchema.parse(payload);
    if (jobId !== sessionId) throw new Error('runtime_job_invalid');
    if (this.stopping || !await this.sessions.start(sessionId)) return;
    const row = await this.sessions.get(sessionId);
    if (!row) return;
    const abort = new AbortController(); this.active.add(abort);
    const timer = setTimeout(() => abort.abort(), Math.max(1, row.expiresAt.getTime() - Date.now()));
    let monitor: ReturnType<typeof setTimeout> | undefined, monitoring: Promise<void> | undefined;
    let resolved: ResolvedVariables = { values: {}, secrets: [] };
    const check = async () => {
      try {
        const current = await this.sessions.get(sessionId);
        const domain = await this.domains.get(row.domainId);
        const target = await this.targets.target(row.projectId, row.deployTargetId);
        if (!current || current.status !== 'running' || current.leaseUntil.getTime() <= Date.now() ||
          !domain || domain.status === 'revoked' || !domain.claimedHostname || !target || target.disabledAt) abort.abort();
      } catch { abort.abort(); }
      if (!abort.signal.aborted) monitor = setTimeout(schedule, 500);
    };
    const schedule = () => { monitoring = check(); };
    try {
      if (this.stopping) abort.abort();
      const target = await this.targets.target(row.projectId, row.deployTargetId), domain = await this.domains.get(row.domainId);
      if (!target || target.disabledAt || !target.currentReleaseId || !domain || domain.projectId !== row.projectId ||
        domain.deployTargetId !== target.id || domain.status === 'revoked' || !domain.claimedHostname) throw new Error('runtime_target_unavailable');
      resolved = await this.variables(row.projectId);
      const redact = (line: string) => redactBuildLog(line, [...resolved.secrets, target.encryptedPrivateKey ?? '', process.env.FORGEKIT_DEPLOY_ENCRYPTION_KEY ?? '']);
      const logs = new CappedBuildLogs({ write: async (_stream, content) => { await this.sessions.append(sessionId, content); } }, limits.bytes, redact);
      monitor = setTimeout(schedule, 500);
      await this.host.read(target, row.input, resolved.secrets, async line => {
        abort.signal.throwIfAborted();
        const clean = redact(line);
        if (runtimeLineMatches(clean, row.input, row.createdAt)) await logs.write('stdout', clean);
      }, abort.signal);
      await this.sessions.finish(sessionId, 'ended');
    } catch (error) {
      const code = error instanceof SshDeployError && ['ssh_host_key_mismatch', 'ssh_auth_failed', 'ssh_output_limit'].includes(error.message) ? error.message : 'runtime_read_failed';
      await this.sessions.finish(sessionId, abort.signal.aborted ? 'ended' : 'failed', abort.signal.aborted ? 'runtime_session_closed' : code);
    } finally {
      abort.abort(); clearTimeout(timer); clearTimeout(monitor); await monitoring;
      resolved.values = {}; resolved.secrets = []; this.active.delete(abort);
    }
  }
}
