import { redactBuildLog } from './build-logs';

/** Infrastructure diagnostics only; never serialize arbitrary driver/config objects. */
export function workerErrorDetails(error: unknown, env: NodeJS.ProcessEnv = process.env): { error: string } {
  const secrets: string[] = [];
  for (const [name, value] of Object.entries(env)) {
    if (!value) continue;
    if (/(?:password|passwd|secret|token|key|credential)/i.test(name)) secrets.push(value);
    if (/(?:url|uri)$/i.test(name)) {
      try {
        const url = new URL(value);
        for (const credential of [url.password]) {
          if (credential) secrets.push(credential, decodeURIComponent(credential));
        }
      } catch { /* Invalid URLs are still scrubbed by the patterns below. */ }
    }
  }
  const seen = new Set<unknown>();
  function describe(reason: unknown): string {
    if (seen.has(reason)) return '[circular cause]';
    seen.add(reason);
    if (!(reason instanceof Error)) return typeof reason === 'string' ? reason : 'Unknown worker error';
    const detail = reason.stack || `${reason.name}: ${reason.message}`;
    return detail + (reason.cause === undefined ? '' : `\nCaused by: ${describe(reason.cause)}`);
  }
  let detail = describe(error);
  // Replace escaped values before generic patterns can fragment them at quotes or delimiters.
  const variants = secrets.flatMap(secret => [secret, JSON.stringify(secret).slice(1, -1)]);
  // Include short configured credentials too; build output redaction has a four-character minimum.
  for (const secret of [...new Set(variants)].sort((a, b) => b.length - a.length)) {
    detail = detail.split(secret).join('[REDACTED]');
  }
  detail = detail
    .replace(/([a-z][a-z\d+.-]*:\/\/)[^\s/]*@/gi, '$1[REDACTED]@')
    .replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/g, '[REDACTED]')
    .replace(/\bBearer\s+[^\s,;"']+/gi, 'Bearer [REDACTED]')
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, '[REDACTED]')
    .replace(/((?:[\w.-]*(?:password|passwd|secret|token|key|credential)[\w.-]*)["']?\s*[=:]\s*)(?:"(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'|[^\s,;}]+)/gi, '$1[REDACTED]');
  return { error: redactBuildLog(detail, secrets) };
}

export function reportWorkerStartFailure(error: unknown): void {
  console.error(JSON.stringify({ event: 'worker_start_failed', ...workerErrorDetails(error) }));
  process.exitCode = 1;
}
