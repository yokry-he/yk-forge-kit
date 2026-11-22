import type { BeginnerConfigInput, BeginnerConfigMetadata, BeginnerResult } from '@forgekit/contracts';
import { apiRequest } from './projects';
export const classifyNeed = (description: string) => apiRequest<BeginnerResult>('/beginner/classify', {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ description }),
}, 15_000);
export const getBeginnerConfig = () => apiRequest<BeginnerConfigMetadata>('/beginner/ai-config');
export const saveBeginnerConfig = (input: BeginnerConfigInput) => apiRequest<BeginnerConfigMetadata>('/beginner/ai-config', {
  method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input),
});
export const deleteBeginnerConfig = () => apiRequest<void>('/beginner/ai-config', { method: 'DELETE' });
