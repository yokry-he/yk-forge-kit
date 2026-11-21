import { z } from 'zod';
import { BuildLogContentSchema, BuildLogStreamSchema } from './builds';
const id = z.uuid(), time = z.iso.datetime();
export const AndroidSettingsSchema = z.strictObject({
  packageName: z.string().min(3).max(200).regex(/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/),
  appId: z.string().regex(/^__UNI__[A-Z0-9]{5,32}$/),
  // DCloud AppKey is embedded in AndroidManifest.xml; it is runtime metadata, not a signing secret.
  appKey: z.string().min(8).max(512).regex(/^[A-Za-z0-9+/_=.:-]+$/),
  versionName: z.string().min(1).max(64).regex(/^[A-Za-z0-9._-]+$/),
  versionCode: z.number().int().min(1).max(2100000000),
});
export type AndroidSettings = z.infer<typeof AndroidSettingsSchema>;
export const AndroidSigningSchema = z.strictObject({
  keystore: z.string().min(8).max(87384).regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/),
  alias: z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/),
  storePassword: z.string().min(6).max(256).regex(/^[^\x00-\x1f\x7f]+$/),
  keyPassword: z.string().min(6).max(256).regex(/^[^\x00-\x1f\x7f]+$/),
});
export type AndroidSigning = z.infer<typeof AndroidSigningSchema>;
export const AndroidConfigInputSchema = AndroidSettingsSchema.extend({ signing: AndroidSigningSchema.optional() });
export type AndroidConfigInput = z.infer<typeof AndroidConfigInputSchema>;
export const AndroidConfigSchema = z.strictObject({ projectId: id, settings: AndroidSettingsSchema,
  hasSigning: z.boolean(), updatedAt: time, updatedBy: id });
export type AndroidConfig = z.infer<typeof AndroidConfigSchema>;
export const AndroidJobInputSchema = z.strictObject({ buildType: z.enum(['debug', 'release']), kind: z.enum(['apk', 'aab']) });
export type AndroidJobInput = z.infer<typeof AndroidJobInputSchema>;
export const AndroidArtifactSchema = z.strictObject({ kind: z.enum(['apk', 'aab']), sha256: z.string().regex(/^[a-f0-9]{64}$/), size: z.number().int().positive().max(268435456) });
export type AndroidArtifact = z.infer<typeof AndroidArtifactSchema>;
export const AndroidJobSchema = z.strictObject({ id, projectId: id, settings: AndroidSettingsSchema, input: AndroidJobInputSchema,
  status: z.enum(['queued', 'running', 'succeeded', 'failed']), triggeredBy: id,
  createdAt: time, updatedAt: time, startedAt: time.nullable(), finishedAt: time.nullable(),
  errorCode: z.string().nullable(), artifact: AndroidArtifactSchema.nullable() });
export type AndroidJob = z.infer<typeof AndroidJobSchema>;
export const AndroidLogEventSchema = z.strictObject({ jobId: id, seq: z.number().int().min(1).max(4294967295),
  stream: BuildLogStreamSchema, content: BuildLogContentSchema, ts: time });
export type AndroidLogEvent = z.infer<typeof AndroidLogEventSchema>;
export const ANDROID_QUEUE_NAME = 'android';
export const ANDROID_JOB_NAME = 'android';
export const AndroidJobPayloadSchema = z.strictObject({ jobId: id });
export type AndroidJobPayload = z.infer<typeof AndroidJobPayloadSchema>;
export const AndroidStreamStatusSchema = z.strictObject({ job: AndroidJobSchema });
export const AndroidStreamEndSchema = z.strictObject({ jobId: id, status: z.enum(['succeeded', 'failed']), lastSeq: z.number().int().min(0).max(4294967295) });
export type AndroidStreamEnd = z.infer<typeof AndroidStreamEndSchema>;
