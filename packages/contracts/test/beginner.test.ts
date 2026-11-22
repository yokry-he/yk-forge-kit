import { describe, expect, it } from 'vitest';
import { BeginnerConfigInputSchema, isPublicBeginnerAddress } from '../src/beginner';
describe('B21 AI URL contract', () => {
  it.each([
    'http://127.1', 'http://2130706433', 'http://0x7f000001', 'http://0.0.0.0', 'http://10.0.0.1',
    'http://172.31.255.255', 'http://192.168.0.1', 'http://169.254.169.254', 'http://100.127.255.255',
    'http://224.0.0.1', 'http://240.0.0.1', 'http://[::1]', 'http://[::]', 'http://[fd00::1]',
    'http://[fe80::1]', 'http://[ff00::1]', 'http://[::ffff:10.0.0.1]', 'http://[::ffff:a00:1]',
    'http://localhost.', 'https://u:p@example.com', 'file:///tmp/key', 'https://example.com:8080', 'https://example.com?', 'https://example.com#', 'http://168.63.129.16',
  ])('rejects %s', baseUrl => {
    expect(BeginnerConfigInputSchema.safeParse({ baseUrl }).success).toBe(false);
  });
  it.each(['https://api.deepseek.com', 'https://example.com/v1', 'https://8.8.8.8:443/v1', 'http://example.com:80/v1', 'https://[2606:4700:4700::1111]/v1'])('accepts public targets %s (DNS is checked by the server)', baseUrl => {
    expect(BeginnerConfigInputSchema.safeParse({ baseUrl }).success).toBe(true);
  });
  it.each(['0.0.0.0', '192.0.0.1', '198.18.0.1', '198.19.255.255', '192.0.2.1', '198.51.100.1', '203.0.113.1', '::ffff:169.254.169.254', '2001:db8::1', '2002:7f00:1::', '64:ff9b::7f00:1', 'invalid'])('rejects non-public addresses %s', address => {
    expect(isPublicBeginnerAddress(address)).toBe(false);
  });
});
