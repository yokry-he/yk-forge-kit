import { z } from 'zod';
import { isSafeBeginnerBaseUrl } from './beginner-ai-url';
export { isPublicBeginnerAddress, isSafeBeginnerBaseUrl } from './beginner-ai-url';

export const BeginnerTemplateSchema = z.enum(['vue-web', 'vue-admin', 'nuxt-site', 'uniapp', 'tauri-desktop']);
export type BeginnerTemplate = z.infer<typeof BeginnerTemplateSchema>;
export const BeginnerPlatformSchema = z.enum(['web', 'uniapp', 'weapp', 'alipay', 'android', 'tauri-desktop']);
export type BeginnerPlatform = z.infer<typeof BeginnerPlatformSchema>;
export const beginnerPlatforms: Record<BeginnerTemplate, readonly BeginnerPlatform[]> = {
  'vue-web': ['web'], 'vue-admin': ['web'], 'nuxt-site': ['web'],
  uniapp: ['web', 'uniapp', 'weapp', 'alipay', 'android'], 'tauri-desktop': ['tauri-desktop'],
};
export const beginnerDefaults: Record<BeginnerTemplate, BeginnerPlatform[]> = {
  'vue-web': ['web'], 'vue-admin': ['web'], 'nuxt-site': ['web'], uniapp: ['web', 'weapp'], 'tauri-desktop': ['tauri-desktop'],
};
export const BeginnerNameSchema = z.string().max(60).regex(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/);
export const BeginnerDescriptionSchema = z.strictObject({ description: z.string().trim().min(1).max(2000)
  .refine(value => !/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value)) });
// Reject additional model properties; only these fields may cross the API boundary.
export const BeginnerSuggestionSchema = z.strictObject({ templateId: BeginnerTemplateSchema, name: BeginnerNameSchema,
  platforms: z.array(BeginnerPlatformSchema).min(1).max(6), lowConfidence: z.boolean().optional() });
export type BeginnerSuggestion = z.infer<typeof BeginnerSuggestionSchema>;
export type BeginnerResult = BeginnerSuggestion & { source: 'ai' | 'keywords'; warnings?: string[] };
export const DEFAULT_AI_CONFIG = { provider: 'DeepSeek', baseUrl: 'https://api.deepseek.com', model: 'deepseek-chat' } as const;
export const BeginnerConfigInputSchema = z.strictObject({
  provider: z.string().trim().min(1).max(64).regex(/^[\p{L}\p{N} ._-]+$/u).default(DEFAULT_AI_CONFIG.provider),
  baseUrl: z.string().trim().max(512).url().refine(isSafeBeginnerBaseUrl).default(DEFAULT_AI_CONFIG.baseUrl),
  model: z.string().trim().min(1).max(128).regex(/^[a-zA-Z0-9._:/-]+$/).default(DEFAULT_AI_CONFIG.model),
  apiKey: z.string().max(4096).refine(value => value === '' || value.length >= 4 && !/[\s\p{Cc}]/u.test(value)).optional(),
});
export type BeginnerConfigInput = z.infer<typeof BeginnerConfigInputSchema>;
/** The credential destination includes provider/model routing as well as the API root. */
export function beginnerCredentialDestination(input: Pick<BeginnerConfigInput, 'provider' | 'baseUrl' | 'model'>): string {
  const url = new URL(input.baseUrl);
  url.hostname = url.hostname.replace(/\.$/, '');
  return JSON.stringify([input.provider, url.toString().replace(/\/+$/, ''), input.model]);
}
export interface BeginnerConfigMetadata { configured: boolean; provider?: string; baseUrl?: string; model?: string; updatedAt?: string }

export const BeginnerProjectPlatformsSchema = z.array(BeginnerPlatformSchema).min(1).max(6)
  .refine(values => new Set(values).size === values.length);
