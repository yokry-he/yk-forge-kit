import { describe, expect, it } from 'vitest';
import { BuildLogChunkSchema, BuildStreamEndSchema, BuildStreamErrorSchema, BuildStreamStatusSchema, BuildStreamTicketSchema } from '../src';
const chunk = { seq: 1, stream: 'stdout', content: '日志\n', ts: '2026-11-19T00:00:00.000Z' };
describe('build stream contracts', () => {
  it('strictly omits buildId and caps UTF-8 bytes', () => {
    expect(BuildLogChunkSchema.parse(chunk)).toEqual(chunk);
    expect(BuildLogChunkSchema.safeParse({ ...chunk, buildId: '123' }).success).toBe(false);
    expect(BuildLogChunkSchema.safeParse({ ...chunk, content: '界'.repeat(5462) }).success).toBe(false);
    expect(BuildLogChunkSchema.safeParse({ ...chunk, content: 'a'.repeat(16384) }).success).toBe(true);
    for (const seq of [0, -1, 1.5, 4294967296]) expect(BuildLogChunkSchema.safeParse({ ...chunk, seq }).success).toBe(false);
    expect(BuildLogChunkSchema.safeParse({ ...chunk, seq: 4294967295 }).success).toBe(true);
  });
  it('requires a 256-bit base64url ticket, timestamp and no extra fields', () => {
    const ticket = { ticket: 'a'.repeat(43), expiresAt: chunk.ts };
    expect(BuildStreamTicketSchema.parse(ticket)).toEqual(ticket);
    for (const bad of [{ ...ticket, ticket: 'short' }, { ...ticket, ticket: '+'.repeat(43) }, { ...ticket, secret: true }]) expect(BuildStreamTicketSchema.safeParse(bad).success).toBe(false);
  });
  it('end only permits terminal states and nonnegative uint32 cursors', () => {
    const end = { buildId: '11111111-1111-4111-8111-111111111111', status: 'failed', lastSeq: 0 };
    expect(BuildStreamEndSchema.parse(end)).toEqual(end);
    for (const status of ['queued', 'running']) expect(BuildStreamEndSchema.safeParse({ ...end, status }).success).toBe(false);
    for (const lastSeq of [-1, 1.1, 4294967296]) expect(BuildStreamEndSchema.safeParse({ ...end, lastSeq }).success).toBe(false);
    expect(BuildStreamEndSchema.safeParse({ ...end, extra: true }).success).toBe(false);
  });
  it('status and errors validate their strict envelope', () => {
    expect(BuildStreamStatusSchema.safeParse({ build: {} }).success).toBe(false);
    expect(BuildStreamErrorSchema.safeParse({ code: 'access_revoked', message: '无权限' }).success).toBe(true);
    expect(BuildStreamErrorSchema.safeParse({ code: 'other', message: '' }).success).toBe(false);
  });
});
