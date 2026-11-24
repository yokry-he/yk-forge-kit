import { projectRequest, ProjectApiError } from './projects';

/** Only optional config reads accept 404 or a successful empty body as missing setup. */
export async function readProjectConfig<T>(path: string, parse: (data: unknown) => T): Promise<T | null> {
  let data: unknown;
  try { data = await projectRequest<unknown>(path, undefined, { emptyAsNull: true }); }
  catch (reason) {
    if (reason instanceof ProjectApiError && reason.status === 404) return null;
    throw reason;
  }
  if (data === null) return null;
  if (typeof data === 'object' && data !== null && 'configured' in data && data.configured === false) return null;
  return parse(data);
}
