import { z } from 'zod';
import { BuildLogContentSchema, BuildLogStreamSchema } from './builds';
const id = z.uuid(), time = z.iso.datetime();
export const WeappConfigInputSchema = z.strictObject({
  appId: z.string().regex(/^wx[a-fA-F0-9]{16}$/),
  privateKey: z.string().min(64).max(16384).optional(),
  ipWhitelistNote: z.string().max(1000).default(''),
});
export type WeappConfigInput = z.infer<typeof WeappConfigInputSchema>;
export const WeappConfigSchema = z.strictObject({ projectId: id, appId: z.string(), hasPrivateKey: z.boolean(),
  ipWhitelistNote: z.string(), updatedAt: time, updatedBy: id });
export type WeappConfig = z.infer<typeof WeappConfigSchema>;
/** Official CI uploads development versions. Experience promotion is a manual MP action. */
export const WeappJobInputSchema = z.strictObject({ buildId: id,
  action: z.enum(['upload', 'preview', 'upload_preview']), target: z.literal('dev').default('dev'),
  version: z.string().min(1).max(64).regex(/^[a-zA-Z0-9._-]+$/),
  description: z.string().max(500).default(''), robot: z.number().int().min(1).max(30).default(1),
});
export type WeappJobInput = z.infer<typeof WeappJobInputSchema>;
export const WeappJobSchema = z.strictObject({ id, projectId: id, buildId: id, appId: z.string(),
  input: WeappJobInputSchema, status: z.enum(['queued', 'running', 'succeeded', 'failed']),
  triggeredBy: id, createdAt: time, startedAt: time.nullable(), finishedAt: time.nullable(), updatedAt: time,
  errorCode: z.string().nullable(), hasQrCode: z.boolean(),
});
export type WeappJob = z.infer<typeof WeappJobSchema>;
export const WeappLogEventSchema = z.strictObject({ jobId: id, seq: z.number().int().min(1).max(4294967295),
  stream: BuildLogStreamSchema, content: BuildLogContentSchema, ts: time });
export type WeappLogEvent = z.infer<typeof WeappLogEventSchema>;
export const WEAPP_QUEUE_NAME = 'weapp';
export const WEAPP_JOB_NAME = 'weapp';
export const WeappJobPayloadSchema = z.strictObject({ jobId: id });
export type WeappJobPayload = z.infer<typeof WeappJobPayloadSchema>;
export const WeappStreamStatusSchema = z.strictObject({ job: WeappJobSchema });
export const WeappStreamEndSchema = z.strictObject({ jobId: id, status: z.enum(['succeeded', 'failed']), lastSeq: z.number().int().min(0).max(4294967295) });
export type WeappStreamEnd = z.infer<typeof WeappStreamEndSchema>;
