import { describe, it, expect, beforeEach } from 'vitest';
import { createBuildLogTextSanitizer } from '../src/utils/build-log-text';

describe('createBuildLogTextSanitizer', () => {
  let sanitizer: ReturnType<typeof createBuildLogTextSanitizer>;

  beforeEach(() => {
    sanitizer = createBuildLogTextSanitizer();
  });

  it('removes CSI sequences', () => {
    expect(sanitizer.push('\x1b[31mred\x1b[0m')).toBe('red');
  });

  it('removes OSC hyperlink sequences', () => {
    const input = '\x1b]8;;http://example.com\x1b\\link text\x1b]8;;\x1b\\';
    expect(sanitizer.push(input)).toBe('link text');
  });

  it('removes other OSC sequences', () => {
    expect(sanitizer.push('\x1b]0;window title\x1b\\')).toBe('');
  });

  it('removes other ESC control sequences', () => {
    expect(sanitizer.push('\x1b[2J\x1b(B')).toBe('');
  });

  it('removes dangerous control characters but preserves newline and tab', () => {
    const input = 'a\x00b\x07c\x08d\x0Be\x0Cf\x0Eg\x0Fh\x1Ai\x7Fj\nk\tl';
    expect(sanitizer.push(input)).toBe('abcdefghij\nk\tl');
  });

  it('preserves normal text including Unicode and multiline', () => {
    const input = '构建日志 🚀\n第二行\t缩进';
    expect(sanitizer.push(input)).toBe(input);
  });

  it('handles CSI sequence split across chunks', () => {
    expect(sanitizer.push('\x1b[31')).toBe('');
    expect(sanitizer.push('mred\x1b[0m')).toBe('red');
  });

  it('handles OSC hyperlink split across chunks', () => {
    expect(sanitizer.push('\x1b]8;;http://example.com\x1b')).toBe('');
    expect(sanitizer.push('\\link text\x1b]8;;\x1b\\')).toBe('link text');
  });

  it('does not output text before an incomplete sequence and discards it on following normal text', () => {
    expect(sanitizer.push('prefix\x1b')).toBe('prefix');
    expect(sanitizer.push('after')).toBe('after');
  });

  it('discards overlong escape sequences without leaking memory', () => {
    const longCsi = '\x1b[' + '0'.repeat(5000) + 'm';
    expect(sanitizer.push(longCsi)).toBe('');
    expect(sanitizer.push('after')).toBe('after');
  });

  it('reset clears incomplete escape state', () => {
    expect(sanitizer.push('abc\x1b[')).toBe('abc');
    sanitizer.reset();
    expect(sanitizer.push('def')).toBe('def');
  });
});

it('bounds overlong unterminated OSC and resumes normal Unicode', () => {
  const sanitizer = createBuildLogTextSanitizer();
  expect(sanitizer.push('\x1b]' + 'x'.repeat(8191))).toBe('');
  expect(sanitizer.push('恢复\n')).toBe('恢复\n');
});
it('recognizes C1 and split ESC charset/string controls', () => {
  const sanitizer = createBuildLogTextSanitizer();
  expect(sanitizer.push('\x9b31m红\x9b0m')).toBe('红');
  expect(sanitizer.push('\x1b(')).toBe(''); expect(sanitizer.push('B文本')).toBe('文本');
  expect(sanitizer.push('\x1bPprivate\x1b')).toBe(''); expect(sanitizer.push('\\正文')).toBe('正文');
});
