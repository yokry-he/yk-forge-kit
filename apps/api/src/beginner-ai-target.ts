import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { isPublicBeginnerAddress, isSafeBeginnerBaseUrl } from '@forgekit/contracts';

export class BeginnerAiTargetError extends Error {
  constructor() { super('beginner_ai_unavailable'); }
}

/** Resolve every time, reject mixed public/private answers, and return only checked IPs. */
export async function resolveBeginnerAiTarget(baseUrl: string, signal: AbortSignal): Promise<{ address: string; family: number }[]> {
  try {
    if (!isSafeBeginnerBaseUrl(baseUrl)) throw new BeginnerAiTargetError();
    const hostname = new URL(baseUrl).hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '');
    const resolve = async () => isIP(hostname) ? [{ address: hostname, family: isIP(hostname) }] : lookup(hostname, { all: true, verbatim: true });
    signal.throwIfAborted();
    let abort: () => void = () => undefined;
    const cancelled = new Promise<never>((_, reject) => { abort = () => reject(new BeginnerAiTargetError()); signal.addEventListener('abort', abort, { once: true }); });
    try {
      const addresses = await Promise.race([resolve(), cancelled]);
      if (!addresses.length || addresses.some(ip => ![4, 6].includes(ip.family) || isIP(ip.address) !== ip.family || !isPublicBeginnerAddress(ip.address))) throw new BeginnerAiTargetError();
      return addresses;
    } finally { signal.removeEventListener('abort', abort); }
  } catch { throw new BeginnerAiTargetError(); }
}
