import { z } from 'zod';
import { BuildIdSchema, BuildLogContentSchema, BuildLogStreamSchema } from './builds';

export const RUNTIME_LOG_LIMITS = { lines: 1000, defaultLines: 200, bytes: 1024 * 1024, lineBytes: 65536,
  durationMs: 60000, retentionMs: 10 * 60000, leaseMs: 5000, initialLeaseMs: 15000,
  project: 4, user: 2, host: 4, global: 100 } as const;
export const RuntimeLogSourceSchema = z.enum(['caddy-access', 'caddy-error']);
export const RuntimeLogInputSchema = z.strictObject({
  domainId: BuildIdSchema, source: RuntimeLogSourceSchema,
  lines: z.number().int().min(1).max(RUNTIME_LOG_LIMITS.lines).default(RUNTIME_LOG_LIMITS.defaultLines),
  level: z.enum(['all', 'debug', 'info', 'warn', 'error', 'fatal', 'panic']).default('all'),
  windowMinutes: z.union([z.literal(0), z.literal(5), z.literal(15), z.literal(60)]).default(0),
  keyword: z.string().max(200).refine(value => !/[\x00-\x1f\x7f]/.test(value)).default(''),
});
export type RuntimeLogInput = z.infer<typeof RuntimeLogInputSchema>;
export const RuntimeLogSessionSchema = z.strictObject({
  id: BuildIdSchema, projectId: BuildIdSchema, domainId: BuildIdSchema, deployTargetId: BuildIdSchema,
  source: RuntimeLogSourceSchema, status: z.enum(['pending', 'running', 'ended', 'canceled', 'failed']),
  errorCode: z.string().nullable(), createdAt: z.iso.datetime(), expiresAt: z.iso.datetime(),
});
export type RuntimeLogSession = z.infer<typeof RuntimeLogSessionSchema>;
export const RuntimeLogEventSchema = z.strictObject({ sessionId: BuildIdSchema, seq: z.number().int().min(1),
  stream: BuildLogStreamSchema, content: BuildLogContentSchema, ts: z.iso.datetime() });
export const RuntimeStreamStatusSchema = z.strictObject({ session: RuntimeLogSessionSchema });
export const RuntimeStreamEndSchema = z.strictObject({ sessionId: BuildIdSchema,
  status: RuntimeLogSessionSchema.shape.status.exclude(['pending', 'running']), lastSeq: z.number().int().min(0) });
export type RuntimeStreamEnd = z.infer<typeof RuntimeStreamEndSchema>;
export const RUNTIME_LOG_QUEUE_NAME = 'runtime-logs';
export const RUNTIME_LOG_JOB_NAME = 'runtime-log';
export const RuntimeLogJobSchema = z.strictObject({ sessionId: BuildIdSchema });
export type RuntimeLogJob = z.infer<typeof RuntimeLogJobSchema>;
