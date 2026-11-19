import { randomUUID } from 'node:crypto';
import type { BuildRecord } from '../src/runner';
import type { DockerRunnerOptions } from '../src/docker-runner';

export function buildRecord(template = 'vue-web'): BuildRecord {
  const now = new Date();
  return { id: randomUUID(), projectId: randomUUID(), number: 1, template, sourceRef: `template:${template}`,
    triggeredBy: randomUUID(), status: 'running', queuedAt: now, startedAt: now, finishedAt: null, createdAt: now, updatedAt: now,
    exitCode: null, errorMessage: null, artifactKey: null, artifactSize: null, artifactSha256: null, logStorageKey: null, runnerInfo: null };
}
export const dockerOptions: DockerRunnerOptions = { image: 'node:22', installNetwork: 'outbound', timeoutMs: 60000,
  maxLogBytes: 1048576, memoryMb: 2048, cpus: 2, pidsLimit: 256 };
