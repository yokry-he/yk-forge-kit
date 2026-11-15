import type { ProjectRecord } from '@forgekit/contracts';
import type { ProjectOptions } from '@forgekit/project-core';

export class ProjectApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = 'ProjectApiError';
  }
}

export async function projectRequest<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`/api/v1/projects${path}`, { ...init, signal: AbortSignal.timeout(8000) });
  } catch {
    throw new ProjectApiError('无法连接后端 API。请确认 API 与 MySQL 已启动。', 0);
  }
  if (!response.ok) {
    const body: unknown = await response.json().catch(() => null);
    const message = body && typeof body === 'object' && 'message' in body && typeof body.message === 'string'
      ? body.message : `请求失败（HTTP ${response.status}）。`;
    throw new ProjectApiError(message, response.status);
  }
  return response.json() as Promise<T>;
}

export function listProjects(): Promise<ProjectRecord[]> {
  return projectRequest<ProjectRecord[]>('');
}

export function getProject(slug: string): Promise<ProjectRecord> {
  return projectRequest<ProjectRecord>(`/${encodeURIComponent(slug)}`);
}

export function saveProject(options: ProjectOptions): Promise<ProjectRecord> {
  return projectRequest<ProjectRecord>('', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(options),
  });
}
