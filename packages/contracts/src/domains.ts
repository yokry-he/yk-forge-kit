import { z } from 'zod';
import { BuildIdSchema, BuildLogContentSchema, BuildLogStreamSchema } from './builds';

// ASCII DNS only; users may explicitly supply IDNA A-labels. Never accept URLs, IPs or wildcards.
export const DomainNameSchema = z.string().min(3).max(253).regex(/^[A-Za-z0-9.-]+$/)
  .transform(value => value.toLowerCase())
  .refine(value => value.includes('.') && !/^[0-9.]+$/.test(value) &&
    value.split('.').every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label)) &&
    /^[a-z]{2,63}$/.test(value.split('.').at(-1)!) &&
    !['localhost', 'local', 'internal', 'ts.net'].some(suffix => value === suffix || value.endsWith('.' + suffix)));
export const DomainStatusSchema = z.enum(['pending_dns', 'verifying', 'issuing', 'active', 'failed', 'expired', 'revoked']);
export const DomainTlsModeSchema = z.enum(['internal', 'staging', 'production']);
export type DomainTlsMode = z.infer<typeof DomainTlsModeSchema>;
export const DomainCreateSchema = z.strictObject({ deployTargetId: BuildIdSchema, hostname: DomainNameSchema });
export const DomainSchema = z.strictObject({
  id: BuildIdSchema, projectId: BuildIdSchema, deployTargetId: BuildIdSchema, hostname: DomainNameSchema,
  status: DomainStatusSchema, verificationName: z.string(), verificationValue: z.string(),
  tlsMode: DomainTlsModeSchema, certificateExpiresAt: z.iso.datetime().nullable(), certificateFingerprint: z.string().nullable(),
  verifiedAt: z.iso.datetime().nullable(), lastCheckedAt: z.iso.datetime().nullable(), errorCode: z.string().nullable(),
  createdAt: z.iso.datetime(), updatedAt: z.iso.datetime(),
});
export type Domain = z.infer<typeof DomainSchema>;
export const DomainOperationSchema = z.strictObject({ id: BuildIdSchema, projectId: BuildIdSchema, domainId: BuildIdSchema,
  deployTargetId: BuildIdSchema, action: z.enum(['verify', 'refresh', 'remove']), status: z.enum(['pending', 'running', 'succeeded', 'failed']),
  errorCode: z.string().nullable(), createdAt: z.iso.datetime(), updatedAt: z.iso.datetime(), finishedAt: z.iso.datetime().nullable(),
});
export type DomainOperation = z.infer<typeof DomainOperationSchema>;
export const DomainLogEventSchema = z.strictObject({ operationId: BuildIdSchema, seq: z.number().int().min(1),
  stream: BuildLogStreamSchema, content: BuildLogContentSchema, ts: z.iso.datetime() });
export type DomainLogEvent = z.infer<typeof DomainLogEventSchema>;
export const DOMAIN_QUEUE_NAME = 'domains';
export const DOMAIN_JOB_NAME = 'domain';
export const DomainJobPayloadSchema = z.strictObject({ operationId: BuildIdSchema });
export type DomainJobPayload = z.infer<typeof DomainJobPayloadSchema>;
export const DomainStreamStatusSchema = z.strictObject({ operation: DomainOperationSchema });
export const DomainStreamEndSchema = z.strictObject({ operationId: BuildIdSchema,
  status: DomainOperationSchema.shape.status.exclude(['pending', 'running']), lastSeq: z.number().int().min(0) });
export type DomainStreamEnd = z.infer<typeof DomainStreamEndSchema>;
