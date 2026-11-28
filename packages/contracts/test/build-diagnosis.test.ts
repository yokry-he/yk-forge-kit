import { describe, expect, it } from 'vitest';
import { BuildDiagnosisSchema, classifyBuildFailure, type BuildFailureSignals, type BuildDiagnosisCategory } from '../src';

describe('build failure diagnosis', () => {
  const samples: Array<[BuildDiagnosisCategory, BuildFailureSignals, string]> = [
    ['dependency_registry_network', { phase: 'install' }, 'WARN GET https://registry.npmjs.org/vue error (ETIMEDOUT). Will retry.'],
    ['dependency_lockfile_mismatch', { phase: 'install' }, 'ERR_PNPM_OUTDATED_LOCKFILE Cannot install with frozen-lockfile because pnpm-lock.yaml is not up to date'],
    ['dependency_missing_package', { phase: 'install' }, 'ERR_PNPM_FETCH_404 GET https://registry.npmjs.org/@example%2fmissing: Not Found - 404'],
    ['install_network_disabled', { phase: 'install', installNetwork: 'none' }, 'getaddrinfo EAI_AGAIN registry.npmjs.org'],
    ['compile_error', { phase: 'build' }, 'src/App.vue(12,3): error TS2322: Type string is not assignable to type number.'],
    ['out_of_memory', { exitCode: 137 }, 'FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory'],
    ['timeout', { errorCodes: ['build_timeout'] }, 'build_timeout: killed by timeout'],
    ['runner_unavailable', { exitCode: 125 }, 'docker: Cannot connect to the Docker daemon at unix:///var/run/docker.sock.'],
    ['artifact_missing', { errorCodes: ['build_output_missing'] }, 'build_output_missing'],
    ['unknown', { exitCode: 1 }, 'ELIFECYCLE Command failed with exit code 1.'],
  ];
  it.each(samples)('classifies %s with bounded safe evidence', (category, signals, content) => {
    const result = classifyBuildFailure({ ...signals, logs: [{ seq: 7, content: 'Starting build' }, { seq: 42, content }] });
    expect(result.category).toBe(category);
    expect(BuildDiagnosisSchema.parse(result)).toEqual(result);
    expect(result.matchedLogSeqs).toEqual(category === 'unknown' ? [] : [42]);
  });
  it.each([
    ['dependency_registry_network', 'getaddrinfo ENOTFOUND registry.npmjs.org'],
    ['dependency_registry_network', 'read ECONNRESET'],
    ['dependency_lockfile_mismatch', 'npm error npm ci can only install when package.json and package-lock.json are in sync'],
    ['dependency_lockfile_mismatch', 'npm error Missing: vue@3.5.0 from lock file'],
    ['dependency_missing_package', 'npm error code E404'],
    ['dependency_missing_package', 'No matching version found for example@99.0.0'],
    ['dependency_missing_package', 'example is not found in the registry'],
    ['compile_error', '[vite:vue] [plugin:vite:vue] SyntaxError: Unexpected token'],
    ['compile_error', 'RollupError: Could not resolve "./missing" from "src/main.ts"'],
    ['compile_error', 'esbuild: Transform failed with 1 error'],
    ['compile_error', 'vue-tsc error: type check failed'],
    ['compile_error', 'tsc failed with errors'],
    ['runner_unavailable', 'Unable to find image node:22 locally'],
    ['runner_unavailable', 'failed to pull image: pull access denied'],
    ['runner_unavailable', 'runner not configured'],
    ['out_of_memory', 'State: OOMKilled'],
    ['timeout', 'process killed by timeout'],
  ])('recognizes %s sample: %s', (category, content) => {
    expect(classifyBuildFailure({ logs: [{ seq: 1, content }] }).category).toBe(category);
  });
  it('prefers structured signals and stable rule order over incidental log text', () => {
    const logs = [{ seq: 1, content: 'error TS2322: nope\nERR_PNPM_FETCH_404\nETIMEDOUT' }];
    expect(classifyBuildFailure({ errorCodes: ['build_timeout'], exitCode: 137, logs }).category).toBe('timeout');
    expect(classifyBuildFailure({ phase: 'install', installNetwork: 'none', logs }).category).toBe('dependency_missing_package');
    expect(classifyBuildFailure({ errorCodes: ['build_output_missing'], logs }).category).toBe('artifact_missing');
    expect(classifyBuildFailure({ phase: 'build', logs: [{ seq: 1, content: 'ENOTFOUND registry.npmjs.org' }] }).category).toBe('unknown');
    expect(classifyBuildFailure({ exitCode: 124, logs: [] }).category).toBe('timeout');
  });
  it.each([
    ['unknown', 'ERR_PNPM_UNSUPPORTED_ENGINE Unsupported Node.js version: wanted >=24, current v22.0.0'],
    ['compile_error', '> prepare: tsc\nsrc/index.ts(1,1): error TS2322: Type string is not assignable to type number.'],
    ['unknown', 'ELIFECYCLE Command failed with exit code 1.'],
  ])('classifies offline install failures as %s without inventing network evidence', (category, content) => {
    expect(classifyBuildFailure({ phase: 'install', installNetwork: 'none', exitCode: 1,
      logs: [{ seq: 1, content }] }).category).toBe(category);
  });
  it.each([
    'corepack: Error when performing the request to https://registry.npmjs.org/pnpm/latest\n[cause]: Error: getaddrinfo EAI_AGAIN registry.npmjs.org',
    'connect ECONNREFUSED registry.npmjs.org:443',
    'Failed to fetch https://registry.npmjs.org/pnpm',
    'Corepack failed to download pnpm',
  ])('requires network evidence and the none policy for offline install diagnosis: %s', content => {
    const input = { phase: 'install' as const, exitCode: 1, logs: [{ seq: 3, content }] };
    expect(classifyBuildFailure({ ...input, installNetwork: 'none' })).toMatchObject({
      category: 'install_network_disabled', matchedLogSeqs: [3],
    });
    expect(classifyBuildFailure({ ...input, installNetwork: 'outbound' }).category).toBe('dependency_registry_network');
  });
  it('uses structured network evidence for offline install failures', () => {
    expect(classifyBuildFailure({ phase: 'install', installNetwork: 'none', errorCodes: ['ECONNRESET'], logs: [] }).category)
      .toBe('install_network_disabled');
    expect(classifyBuildFailure({ phase: 'install', installNetwork: 'outbound',
      errorCodes: ['install_network_disabled'], logs: [] }).category).toBe('unknown');
  });
  it.each([238, 239, 240])('truncates on code point boundaries with an emoji at UTF-16 offset %s', offset => {
    const prefix = 'SyntaxError'.padEnd(offset, 'x');
    const result = classifyBuildFailure({ logs: [{ seq: 1, content: `${prefix}😀tail` }] });
    expect(result.excerpt).toEqual([offset === 238 ? `${prefix}😀` : prefix]);
    expect(BuildDiagnosisSchema.parse(result)).toEqual(result);
    expect(result.excerpt[0]!.isWellFormed()).toBe(true);
  });
  it('replaces lone input surrogates while preserving valid surrogate pairs', () => {
    const result = classifyBuildFailure({ logs: [{ seq: 1, content: 'SyntaxError \ud800text\udc00 😀 \ud800' }] });
    expect(result.excerpt).toEqual(['SyntaxError \ufffdtext\ufffd 😀 \ufffd']);
    expect(result.excerpt[0]!.isWellFormed()).toBe(true);
  });
  it('redacts whole lines before truncating to three 240-character excerpts', () => {
    const fakeSecret = 'PLACEHOLDER_ENV_VALUE_FOR_TESTS';
    const content = `error TS2322: ${'x'.repeat(210)} ${fakeSecret} token=PLACEHOLDER_TOKEN https://u:PLACEHOLDER_PASSWORD@registry.example`;
    const result = classifyBuildFailure({ secrets: [fakeSecret], logs: Array.from({ length: 6 }, (_, n) => ({ seq: n + 1, content })) });
    expect(result.matchedLogSeqs).toEqual([1, 2, 3]);
    expect(result.excerpt).toHaveLength(3);
    expect(result.excerpt.every(line => line.length <= 240)).toBe(true);
    expect(JSON.stringify(result)).not.toContain('PLACEHOLDER');
    expect(result.excerpt[0]).toContain('[REDACTED]');
    const credentials = classifyBuildFailure({ logs: [{ seq: 1, content: 'SyntaxError token=PLACEHOLDER_TOKEN password=PLACEHOLDER_PASSWORD' }] });
    expect(credentials.excerpt[0]).toBe('SyntaxError token=[REDACTED] password=[REDACTED]');
  });
  it('does not mutate input or expose raw exception codes in unknown evidence', () => {
    const logs = Object.freeze([Object.freeze({ seq: 9, content: 'all done' })]);
    expect(classifyBuildFailure({ errorCodes: ['PLACEHOLDER_PRIVATE_EXCEPTION'], logs })).toEqual({ category: 'unknown', matchedLogSeqs: [], excerpt: [] });
  });
  it.each([
    ['dependency_lockfile_mismatch', 'ERR_PNPM_OUTDATED_LOCKFILE'],
    ['dependency_missing_package', 'ERR_PNPM_FETCH_404'],
    ['dependency_registry_network', 'ENOTFOUND'],
    ['install_network_disabled', 'install_network_disabled'],
    ['compile_error', 'SyntaxError'],
    ['out_of_memory', 'OOMKilled'],
    ['timeout', 'build_timeout'],
    ['runner_unavailable', 'runner_not_configured'],
    ['artifact_missing', 'artifact_storage_unavailable'],
  ])('uses structured code %s without requiring raw exception text', (category, code) => {
    expect(classifyBuildFailure({ errorCodes: [code], phase: 'install',
      installNetwork: category === 'install_network_disabled' ? 'none' : undefined, logs: [] }))
      .toEqual({ category, matchedLogSeqs: [], excerpt: [] });
  });
});
