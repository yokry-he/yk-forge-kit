import { StringDecoder } from 'node:string_decoder';
import type { BuildLogSink } from './runner';

export function redactBuildLog(value: string, secrets: readonly string[] = []): string {
  let result = value;
  const variants = secrets.flatMap(secret => [secret, secret.replace(/\r\n/g, '\n'),
    JSON.stringify(secret).slice(1, -1), ...secret.split(/[\r\n]+/)]);
  for (const secret of [...new Set(variants)].filter(secret => secret.length >= 4).sort((a, b) => b.length - a.length)) {
    result = result.split(secret).join('[REDACTED]');
  }
  try {
    JSON.parse(result);
  } catch { return redactCredentials(result); }
  // Redact decoded JSON strings independently so credential matching cannot consume structural quotes/braces.
  return result.replace(/"(?:\\.|[^"\\])*"/g, token => JSON.stringify(redactCredentials(JSON.parse(token) as string)));
}

function redactCredentials(value: string): string {
  return value.replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, '$1[REDACTED]@')
    .replace(/((?:authorization\s*:\s*bearer|(?:token|password|secret|_authToken)\s*[=:])\s*)[^\s,;]+/gi, '$1[REDACTED]');
}

/** Shared budget across both streams/phases, redaction before DB chunking. Exceeding it fails the build. */
export class CappedBuildLogs {
  private bytes = 0;
  constructor(private readonly sink: BuildLogSink, private readonly maxBytes: number,
    private readonly redact: (value: string) => string = redactBuildLog) {}

  async write(stream: 'stdout' | 'stderr', line: string): Promise<void> {
    const value = this.redact(line);
    const bytes = Buffer.byteLength(value);
    if (this.bytes + bytes > this.maxBytes) throw new Error('build_log_limit');
    this.bytes += bytes;
    // Code-point chunking preserves UTF-8; repository caps each chunk at 16 KiB.
    let chunk = '';
    let size = 0;
    for (const char of value) {
      const length = Buffer.byteLength(char);
      if (size + length > 16384) { await this.sink.write(stream, chunk); chunk = ''; size = 0; }
      chunk += char; size += length;
    }
    if (chunk) await this.sink.write(stream, chunk);
  }

  async consume(stream: 'stdout' | 'stderr', input: AsyncIterable<Uint8Array>): Promise<void> {
    const decoder = new StringDecoder('utf8');
    let pending = '';
    const flush = async () => {
      let end: number;
      while ((end = pending.indexOf('\n')) >= 0) {
        const line = pending.slice(0, end + 1); pending = pending.slice(end + 1);
        await this.write(stream, line);
      }
      // Reject rather than split an unbounded line (a split could expose part of a secret).
      if (Buffer.byteLength(pending) > Math.min(this.maxBytes, 65536)) throw new Error('build_log_line_limit');
    };
    for await (const chunk of input) { pending += decoder.write(Buffer.from(chunk)); await flush(); }
    pending += decoder.end(); await flush();
    if (pending) await this.write(stream, pending);
  }
}
