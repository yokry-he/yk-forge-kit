import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { lookup } from 'node:dns/promises';
import { request } from 'node:https';
import type { ClientRequest, IncomingMessage, RequestOptions } from 'node:http';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OpenAiCompatibleBeginnerClient } from '../src/beginner-ai';
import { resolveBeginnerAiTarget } from '../src/beginner-ai-target';
vi.mock('node:dns/promises', () => ({ lookup: vi.fn() }));
vi.mock('node:https', () => ({ request: vi.fn() }));
vi.mock('node:http', () => ({ request: vi.fn() }));
const secret = 'sk-private-b21-key';
const input = { description: '公司官网', apiKey: secret, baseUrl: 'https://api.example.test/v1/', model: 'custom-model', signal: new AbortController().signal };
const publicAddress = { address: '93.184.216.34', family: 4 };
let sentBody = '';
function respond(body: string, statusCode = 200) {
  vi.mocked(request).mockImplementation(((_url: URL, _options: RequestOptions, callback: (response: IncomingMessage) => void) => {
    const req = new EventEmitter();
    return Object.assign(req, { end: (data: string) => {
      sentBody = data;
      const response = Object.assign(Readable.from([Buffer.from(body)]), { statusCode });
      callback(response as IncomingMessage);
    } }) as ClientRequest;
  }) as typeof request);
}
beforeEach(() => {
  vi.clearAllMocks(); sentBody = '';
  vi.mocked(lookup).mockResolvedValue([publicAddress]);
  respond(JSON.stringify({ choices: [{ message: { content: '{"templateId":"nuxt-site"}' } }] }));
});
afterEach(() => vi.restoreAllMocks());
describe('OpenAI-compatible B21 adapter', () => {
  it('pins the validated DNS snapshot while retaining the URL hostname for Host/TLS and separating untrusted input', async () => {
    expect(await new OpenAiCompatibleBeginnerClient().suggest(input)).toBe('{"templateId":"nuxt-site"}');
    const [url, options] = vi.mocked(request).mock.calls[0]! as unknown as [URL, RequestOptions];
    expect(url.toString()).toBe('https://api.example.test/v1/chat/completions');
    expect(options.agent).toBe(false); expect(options.signal).toBe(input.signal);
    expect(options.headers).toMatchObject({ Authorization: 'Bearer ' + secret });
    expect(sentBody).not.toContain(secret);
    const body = JSON.parse(sentBody);
    expect(body.model).toBe('custom-model');
    expect(body.messages[0].role).toBe('system'); expect(body.messages[0].content).not.toContain(input.description);
    expect(body.messages[1]).toEqual({ role: 'user', content: JSON.stringify({ untrustedNeed: input.description }) });
    // DNS changes after validation cannot change either socket lookup mode.
    vi.mocked(lookup).mockResolvedValue([{ address: '127.0.0.1', family: 4 }]);
    const callback = vi.fn();
    options.lookup!('api.example.test', {}, callback);
    expect(callback).toHaveBeenLastCalledWith(null, publicAddress.address, 4);
    options.lookup!('api.example.test', { all: true }, callback);
    expect(callback).toHaveBeenLastCalledWith(null, [publicAddress]);
    expect(lookup).toHaveBeenCalledTimes(1);
    // Each later request must resolve and validate again, even for the same host.
    await expect(new OpenAiCompatibleBeginnerClient().suggest(input)).rejects.toThrow(/^beginner_ai_unavailable$/);
    expect(request).toHaveBeenCalledTimes(1);
  });
  it.each([
    'http://127.0.0.1', 'http://2130706433', 'http://0x7f000001', 'http://0177.0.0.1', 'http://0.0.0.0',
    'http://10.0.0.1', 'http://172.16.0.1', 'http://192.168.1.1', 'http://169.254.169.254', 'http://100.64.0.1',
    'http://224.0.0.1', 'http://255.255.255.255', 'http://168.63.129.16', 'http://[::]', 'http://[::1]', 'http://[fe80::1]',
    'http://[fd00:ec2::254]', 'http://[fc00::1]', 'http://[ff02::1]', 'http://[::ffff:127.0.0.1]',
    'http://[::ffff:192.168.1.1]', 'http://[::ffff:169.254.169.254]', 'http://[::ffff:7f00:1]',
    'http://localhost', 'http://x.localhost.', 'https://api.example.test:8443', 'ftp://api.example.test',
    'https://user:password@api.example.test', 'https://api.example.test?x=1', 'https://api.example.test#fragment',
  ])('rejects unsafe URL %s before sending credentials', async baseUrl => {
    await expect(new OpenAiCompatibleBeginnerClient().suggest({ ...input, baseUrl })).rejects.toThrow(/^beginner_ai_unavailable$/);
    expect(request).not.toHaveBeenCalled(); expect(lookup).not.toHaveBeenCalled();
  });
  it.each([
    [{ address: '10.0.0.1', family: 4 }],
    [publicAddress, { address: '169.254.169.254', family: 4 }],
    [publicAddress, { address: 'fd00::1', family: 6 }],
    [{ address: '::ffff:192.168.1.1', family: 6 }],
    [],
  ])('rejects unsafe or mixed DNS answers %#', async (...addresses) => {
    vi.mocked(lookup).mockResolvedValue(addresses);
    await expect(new OpenAiCompatibleBeginnerClient().suggest(input)).rejects.toThrow(/^beginner_ai_unavailable$/);
    expect(request).not.toHaveBeenCalled();
  });
  it('supports public IPv4/IPv6 literals without DNS and fails closed on DNS failure or abort', async () => {
    for (const baseUrl of ['https://8.8.8.8', 'https://[2606:4700:4700::1111]']) {
      expect(await resolveBeginnerAiTarget(baseUrl, input.signal)).toHaveLength(1);
    }
    expect(lookup).not.toHaveBeenCalled();
    vi.mocked(lookup).mockRejectedValueOnce(new Error(secret + ' 10.0.0.1'));
    await expect(new OpenAiCompatibleBeginnerClient().suggest(input)).rejects.toThrow(/^beginner_ai_unavailable$/);
    vi.mocked(lookup).mockReturnValueOnce(new Promise(() => undefined));
    const controller = new AbortController();
    const pending = new OpenAiCompatibleBeginnerClient().suggest({ ...input, signal: controller.signal }); controller.abort();
    await expect(pending).rejects.toThrow(/^beginner_ai_unavailable$/);
    expect(request).not.toHaveBeenCalled();
  });
  it('rejects redirects, provider errors, oversized streams and malformed envelopes with a fixed error', async () => {
    for (const [body, status] of [[secret, 401], [secret, 302], ['x'.repeat(17000), 200], ['{}', 200], [secret, 200]] as const) {
      respond(body, status);
      await expect(new OpenAiCompatibleBeginnerClient().suggest(input)).rejects.toThrow(/^beginner_ai_unavailable$/);
    }
  });
  it('does not expose transport exception details', async () => {
    vi.mocked(request).mockImplementationOnce(() => { throw new Error('Authorization: Bearer ' + secret + ' 10.0.0.1'); });
    await expect(new OpenAiCompatibleBeginnerClient().suggest(input)).rejects.toThrow(/^beginner_ai_unavailable$/);
  });
});
