import { readProjectConfig } from './project-config';
import { AlipayConfigInputSchema, AlipayConfigSchema, AlipayJobInputSchema, AlipayJobSchema, AlipayLogEventSchema, BuildStreamTicketSchema,
  type AlipayConfigInput, type AlipayJobInput } from '@forgekit/contracts';
import { getAccessToken } from '../auth/session';
import { projectRequest, ProjectApiError } from './projects';
const path = (id: string) => '/' + encodeURIComponent(id) + '/alipay';
const job = (id: string, jobId: string) => path(id) + '/jobs/' + encodeURIComponent(jobId);
const json = (method: string, input: unknown) => ({ method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) });
export const getAlipayConfig = (id: string) => readProjectConfig(path(id) + '/config', data => AlipayConfigSchema.parse(data));
export const saveAlipayConfig = (id: string, input: AlipayConfigInput) => projectRequest<unknown>(path(id) + '/config', json('PUT', AlipayConfigInputSchema.parse(input))).then(data => AlipayConfigSchema.parse(data));
export const removeAlipayConfig = (id: string) => projectRequest<void>(path(id) + '/config', { method: 'DELETE' });
export const listAlipayJobs = (id: string) => projectRequest<unknown>(path(id) + '/jobs').then(data => AlipayJobSchema.array().parse(data));
export const triggerAlipayJob = (id: string, input: AlipayJobInput) => projectRequest<unknown>(path(id) + '/jobs', json('POST', AlipayJobInputSchema.parse(input))).then(data => AlipayJobSchema.parse(data));
export const listAlipayLogs = (id: string, jobId: string, options: { seq?: number; limit?: number } = {}) => projectRequest<unknown>(job(id, jobId) + '/logs?' + new URLSearchParams({ seq: String(options.seq ?? 0), limit: String(options.limit ?? 500) })).then(data => AlipayLogEventSchema.array().parse(data));
export const createAlipayStreamTicket = (id: string, jobId: string) => projectRequest<unknown>(job(id, jobId) + '/log-stream-ticket', { method: 'POST' }).then(data => BuildStreamTicketSchema.parse(data));
export const alipayLogStreamUrl = (id: string, jobId: string, options: { after?: number; ticket?: string } = {}) => '/api/v1/projects' + job(id, jobId) + '/logs/stream?' + new URLSearchParams({ after: String(options.after ?? 0), ...(options.ticket ? { ticket: options.ticket } : {}) });
export async function getAlipayQr(id: string, jobId: string): Promise<Blob> {
  const token = await getAccessToken();
  const response = await fetch('/api/v1/projects' + job(id, jobId) + '/qr', { headers: token ? { Authorization: 'Bearer ' + token } : {}, cache: 'no-store', signal: AbortSignal.timeout(8000) });
  if (!response.ok) throw new ProjectApiError('二维码加载失败。', response.status);
  const blob = await response.blob();
  if (!['image/jpeg', 'image/png'].includes(blob.type) || blob.size > 1048576) throw new Error('二维码格式无效。'); return blob;
}
export const alipayStatusText = { queued: '排队中', running: '执行中', succeeded: '成功', failed: '失败' };
