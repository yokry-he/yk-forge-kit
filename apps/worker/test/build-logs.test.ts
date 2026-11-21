import { describe, expect, it } from 'vitest';
import { CappedBuildLogs, redactBuildLog } from '../src/build-logs';

async function* chunks(...values: string[]) { for (const value of values) yield Buffer.from(value); }
describe('build log boundary', () => {
  it.each(['clearly-fake-test-secret', 'clearly-fake-quoted-"secret}tail'])('preserves JSON string boundaries while redacting credentials: %s', secret => {
    const escapedSecret = 'fake-quoted-"secret';
    const line = JSON.stringify({ request: { uri: '/?token=' + secret }, msg: 'Authorization: Bearer ' + secret,
      registry: 'https://user:password@registry.test/a', explicit: escapedSecret });
    const result = redactBuildLog(line, [escapedSecret]);
    expect(JSON.parse(result)).toEqual({ request: { uri: '/?token=[REDACTED]' }, msg: 'Authorization: Bearer [REDACTED]',
      registry: 'https://[REDACTED]@registry.test/a', explicit: '[REDACTED]' });
    expect(result).not.toContain(secret);
    expect(result).not.toContain('user:password');
    expect(result).not.toContain('fake-quoted-');
  });
  it('redacts explicit secrets, authorization and URL credentials across input chunks', async () => {
    const written: string[] = [];
    const logs = new CappedBuildLogs({ write: async (_stream, value) => { written.push(value); } }, 1000,
      (line) => redactBuildLog(line, ['private-value']));
    await logs.consume('stdout', chunks('private-', 'value https://user:password@registry.test/a\nAuthorization: Bear', 'er tok123\ntoken=abc\n'));
    const result = written.join('');
    for (const secret of ['private-value', 'user:password', 'tok123', 'abc']) expect(result).not.toContain(secret);
    expect(result).toContain('[REDACTED]');
  });
  it('shares a byte cap across streams and emits no unredacted overflow', async () => {
    const written: string[] = [];
    const logs = new CappedBuildLogs({ write: async (_s, v) => { written.push(v); } }, 6);
    await logs.consume('stdout', chunks('你好'));
    await expect(logs.consume('stderr', chunks('x\n'))).rejects.toThrow('build_log_limit');
    expect(written).toEqual(['你好']);
  });
  it('bounds newline-free output and never splits secrets at line buffer boundaries', async () => {
    const logs = new CappedBuildLogs({ write: async () => { throw new Error('must not write'); } }, 100000);
    await expect(logs.consume('stdout', chunks('x'.repeat(65537)))).rejects.toThrow('build_log_line_limit');
  });
  it('preserves UTF-8 and chunks long lines to repository limits after redaction', async () => {
    const written: string[] = [];
    const logs = new CappedBuildLogs({ write: async (_s, v) => { written.push(v); } }, 100000);
    const value = '好'.repeat(6000) + '\n'; const bytes = Buffer.from(value);
    async function* input() { yield bytes.subarray(0, 1); yield bytes.subarray(1); }
    await logs.consume('stderr', input());
    expect(written.join('')).toBe(value); expect(written.every((v) => Buffer.byteLength(v) <= 16384)).toBe(true);
  });
});
