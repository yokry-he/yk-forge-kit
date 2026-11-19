import { describe, expect, it } from 'vitest';
import {
  buildStatuses, canTransition, BuildStatusSchema, BuildSchema, BuildLogEventSchema,
  PreviewLinkCreateRequestSchema, PreviewLinkCreateResponseSchema, PreviewLinkSchema,
  EnvironmentSchema, DeployTargetSchema, DeploymentSchema,
} from '../src/index';

const id = 'c38c50ac-d63f-4e30-a77a-555e214d0ef0';
const time = '2026-11-19T12:00:00.000Z';
const build = {
  id, projectId: id, number: 1, template: 'vue-web', sourceRef: 'source/snapshot-1.tar', status: 'queued',
  triggeredBy: id, queuedAt: time, startedAt: null, finishedAt: null, createdAt: time, updatedAt: time,
  exitCode: null, errorMessage: null, artifactKey: null, artifactSize: null, artifactSha256: null,
  logStorageKey: null, runnerInfo: null,
};
const preview = { id, buildId: id, createdBy: id, createdAt: time, expiresAt: time, revokedAt: null, lastAccessedAt: null };

describe('build state transitions', () => {
  const allowed = new Set(['queued:running', 'queued:failed', 'queued:canceled',
    'running:succeeded', 'running:failed', 'running:canceled', 'running:timed_out']);
  for (const from of buildStatuses) {
    for (const to of buildStatuses) {
      it(`${from} → ${to}`, () => expect(canTransition(from, to)).toBe(allowed.has(`${from}:${to}`)));
    }
  }
  it('rejects unknown statuses', () => expect(BuildStatusSchema.safeParse('timeout').success).toBe(false));
});

it('validates build snapshots and complete runner/artifact metadata', () => {
  expect(BuildSchema.parse(build)).toEqual(build);
  expect(BuildSchema.parse({ ...build, status: 'succeeded', exitCode: 0, startedAt: time, finishedAt: time,
    artifactKey: 'artifacts/build.tar', artifactSize: 123, artifactSha256: 'a'.repeat(64),
    runnerInfo: { runnerId: 'worker-1', image: 'runner@sha256:abc', containerId: 'container-1' },
  }).artifactSize).toBe(123);
});
it.each([
  { number: 0 }, { number: 1.2 }, { number: 4294967296 }, { sourceRef: '' }, { template: 'x'.repeat(33) },
  { errorMessage: '中'.repeat(21846) },
  { artifactSize: -1 }, { artifactSize: Number.MAX_SAFE_INTEGER + 1 }, { artifactSha256: 'ABC' },
  { queuedAt: 'yesterday' }, { queuedAt: '2026-02-30T12:00:00Z' }, { triggeredBy: 'unknown' },
  { runnerInfo: { runnerId: 'worker-1' } }, { token: 'secret' },
])('rejects malformed build fields %j', (patch) => expect(BuildSchema.safeParse({ ...build, ...patch }).success).toBe(false));

it('validates log streams, ordering cursor and UTF-8 chunk bounds', () => {
  const event = { buildId: id, seq: 1, stream: 'stdout', content: '开始构建\n', ts: time };
  expect(BuildLogEventSchema.parse(event)).toEqual(event);
  for (const patch of [{ seq: 0 }, { seq: 1.5 }, { stream: 'stdin' }, { content: '' },
    { content: 'x'.repeat(16385) }, { content: '中'.repeat(5462) }, { ts: 'invalid' }]) {
    expect(BuildLogEventSchema.safeParse({ ...event, ...patch }).success).toBe(false);
  }
  expect(BuildLogEventSchema.parse({ ...event, content: 'x'.repeat(16384) }).content.length).toBe(16384);
});
it('defaults preview TTL to 24h and accepts only integer TTLs between 5m and 7d', () => {
  expect(PreviewLinkCreateRequestSchema.parse({})).toEqual({ ttlSeconds: 86400 });
  for (const ttlSeconds of [300, 604800]) expect(PreviewLinkCreateRequestSchema.parse({ ttlSeconds }).ttlSeconds).toBe(ttlSeconds);
  for (const ttlSeconds of [299, 604801, -1, 300.5, '300', null]) {
    expect(PreviewLinkCreateRequestSchema.safeParse({ ttlSeconds }).success).toBe(false);
  }
});
it('exposes plaintext only in the one-time create response and never exposes the digest', () => {
  expect(PreviewLinkSchema.parse(preview)).toEqual(preview);
  expect(PreviewLinkCreateResponseSchema.parse({ previewLink: preview, token: 'a'.repeat(43) }).token).toHaveLength(43);
  expect(PreviewLinkSchema.safeParse({ ...preview, tokenHash: 'a'.repeat(64) }).success).toBe(false);
  expect(PreviewLinkSchema.safeParse({ ...preview, token: 'a'.repeat(43) }).success).toBe(false);
  expect(PreviewLinkCreateResponseSchema.safeParse({ previewLink: preview, token: 'short' }).success).toBe(false);
});
it('validates the minimal environment, SSH target and deployment contracts', () => {
  const timestamps = { createdAt: time, updatedAt: time };
  expect(EnvironmentSchema.parse({ id, projectId: id, name: 'preview', ...timestamps }).name).toBe('preview');
  const target = { id, projectId: id, kind: 'ssh', name: 'web', host: null, port: null, username: null, createdBy: id, ...timestamps };
  expect(DeployTargetSchema.parse(target).host).toBeNull();
  for (const patch of [{ port: 0 }, { port: 65536 }, { kind: 'aliyun' }, { privateKey: 'secret' }]) {
    expect(DeployTargetSchema.safeParse({ ...target, ...patch }).success).toBe(false);
  }
  const deployment = { id, projectId: id, buildId: id, environmentId: id, deployTargetId: id,
    status: 'pending', startedAt: null, finishedAt: null, ...timestamps };
  expect(DeploymentSchema.parse(deployment).status).toBe('pending');
  expect(DeploymentSchema.safeParse({ ...deployment, status: 'unknown' }).success).toBe(false);
});

it('shares a strict identifier-only build queue contract and bounded API cursors', async () => {
  const { BUILD_QUEUE_NAME, BUILD_JOB_NAME, BuildJobPayloadSchema, BuildCreateRequestSchema,
    BuildListQuerySchema, BuildLogsQuerySchema } = await import('../src/index');
  expect(BUILD_QUEUE_NAME).toBe('builds'); expect(BUILD_JOB_NAME).toBe('build');
  expect(BuildJobPayloadSchema.parse({ buildId: id })).toEqual({ buildId: id });
  for (const payload of [{ buildId: 'wrong' }, { buildId: id, command: 'sh' }, {}]) {
    expect(BuildJobPayloadSchema.safeParse(payload).success).toBe(false);
  }
  expect(BuildCreateRequestSchema.safeParse({ sourceRef: 'snapshot', triggeredBy: id }).success).toBe(false);
  expect(BuildListQuerySchema.parse({ limit: '2' })).toEqual({ limit: 2 });
  expect(BuildLogsQuerySchema.parse({})).toEqual({ seq: 0, limit: 500 });
  expect(BuildLogsQuerySchema.safeParse({ seq: '-1' }).success).toBe(false);
});
