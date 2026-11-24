import { readProjectConfig } from './project-config';
import { WeappConfigInputSchema, WeappConfigSchema, WeappJobInputSchema, WeappJobSchema, WeappLogEventSchema, BuildStreamTicketSchema,
  type WeappConfigInput, type WeappJobInput } from '@forgekit/contracts';
import { getAccessToken } from '../auth/session';
import { projectRequest, ProjectApiError } from './projects';
const path = (id: string) => '/' + encodeURIComponent(id) + '/weapp';
const job = (id: string, jobId: string) => path(id) + '/jobs/' + encodeURIComponent(jobId);
const json = (method: string, input: unknown) => ({ method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) });
export const getWeappConfig = (id: string) => readProjectConfig(path(id) + '/config', data => WeappConfigSchema.parse(data));
export const saveWeappConfig = (id: string, input: WeappConfigInput) => projectRequest<unknown>(path(id) + '/config', json('PUT', WeappConfigInputSchema.parse(input))).then(data => WeappConfigSchema.parse(data));
export const removeWeappConfig = (id: string) => projectRequest<void>(path(id) + '/config', { method: 'DELETE' });
export const listWeappJobs = (id: string) => projectRequest<unknown>(path(id) + '/jobs').then(data => WeappJobSchema.array().parse(data));
export const triggerWeappJob = (id: string, input: WeappJobInput) => projectRequest<unknown>(path(id) + '/jobs', json('POST', WeappJobInputSchema.parse(input))).then(data => WeappJobSchema.parse(data));
export const listWeappLogs = (id: string, jobId: string, options: { seq?: number; limit?: number } = {}) => projectRequest<unknown>(job(id, jobId) + '/logs?' + new URLSearchParams({ seq: String(options.seq ?? 0), limit: String(options.limit ?? 500) })).then(data => WeappLogEventSchema.array().parse(data));
export const createWeappStreamTicket = (id: string, jobId: string) => projectRequest<unknown>(job(id, jobId) + '/log-stream-ticket', { method: 'POST' }).then(data => BuildStreamTicketSchema.parse(data));
export const weappLogStreamUrl = (id: string, jobId: string, options: { after?: number; ticket?: string } = {}) => '/api/v1/projects' + job(id, jobId) + '/logs/stream?' + new URLSearchParams({ after: String(options.after ?? 0), ...(options.ticket ? { ticket: options.ticket } : {}) });
export async function getWeappQr(id: string, jobId: string): Promise<Blob> {
  const token = await getAccessToken();
  const response = await fetch('/api/v1/projects' + job(id, jobId) + '/qr', { headers: token ? { Authorization: 'Bearer ' + token } : {}, cache: 'no-store', signal: AbortSignal.timeout(8000) });
  if (!response.ok) throw new ProjectApiError('二维码加载失败。', response.status);
  const blob = await response.blob();
  if (blob.type !== 'image/jpeg' || blob.size > 1048576) throw new Error('二维码格式无效。'); return blob;
}
export const weappStatusText = { queued: '排队中', running: '执行中', succeeded: '成功', failed: '失败' };
