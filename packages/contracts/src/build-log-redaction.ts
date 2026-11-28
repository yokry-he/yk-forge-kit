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

