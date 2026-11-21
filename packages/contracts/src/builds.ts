import { z } from 'zod';

export const buildStatuses = ['queued', 'running', 'succeeded', 'failed', 'canceled', 'timed_out'] as const;
export const BuildStatusSchema = z.enum(buildStatuses);
export type BuildStatus = z.infer<typeof BuildStatusSchema>;

const transitions: Readonly<Record<BuildStatus, readonly BuildStatus[]>> = {
  queued: ['running', 'failed', 'canceled'],
  running: ['succeeded', 'failed', 'canceled', 'timed_out'],
  succeeded: [], failed: [], canceled: [], timed_out: [],
};

/** Retries create a new build; terminal records cannot be reopened. Same-state writes are rejected. */
export function canTransition(from: BuildStatus, to: BuildStatus): boolean {
  return transitions[from].includes(to);
}

const id = z.uuid();
const time = z.iso.datetime();
const key = z.string().min(1).max(1024);
export const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
export const RunnerInfoSchema = z.strictObject({
  runnerId: z.string().min(1).max(150),
  image: z.string().min(1).max(255),
  containerId: z.string().min(1).max(150).optional(),
});
export type RunnerInfo = z.infer<typeof RunnerInfoSchema>;

export const BuildSchema = z.strictObject({
  id, projectId: id, number: z.number().int().min(1).max(4294967295),
  template: z.string().min(1).max(32), sourceRef: key,
  target: z.enum(['h5', 'mp-weixin', 'mp-alipay']).optional(),
  status: BuildStatusSchema, triggeredBy: id,
  queuedAt: time, startedAt: time.nullable(), finishedAt: time.nullable(),
  createdAt: time, updatedAt: time,
  exitCode: z.number().int().min(-2147483648).max(2147483647).nullable(),
  errorMessage: z.string().max(65535)
    .refine((value) => new TextEncoder().encode(value).length <= 65535, '错误信息不能超过 65535 字节。').nullable(),
  artifactKey: key.nullable(), artifactSize: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).nullable(),
  artifactSha256: Sha256Schema.nullable(), logStorageKey: key.nullable(),
  runnerInfo: RunnerInfoSchema.nullable(),
});
export type Build = z.infer<typeof BuildSchema>;

export const BuildLogStreamSchema = z.enum(['stdout', 'stderr', 'system']);
export const BuildLogContentSchema = z.string().min(1).max(16384)
  .refine((value) => new TextEncoder().encode(value).length <= 16384, '日志分块不能超过 16 KiB。');
export const BuildLogEventSchema = z.strictObject({
  buildId: id, seq: z.number().int().min(1).max(4294967295),
  stream: BuildLogStreamSchema, content: BuildLogContentSchema, ts: time,
});
export type BuildLogEvent = z.infer<typeof BuildLogEventSchema>;

export const PREVIEW_TTL_MIN_SECONDS = 5 * 60;
export const PREVIEW_TTL_MAX_SECONDS = 7 * 24 * 60 * 60;
export const PREVIEW_TTL_DEFAULT_SECONDS = 24 * 60 * 60;
export const PreviewLinkCreateRequestSchema = z.strictObject({
  ttlSeconds: z.number().int().min(PREVIEW_TTL_MIN_SECONDS).max(PREVIEW_TTL_MAX_SECONDS)
    .default(PREVIEW_TTL_DEFAULT_SECONDS),
});
export type PreviewLinkCreateRequest = z.infer<typeof PreviewLinkCreateRequestSchema>;

/** Public metadata deliberately excludes the persisted digest and plaintext bearer token. */
export const PreviewLinkSchema = z.strictObject({
  id, buildId: id, createdBy: id, createdAt: time, expiresAt: time,
  revokedAt: time.nullable(), lastAccessedAt: time.nullable(),
});
export type PreviewLink = z.infer<typeof PreviewLinkSchema>;
export const PreviewLinkCreateResponseSchema = z.strictObject({
  previewLink: PreviewLinkSchema,
  // B11 generates 32 cryptographically random bytes, encoded as unpadded base64url.
  token: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  url: z.url(),
});
export type PreviewLinkCreateResponse = z.infer<typeof PreviewLinkCreateResponseSchema>;

export const EnvironmentSchema = z.strictObject({
  id, projectId: id, name: z.string().min(1).max(64), createdAt: time, updatedAt: time,
});
export type Environment = z.infer<typeof EnvironmentSchema>;
export const DeployTargetSchema = z.strictObject({
  id, projectId: id, kind: z.literal('ssh'), name: z.string().min(1).max(150),
  host: z.string().min(1).max(255).nullable(), port: z.number().int().min(1).max(65535).nullable(),
  username: z.string().min(1).max(150).nullable(), createdBy: id, createdAt: time, updatedAt: time,
  hostKey: z.string().nullable().default(null), basePath: z.string().nullable().default(null), retention: z.number().int().min(1).max(50).default(5),
  currentReleaseId: id.nullable().default(null), disabledAt: time.nullable().default(null),
});
export type DeployTarget = z.infer<typeof DeployTargetSchema>;
export const DeploymentStatusSchema = z.enum(['pending', 'running', 'succeeded', 'failed', 'canceled', 'rolled_back']);
export type DeploymentStatus = z.infer<typeof DeploymentStatusSchema>;
export const DeploymentSchema = z.strictObject({
  id, projectId: id, buildId: id, environmentId: id, deployTargetId: id,
  status: DeploymentStatusSchema, createdAt: time, updatedAt: time,
  startedAt: time.nullable(), finishedAt: time.nullable(),
  action: z.enum(['deploy', 'rollback']).default('deploy'), releaseId: id.nullable().default(null),
  rollbackOf: id.nullable().default(null), triggeredBy: id.nullable().default(null),
  retained: z.boolean().default(false), errorMessage: z.string().nullable().default(null),
});
export type Deployment = z.infer<typeof DeploymentSchema>;

/** B08 queue messages carry identifiers only; MySQL is authoritative. */
export const BUILD_QUEUE_NAME = 'builds';
export const BUILD_JOB_NAME = 'build';
export const BuildJobPayloadSchema = z.strictObject({ buildId: id });
export type BuildJobPayload = z.infer<typeof BuildJobPayloadSchema>;
export const BuildCreateRequestSchema = z.strictObject({ sourceRef: key, target: z.enum(['h5', 'mp-weixin', 'mp-alipay']).optional(), environmentName: z.string().min(1).max(64).regex(/^[a-z][a-z0-9_-]*$/).optional() });
export const BuildListQuerySchema = z.strictObject({
  beforeNumber: z.coerce.number().int().min(1).max(4294967295).optional(),
  limit: z.coerce.number().int().min(1).max(1000).default(50),
});
export const BuildLogsQuerySchema = z.strictObject({
  seq: z.coerce.number().int().min(0).max(4294967295).default(0),
  limit: z.coerce.number().int().min(1).max(1000).default(500),
});
export const BuildIdSchema = id;
