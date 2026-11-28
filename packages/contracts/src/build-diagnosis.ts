import { z } from 'zod';
import { redactBuildLog } from './build-log-redaction';

export const buildDiagnosisCategories = [
  'dependency_registry_network', 'dependency_lockfile_mismatch', 'dependency_missing_package',
  'install_network_disabled', 'compile_error', 'out_of_memory', 'timeout',
  'runner_unavailable', 'artifact_missing', 'unknown',
] as const;
export type BuildDiagnosisCategory = typeof buildDiagnosisCategories[number];
export const BuildDiagnosisSchema = z.strictObject({
  category: z.enum(buildDiagnosisCategories),
  // Sequence numbers identify stored log chunks (a chunk can contain several lines).
  matchedLogSeqs: z.array(z.number().int().min(1).max(4294967295)).max(3),
  excerpt: z.array(z.string().max(240)).max(3),
});
export type BuildDiagnosis = z.infer<typeof BuildDiagnosisSchema>;
export interface BuildFailureSignals {
  exitCode?: number | null;
  errorCodes?: readonly string[];
  phase?: 'install' | 'build' | 'artifact';
  installNetwork?: 'none' | 'outbound' | 'registry';
}
export interface DiagnosisLog { seq: number; content: string }

const networkFailure = /\b(?:ETIMEDOUT|ENOTFOUND|ECONNREFUSED|ECONNRESET|EAI_AGAIN)\b|registry.*(?:unreachable|connection refused|fetch failed)|(?:failed|unable) to (?:fetch|download).*registry|corepack.*(?:download|fetch).*(?:failed|error)|corepack.*(?:failed|unable) to (?:download|fetch)/i;
const patterns: Partial<Record<BuildDiagnosisCategory, RegExp>> = {
  timeout: /build_timeout|timed? out|killed by timeout/i,
  out_of_memory: /JavaScript heap out of memory|heap limit|OOMKilled|out of memory/i,
  runner_unavailable: /cannot connect to the docker daemon|docker daemon.*(?:unreachable|not running)|error during connect|pull access denied|unable to find image|failed to pull|image.*pull.*fail|runner.*not configured/i,
  artifact_missing: /build_output_missing|(?:output|artifact) (?:dir(?:ectory)?|files?).*(?:missing|empty|not found)/i,
  dependency_lockfile_mismatch: /ERR_PNPM_OUTDATED_LOCKFILE|frozen-lockfile|npm ci.*(?:lock|sync)|npm (?:ERR!|error).*package\.json.*(?:lock|sync)|npm (?:ERR!|error).*(?:Missing: .* from lock file|Invalid: lock file)/i,
  dependency_missing_package: /ERR_PNPM_FETCH_404|\bE404\b|No matching version|not found in (?:the )?registry/i,
  dependency_registry_network: networkFailure,
  install_network_disabled: new RegExp(`${networkFailure.source}|network.*(?:disabled|unreachable)|install_network_disabled`, 'i'),
  compile_error: /error TS\d{4}|SyntaxError|Could not resolve|error during build|(?:vite|rollup|esbuild|vue-tsc|tsc).*(?:error|failed)|(?:error|failed).*\[?(?:vite|rollup|esbuild)|\[plugin:(?:vite|vue)|Transform failed with.*error/i,
};
const structured: ReadonlyArray<[BuildDiagnosisCategory, readonly string[]]> = [
  ['timeout', ['build_timeout']],
  ['out_of_memory', ['OOMKilled']],
  ['runner_unavailable', ['docker_cli_error', 'docker_cleanup_failed', 'docker_worker_requires_non_root', 'runner_not_configured', 'worker_lost', 'queue_enqueue_failed', 'queue_job_ended_before_start', 'missing_registry_egress']],
  ['artifact_missing', ['build_output_missing', 'build_output_empty', 'build_artifact_missing', 'artifact_storage_unavailable']],
];

function safeExcerpt(line: string): string {
  const clean = line.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').replace(/[\x00-\x1f\x7f]/g, '');
  let excerpt = '';
  // Iterate by code point, keeping the schema's UTF-16 limit and replacing malformed input.
  for (const point of clean) {
    if (excerpt.length + point.length > 240) break;
    excerpt += point.length === 1 && /[\ud800-\udfff]/.test(point) ? '\ufffd' : point;
  }
  return excerpt;
}

/** Pure, deterministic and bounded output. Redaction happens BEFORE any excerpt truncation. */
export function classifyBuildFailure(input: BuildFailureSignals & { logs: readonly DiagnosisLog[]; secrets?: readonly string[] }): BuildDiagnosis {
  const logs = input.logs.map(log => ({ seq: log.seq, content: redactBuildLog(log.content, input.secrets) }));
  const codes = input.errorCodes ?? [];
  let category: BuildDiagnosisCategory | undefined = structured.find(([, values]) => values.some(code => codes.includes(code)))?.[0];
  if (!category && input.exitCode === 125) category = 'runner_unavailable';
  // GNU timeout returns 124; SIGKILL/137 alone is only a probable memory failure.
  if (!category && input.exitCode === 124) category = 'timeout';
  if (!category && input.exitCode === 137) category = 'out_of_memory';
  if (!category) category = (['dependency_lockfile_mismatch', 'dependency_missing_package', 'compile_error'] as const)
    .find(id => codes.some(code => patterns[id]?.test(code)));
  const has = (id: BuildDiagnosisCategory) => logs.some(log => patterns[id]?.test(log.content));
  if (!category) category = (['out_of_memory', 'runner_unavailable', 'artifact_missing',
    'dependency_lockfile_mismatch', 'dependency_missing_package'] as const).find(has);
  if (!category && input.phase === 'install' && input.installNetwork === 'none'
    && (has('install_network_disabled') || codes.some(code => patterns.install_network_disabled?.test(code)))) category = 'install_network_disabled';
  // Build containers are deliberately offline: a build-time DNS error is not an install error.
  if (!category && input.phase !== 'build' && (has('dependency_registry_network')
    || codes.some(code => patterns.dependency_registry_network?.test(code)))) category = 'dependency_registry_network';
  if (!category && has('compile_error')) category = 'compile_error';
  if (!category && has('timeout')) category = 'timeout';
  category ??= 'unknown';
  const matched = logs.filter(log => patterns[category]?.test(log.content)).slice(0, 3);
  const excerpt = matched.flatMap(log => log.content.split(/\r?\n/).filter(line => patterns[category]?.test(line)))
    .slice(0, 3).map(safeExcerpt);
  return { category, matchedLogSeqs: matched.map(log => log.seq), excerpt };
}
