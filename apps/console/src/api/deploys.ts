import { DeployTargetSchema, DeploymentSchema, DeployLogEventSchema, BuildStreamTicketSchema,
  DeployTargetCreateSchema, DeployTargetUpdateSchema, type DeployTargetCreate, type DeployTargetUpdate } from '@forgekit/contracts';
import { projectRequest } from './projects';
const path = (projectId: string) => '/' + encodeURIComponent(projectId);
const json = (method: string, input: unknown) => ({ method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) });
export function listDeployTargets(projectId: string) {
  return projectRequest<unknown>(path(projectId) + '/deploy-targets').then(value => DeployTargetSchema.array().parse(value));
}
export function saveDeployTarget(projectId: string, targetId: string | undefined, input: DeployTargetCreate | DeployTargetUpdate) {
  const parsed = (targetId ? DeployTargetUpdateSchema : DeployTargetCreateSchema).parse(input);
  return projectRequest<unknown>(path(projectId) + '/deploy-targets' + (targetId ? '/' + encodeURIComponent(targetId) : ''),
    json(targetId ? 'PATCH' : 'POST', parsed)).then(value => DeployTargetSchema.parse(value));
}
export function removeDeployTarget(projectId: string, targetId: string) {
  return projectRequest<void>(path(projectId) + '/deploy-targets/' + encodeURIComponent(targetId), { method: 'DELETE' });
}
export function listDeployments(projectId: string) {
  return projectRequest<unknown>(path(projectId) + '/deployments').then(value => DeploymentSchema.array().parse(value));
}
export function getDeployment(projectId: string, deploymentId: string) {
  return projectRequest<unknown>(path(projectId) + '/deployments/' + encodeURIComponent(deploymentId)).then(value => DeploymentSchema.parse(value));
}
export function triggerDeployment(projectId: string, buildId: string, deployTargetId: string) {
  return projectRequest<unknown>(path(projectId) + '/deployments', json('POST', { buildId, deployTargetId })).then(value => DeploymentSchema.parse(value));
}
export function rollbackDeployment(projectId: string, deploymentId: string) {
  return projectRequest<unknown>(path(projectId) + '/deployments/' + encodeURIComponent(deploymentId) + '/rollback', { method: 'POST' })
    .then(value => DeploymentSchema.parse(value));
}
export function listDeployLogs(projectId: string, deploymentId: string, options: { seq?: number; limit?: number } = {}) {
  const params = new URLSearchParams({ seq: String(options.seq ?? 0), limit: String(options.limit ?? 500) });
  return projectRequest<unknown>(path(projectId) + '/deployments/' + encodeURIComponent(deploymentId) + '/logs?' + params)
    .then(value => DeployLogEventSchema.array().parse(value));
}
export function createDeployStreamTicket(projectId: string, deploymentId: string) {
  return projectRequest<unknown>(path(projectId) + '/deployments/' + encodeURIComponent(deploymentId) + '/log-stream-ticket', { method: 'POST' })
    .then(value => BuildStreamTicketSchema.parse(value));
}
export function deployLogStreamUrl(projectId: string, deploymentId: string, options: { after?: number; ticket?: string } = {}) {
  const params = new URLSearchParams({ after: String(options.after ?? 0), ...(options.ticket ? { ticket: options.ticket } : {}) });
  return '/api/v1/projects' + path(projectId) + '/deployments/' + encodeURIComponent(deploymentId) + '/logs/stream?' + params;
}
export const deployStatusText = { pending: '排队中', running: '部署中', succeeded: '部署成功', failed: '部署失败', canceled: '已取消', rolled_back: '回滚完成' };
