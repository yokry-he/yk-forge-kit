import type { Build, BuildLogEvent, BuildStreamTicket } from '@forgekit/contracts';
import { BuildSchema, BuildLogEventSchema, BuildStreamTicketSchema } from '@forgekit/contracts';
import { projectRequest } from './projects';

export interface BuildListOptions { beforeNumber?: number; limit?: number }
export interface BuildLogsOptions { seq?: number; limit?: number }

function buildsPath(projectId: string): string {
  return '/' + encodeURIComponent(projectId) + '/builds';
}

function buildPath(projectId: string, buildId: string): string {
  return buildsPath(projectId) + '/' + encodeURIComponent(buildId);
}

export function listBuilds(projectId: string, options?: BuildListOptions): Promise<Build[]> {
  const params = new URLSearchParams();
  if (options?.beforeNumber !== undefined) params.set('beforeNumber', String(options.beforeNumber));
  if (options?.limit !== undefined) params.set('limit', String(options.limit));
  const query = params.toString();
  const path = buildsPath(projectId) + (query ? '?' + query : '');
  return projectRequest<unknown>(path).then((data) => BuildSchema.array().parse(data));
}

export function getBuild(projectId: string, buildId: string): Promise<Build> {
  return projectRequest<unknown>(buildPath(projectId, buildId)).then((data) => BuildSchema.parse(data));
}

export function triggerBuild(projectId: string, sourceRef: string, environmentName?: string, target?: 'h5' | 'mp-weixin' | 'mp-alipay'): Promise<Build> {
  return projectRequest<unknown>(buildsPath(projectId), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sourceRef, ...(target ? { target } : {}), ...(environmentName ? { environmentName } : {}) }),
  }).then((data) => BuildSchema.parse(data));
}

export function cancelBuild(projectId: string, buildId: string): Promise<Build> {
  return projectRequest<unknown>(buildPath(projectId, buildId) + '/cancel', {
    method: 'POST',
  }).then((data) => BuildSchema.parse(data));
}

export function listBuildLogs(
  projectId: string,
  buildId: string,
  options?: BuildLogsOptions,
): Promise<BuildLogEvent[]> {
  const params = new URLSearchParams();
  if (options?.seq !== undefined) params.set('seq', String(options.seq));
  if (options?.limit !== undefined) params.set('limit', String(options.limit));
  const query = params.toString();
  const path = buildPath(projectId, buildId) + '/logs' + (query ? '?' + query : '');
  return projectRequest<unknown>(path).then((data) => BuildLogEventSchema.array().parse(data));
}

export function createBuildStreamTicket(projectId: string, buildId: string): Promise<BuildStreamTicket> {
  return projectRequest<unknown>(buildPath(projectId, buildId) + '/log-stream-ticket', {
    method: 'POST',
  }).then((data) => BuildStreamTicketSchema.parse(data));
}

export function buildLogStreamUrl(
  projectId: string,
  buildId: string,
  options?: { after?: number; ticket?: string },
): string {
  const params = new URLSearchParams();
  if (options?.after !== undefined) params.set('after', String(options.after));
  if (options?.ticket !== undefined) params.set('ticket', options.ticket);
  const query = params.toString();
  const url = '/api/v1/projects/' + encodeURIComponent(projectId) + '/builds/' + encodeURIComponent(buildId) + '/logs/stream';
  return query ? url + '?' + query : url;
}
