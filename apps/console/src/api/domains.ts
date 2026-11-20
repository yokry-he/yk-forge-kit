import { DomainSchema, DomainOperationSchema, DomainLogEventSchema, DomainCreateSchema, BuildStreamTicketSchema, type DomainOperation } from '@forgekit/contracts';
import { projectRequest } from './projects';
const path = (projectId: string) => '/' + encodeURIComponent(projectId);
export function listDomains(projectId: string) {
  return projectRequest<unknown>(path(projectId) + '/domains').then(value => DomainSchema.array().parse(value));
}
export function createDomain(projectId: string, input: { deployTargetId: string; hostname: string }) {
  return projectRequest<unknown>(path(projectId) + '/domains', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(DomainCreateSchema.parse(input)) }).then(value => DomainSchema.parse(value));
}
export function requestDomainOperation(projectId: string, domainId: string, action: DomainOperation['action']) {
  return projectRequest<unknown>(path(projectId) + '/domains/' + encodeURIComponent(domainId) + (action === 'remove' ? '' : '/' + action),
    { method: action === 'remove' ? 'DELETE' : 'POST' }).then(value => DomainOperationSchema.parse(value));
}
export function listDomainOperations(projectId: string) {
  return projectRequest<unknown>(path(projectId) + '/domain-operations').then(value => DomainOperationSchema.array().parse(value));
}
export function getDomainOperation(projectId: string, operationId: string) {
  return projectRequest<unknown>(path(projectId) + '/domain-operations/' + encodeURIComponent(operationId)).then(value => DomainOperationSchema.parse(value));
}
export function listDomainLogs(projectId: string, operationId: string, options: { seq?: number; limit?: number } = {}) {
  const params = new URLSearchParams({ seq: String(options.seq ?? 0), limit: String(options.limit ?? 500) });
  return projectRequest<unknown>(path(projectId) + '/domain-operations/' + encodeURIComponent(operationId) + '/logs?' + params)
    .then(value => DomainLogEventSchema.array().parse(value));
}
export function createDomainStreamTicket(projectId: string, operationId: string) {
  return projectRequest<unknown>(path(projectId) + '/domain-operations/' + encodeURIComponent(operationId) + '/log-stream-ticket', { method: 'POST' })
    .then(value => BuildStreamTicketSchema.parse(value));
}
export function domainLogStreamUrl(projectId: string, operationId: string, options: { after?: number; ticket?: string } = {}) {
  const params = new URLSearchParams({ after: String(options.after ?? 0), ...(options.ticket ? { ticket: options.ticket } : {}) });
  return '/api/v1/projects' + path(projectId) + '/domain-operations/' + encodeURIComponent(operationId) + '/logs/stream?' + params;
}
export const domainStatusText = { pending_dns: '等待 DNS', verifying: '验证中', issuing: '签发证书中', active: 'HTTPS 可用', failed: '操作或检查失败，HTTPS 可用性未确认', expired: '证书已到期', revoked: '已停用' };
export const domainActionText = { verify: '验证并启用 HTTPS', refresh: '刷新证书状态', remove: '移除域名' };
export const domainOperationStatusText = { pending: '排队中', running: '执行中', succeeded: '已完成', failed: '操作失败' };
export const domainTlsModeText = { internal: '内部 CA（浏览器默认不信任）', staging: 'ACME 测试 CA（浏览器默认不信任）', production: 'ACME 生产 CA' };
