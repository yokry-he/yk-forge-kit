import { projectRequest, ProjectApiError } from './projects';

/** Only configuration reads may interpret 404 as missing setup; jobs and writes must still fail. */
export async function readProjectConfig<T>(path: string, parse: (data: unknown) => T): Promise<T | null> {
  let data: unknown;
  try { data = await projectRequest<unknown>(path); }
  catch (reason) {
    if (reason instanceof ProjectApiError && reason.status === 404) return null;
    throw reason;
  }
  if (data === null) return null;
  if (typeof data === 'object' && data !== null && 'configured' in data && data.configured === false) return null;
  return parse(data);
}
