import { describe, expect, it } from 'vitest';
import { RuntimeLogInputSchema, RuntimeLogSessionSchema, RUNTIME_LOG_LIMITS } from '../src/runtime-logs';
const domainId = '11111111-1111-4111-8111-111111111111';
describe('runtime log public contract', () => {
  it('defaults to a small recent tail and rejects arbitrary sources/paths/units/argv', () => {
    expect(RuntimeLogInputSchema.parse({ domainId, source: 'caddy-access' })).toMatchObject({ lines: 200, keyword: '', level: 'all', windowMinutes: 0 });
    for (const source of ['../../etc/passwd', 'caddy-access;id', '$(id)', '/var/log/caddy', 'journald', 'docker']) {
      expect(RuntimeLogInputSchema.safeParse({ domainId, source }).success).toBe(false);
    }
    for (const field of ['path', 'command', 'unit', 'host', 'argv', 'deployTargetId']) {
      expect(RuntimeLogInputSchema.safeParse({ domainId, source: 'caddy-error', [field]: 'bad' }).success).toBe(false);
    }
  });
  it('bounds every user-controlled filter and allows literal shell-looking keywords as local data', () => {
    for (const lines of [0, -1, 1.1, 1001, '200', Infinity]) expect(RuntimeLogInputSchema.safeParse({ domainId, source: 'caddy-access', lines }).success).toBe(false);
    for (const keyword of ['x'.repeat(201), 'a\0b', 'x\ny']) expect(RuntimeLogInputSchema.safeParse({ domainId, source: 'caddy-error', keyword }).success).toBe(false);
    expect(RuntimeLogInputSchema.parse({ domainId, source: 'caddy-error', keyword: '$(id); [x].* --file' }).keyword).toBe('$(id); [x].* --file');
    expect(RuntimeLogInputSchema.safeParse({ domainId, source: 'caddy-error', windowMinutes: 999 }).success).toBe(false);
    expect(RUNTIME_LOG_LIMITS.durationMs).toBe(60000);
    expect(RuntimeLogSessionSchema.shape.status.safeParse('unknown').success).toBe(false);
  });
});
