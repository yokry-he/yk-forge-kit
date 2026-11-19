import { z } from 'zod';
import { BuildLogEventSchema, BuildSchema } from './builds';

export const BuildLogChunkSchema = BuildLogEventSchema.omit({ buildId: true });
export type BuildLogChunk = z.infer<typeof BuildLogChunkSchema>;
export const BuildStreamTicketSchema = z.strictObject({
  ticket: z.string().regex(/^[A-Za-z0-9_-]{43}$/), expiresAt: z.iso.datetime(),
});
export type BuildStreamTicket = z.infer<typeof BuildStreamTicketSchema>;
export const BuildStreamStatusSchema = z.strictObject({ build: BuildSchema });
export type BuildStreamStatus = z.infer<typeof BuildStreamStatusSchema>;
export const BuildStreamEndSchema = z.strictObject({
  buildId: z.uuid(), status: z.enum(['succeeded', 'failed', 'canceled', 'timed_out']),
  lastSeq: z.number().int().min(0).max(4294967295),
});
export type BuildStreamEnd = z.infer<typeof BuildStreamEndSchema>;
export const BuildStreamErrorSchema = z.strictObject({
  code: z.enum(['ticket_expired', 'access_revoked', 'unavailable']), message: z.string().min(1).max(200),
});
export type BuildStreamError = z.infer<typeof BuildStreamErrorSchema>;
