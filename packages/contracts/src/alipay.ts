import { z } from 'zod';
import { BuildLogContentSchema, BuildLogStreamSchema } from './builds';
const id = z.uuid(), time = z.iso.datetime();
export const AlipayConfigInputSchema = z.strictObject({
  appId: z.string().regex(/^[0-9]{16}$/),
  privateKey: z.string().min(64).max(16384).optional(),
  toolId: z.string().min(1).max(128).regex(/^[a-zA-Z0-9_-]+$/),
});
export type AlipayConfigInput = z.infer<typeof AlipayConfigInputSchema>;
export const AlipayConfigSchema = z.strictObject({ projectId: id, appId: z.string(), hasPrivateKey: z.boolean(),
  toolId: z.string(), updatedAt: time, updatedBy: id });
export type AlipayConfig = z.infer<typeof AlipayConfigSchema>;
/** minidev 2.2.5 supports experience promotion on upload with the corresponding account permission. */
export const AlipayJobInputSchema = z.strictObject({ buildId: id,
  action: z.enum(['upload', 'preview', 'upload_preview']), target: z.enum(['dev', 'experience']).default('dev'),
  version: z.string().max(32).regex(/^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/)
    .refine(value => value.split('.').every(part => Number(part) <= 2147483647), '版本号每段不能超过 2147483647。'),
  description: z.string().max(199).default(''),
}).refine(input => input.action !== 'preview' || input.target === 'dev', '仅预览不设置体验版本。');
export type AlipayJobInput = z.infer<typeof AlipayJobInputSchema>;
export const AlipayJobSchema = z.strictObject({ id, projectId: id, buildId: id, appId: z.string(), toolId: z.string(),
  input: AlipayJobInputSchema, status: z.enum(['queued', 'running', 'succeeded', 'failed']),
  triggeredBy: id, createdAt: time, startedAt: time.nullable(), finishedAt: time.nullable(), updatedAt: time,
  errorCode: z.string().nullable(), hasQrCode: z.boolean(),
});
export type AlipayJob = z.infer<typeof AlipayJobSchema>;
export const AlipayLogEventSchema = z.strictObject({ jobId: id, seq: z.number().int().min(1).max(4294967295),
  stream: BuildLogStreamSchema, content: BuildLogContentSchema, ts: time });
export type AlipayLogEvent = z.infer<typeof AlipayLogEventSchema>;
export const ALIPAY_QUEUE_NAME = 'alipay';
export const ALIPAY_JOB_NAME = 'alipay';
export const AlipayJobPayloadSchema = z.strictObject({ jobId: id });
export type AlipayJobPayload = z.infer<typeof AlipayJobPayloadSchema>;
export const AlipayStreamStatusSchema = z.strictObject({ job: AlipayJobSchema });
export const AlipayStreamEndSchema = z.strictObject({ jobId: id, status: z.enum(['succeeded', 'failed']), lastSeq: z.number().int().min(0).max(4294967295) });
export type AlipayStreamEnd = z.infer<typeof AlipayStreamEndSchema>;

/** Only raster QR images cross the private artifact boundary; never HTML or SVG. */
export function qrImageType(data: Uint8Array): 'image/png' | 'image/jpeg' {
  if (data.length > 1048576) throw new Error('alipay_qr_size');
  if (data.length >= 20 && [137, 80, 78, 71, 13, 10, 26, 10].every((byte, index) => data[index] === byte)) return 'image/png';
  if (data.length >= 4 && data[0] === 255 && data[1] === 216 && data[data.length - 2] === 255 && data[data.length - 1] === 217) return 'image/jpeg';
  throw new Error('alipay_qr_invalid');
}
