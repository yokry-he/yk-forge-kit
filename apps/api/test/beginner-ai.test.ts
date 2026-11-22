import { afterEach, describe, expect, it, vi } from 'vitest';
import { OpenAiCompatibleBeginnerClient } from '../src/beginner-ai';
const secret = 'sk-private-b21-key';
const input = { description: '公司官网', apiKey: secret, baseUrl: 'https://api.example.test/v1/', model: 'custom-model', signal: new AbortController().signal };
afterEach(() => vi.unstubAllGlobals());
describe('OpenAI-compatible B21 adapter', () => {
  it('separates untrusted needs from system instructions and only sends key in authorization', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({ choices: [{ message: { content: '{"templateId":"nuxt-site"}' } }] })));
    vi.stubGlobal('fetch', fetcher);
    expect(await new OpenAiCompatibleBeginnerClient().suggest(input)).toBe('{"templateId":"nuxt-site"}');
    const [url, init] = fetcher.mock.calls[0]!;
    expect(url).toBe('https://api.example.test/v1/chat/completions');
    expect(init.redirect).toBe('error'); expect(init.signal).toBe(input.signal);
    expect(init.headers.Authorization).toBe('Bearer ' + secret);
    expect(init.body).not.toContain(secret);
    const body = JSON.parse(init.body);
    expect(body.model).toBe('custom-model');
    expect(body.messages[0].role).toBe('system'); expect(body.messages[0].content).not.toContain(input.description);
    expect(body.messages[1]).toEqual({ role: 'user', content: JSON.stringify({ untrustedNeed: input.description }) });
  });
  it('rejects provider errors, oversized streams and malformed envelopes without returning raw bodies', async () => {
    const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher);
    for (const response of [new Response(secret, { status: 401 }), new Response('x'.repeat(17000)), new Response('{}')]) {
      fetcher.mockResolvedValueOnce(response);
      await expect(new OpenAiCompatibleBeginnerClient().suggest(input)).rejects.toThrow(/^beginner_ai_/);
    }
  });
});
