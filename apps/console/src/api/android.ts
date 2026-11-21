import { AndroidConfigInputSchema, AndroidConfigSchema, AndroidJobInputSchema, AndroidJobSchema, AndroidLogEventSchema, BuildStreamTicketSchema,
  type AndroidConfigInput, type AndroidJobInput } from '@forgekit/contracts';
import { getAccessToken } from '../auth/session';
import { projectRequest, ProjectApiError } from './projects';
const path = (id: string) => '/' + encodeURIComponent(id) + '/android';
const job = (id: string, jobId: string) => path(id) + '/jobs/' + encodeURIComponent(jobId);
const json = (method: string, input: unknown) => ({ method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) });
export const getAndroidConfig = (id: string) => projectRequest<unknown>(path(id) + '/config').then(data => AndroidConfigSchema.nullable().parse(data));
export const saveAndroidConfig = (id: string, input: AndroidConfigInput) => projectRequest<unknown>(path(id) + '/config', json('PUT', AndroidConfigInputSchema.parse(input))).then(data => AndroidConfigSchema.parse(data));
export const removeAndroidConfig = (id: string) => projectRequest<void>(path(id) + '/config', { method: 'DELETE' });
export const listAndroidJobs = (id: string) => projectRequest<unknown>(path(id) + '/jobs').then(data => AndroidJobSchema.array().parse(data));
export const triggerAndroidJob = (id: string, input: AndroidJobInput) => projectRequest<unknown>(path(id) + '/jobs', json('POST', AndroidJobInputSchema.parse(input))).then(data => AndroidJobSchema.parse(data));
export const listAndroidLogs = (id: string, jobId: string, options: { seq?: number; limit?: number } = {}) => projectRequest<unknown>(job(id, jobId) + '/logs?' + new URLSearchParams({ seq: String(options.seq ?? 0), limit: String(options.limit ?? 500) })).then(data => AndroidLogEventSchema.array().parse(data));
export const createAndroidStreamTicket = (id: string, jobId: string) => projectRequest<unknown>(job(id, jobId) + '/log-stream-ticket', { method: 'POST' }).then(data => BuildStreamTicketSchema.parse(data));
export const androidLogStreamUrl = (id: string, jobId: string, options: { after?: number; ticket?: string } = {}) => '/api/v1/projects' + job(id, jobId) + '/logs/stream?' + new URLSearchParams({ after: String(options.after ?? 0), ...(options.ticket ? { ticket: options.ticket } : {}) });
export const cancelAndroidJob = (id: string, jobId: string) => projectRequest<unknown>(job(id, jobId) + '/cancel', { method: 'POST' }).then(data => AndroidJobSchema.parse(data));
export async function downloadAndroidArtifact(id: string, jobId: string): Promise<Blob> {
  const token = await getAccessToken();
  const response = await fetch('/api/v1/projects' + job(id, jobId) + '/artifact', { headers: token ? { Authorization: 'Bearer ' + token } : {}, cache: 'no-store', signal: AbortSignal.timeout(120000) });
  if (!response.ok) throw new ProjectApiError('安装包下载失败。', response.status);
  const blob = await response.blob();
  if (blob.size > 268435456) throw new Error('安装包过大。'); return blob;
}
export const androidStatusText = { queued: '排队中', running: '执行中', succeeded: '成功', failed: '失败' };
