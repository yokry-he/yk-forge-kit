import { EnvironmentListSchema, EnvironmentVariableSchema, VariableInputSchema, VariableNameSchema, type VariableInput } from '@forgekit/contracts';
import { projectRequest } from './projects';
const base = (id: string) => '/' + encodeURIComponent(id) + '/environments';
const path = (id: string, environment: string) => base(id) + '/' + encodeURIComponent(environment) + '/variables';
export function listEnvironments(id: string) {
  return projectRequest<unknown>(base(id)).then(value => EnvironmentListSchema.parse(value));
}
export function listEnvironmentVariables(id: string, environment: string) {
  return projectRequest<unknown>(path(id, environment)).then(value => EnvironmentVariableSchema.array().parse(value));
}
export function saveEnvironmentVariable(id: string, environment: string, name: string, input: VariableInput) {
  return projectRequest<unknown>(path(id, environment) + '/' + encodeURIComponent(VariableNameSchema.parse(name)), {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(VariableInputSchema.parse(input)),
  }).then(value => EnvironmentVariableSchema.parse(value));
}
export function removeEnvironmentVariable(id: string, environment: string, name: string) {
  return projectRequest<void>(path(id, environment) + '/' + encodeURIComponent(name), { method: 'DELETE' });
}
