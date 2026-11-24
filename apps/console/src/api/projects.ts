import type { BeginnerPlatform, ProjectRecord } from '@forgekit/contracts';
import type { ProjectOptions } from '@forgekit/project-core';
import { getAccessToken } from '../auth/session';

export class ProjectApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = 'ProjectApiError';
  }
}

interface ResponseOptions { emptyAsNull?: boolean }

export async function apiRequest<T>(path: string, init?: RequestInit, timeoutMs = 8000, options: ResponseOptions = {}): Promise<T> {
  let response: Response;
  try {
    const headers = new Headers(init?.headers);
    const token = await getAccessToken();
    if (token) headers.set('Authorization', `Bearer ${token}`);
    response = await fetch(`/api/v1${path}`, { ...init, headers, signal: AbortSignal.timeout(timeoutMs) });
  } catch {
    throw new ProjectApiError('无法连接后端 API。请确认 API 与 MySQL 已启动。', 0);
  }
  if (!response.ok) {
    const body: unknown = await response.json().catch(() => null);
    const message = body && typeof body === 'object' && 'message' in body && typeof body.message === 'string'
      ? body.message : `请求失败（HTTP ${response.status}）。`;
    throw new ProjectApiError(response.status === 401 ? '需要登录或当前会话已失效，请重新登录。' : message, response.status);
  }
  // No Content / Reset Content responses have no JSON body (including DELETE).
  if (response.status === 204 || response.status === 205) return (options.emptyAsNull ? null : undefined) as T;
  // Nest/Express sends a null controller result as HTTP 200 with an empty body.
  // Only optional config reads opt in; nonempty malformed JSON must still fail.
  if (options.emptyAsNull) {
    const body = await response.text();
    return (body === '' ? null : JSON.parse(body)) as T;
  }
  return response.json() as Promise<T>;
}

export function projectRequest<T>(path: string, init?: RequestInit, options?: ResponseOptions): Promise<T> {
  return apiRequest<T>(`/projects${path}`, init, undefined, options);
}

export function listProjects(): Promise<ProjectRecord[]> {
  return projectRequest<ProjectRecord[]>('');
}

export function getProject(slug: string): Promise<ProjectRecord> {
  return projectRequest<ProjectRecord>(`/${encodeURIComponent(slug)}`);
}

export function saveProject(options: ProjectOptions & { platforms?: BeginnerPlatform[] }): Promise<ProjectRecord> {
  return projectRequest<ProjectRecord>('', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(options),
  });
}
