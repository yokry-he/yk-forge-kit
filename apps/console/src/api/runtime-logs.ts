import { RuntimeLogSessionSchema, RuntimeLogInputSchema, RuntimeLogEventSchema, BuildStreamTicketSchema, type RuntimeLogInput } from '@forgekit/contracts';
import { projectRequest } from './projects';
const path = (projectId: string) => '/' + encodeURIComponent(projectId);
export function createRuntimeSession(projectId: string, input: RuntimeLogInput) {
  return projectRequest<unknown>(path(projectId) + '/runtime-log-sessions', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(RuntimeLogInputSchema.parse(input)) }).then(value => RuntimeLogSessionSchema.parse(value));
}
export function cancelRuntimeSession(projectId: string, sessionId: string) {
  return projectRequest<void>(path(projectId) + '/runtime-log-sessions/' + encodeURIComponent(sessionId), { method: 'DELETE' });
}
export function listRuntimeLogs(projectId: string, sessionId: string, options: { seq?: number; limit?: number } = {}) {
  const params = new URLSearchParams({ seq: String(options.seq ?? 0), limit: String(options.limit ?? 500) });
  return projectRequest<unknown>(path(projectId) + '/runtime-log-sessions/' + encodeURIComponent(sessionId) + '/logs?' + params)
    .then(value => RuntimeLogEventSchema.array().parse(value));
}
export function createRuntimeStreamTicket(projectId: string, sessionId: string) {
  return projectRequest<unknown>(path(projectId) + '/runtime-log-sessions/' + encodeURIComponent(sessionId) + '/log-stream-ticket', { method: 'POST' })
    .then(value => BuildStreamTicketSchema.parse(value));
}
export function runtimeLogStreamUrl(projectId: string, sessionId: string, options: { after?: number; ticket?: string } = {}) {
  const params = new URLSearchParams({ after: String(options.after ?? 0), ...(options.ticket ? { ticket: options.ticket } : {}) });
  return '/api/v1/projects' + path(projectId) + '/runtime-log-sessions/' + encodeURIComponent(sessionId) + '/logs/stream?' + params;
}
