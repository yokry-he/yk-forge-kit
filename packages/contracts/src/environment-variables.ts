import { z } from 'zod';
import { BuildIdSchema } from './builds';

export const EnvironmentNameSchema = z.string().min(1).max(64).regex(/^[a-z][a-z0-9_-]*$/);
// Protect the platform and the runner's runtime. Application DATABASE_URL is allowed.
const reserved = new Set(['PATH', 'HOME', 'CI', 'NODE_OPTIONS', 'LD_PRELOAD', 'LD_LIBRARY_PATH', 'ENV', 'BASH_ENV',
  'GCONV_PATH', 'GLIBC_TUNABLES', 'SSL_CERT_FILE', 'SSL_CERT_DIR', 'COREPACK_HOME', 'COREPACK_ENABLE_DOWNLOAD_PROMPT', 'NUXT_TELEMETRY_DISABLED', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY']);
export const VariableNameSchema = z.string().min(1).max(128).regex(/^[A-Z_][A-Z0-9_]*$/)
  .refine(name => !['FORGEKIT_', 'DOCKER_', 'LD_', 'DYLD_'].some(prefix => name.startsWith(prefix)) && !reserved.has(name));
export const VariableKindSchema = z.enum(['plain', 'secret']);
export const VariableInputSchema = z.strictObject({ kind: VariableKindSchema,
  value: z.string().max(16384).refine(value => !value.includes('\0') && new TextEncoder().encode(value).length <= 16384),
}).refine(input => input.kind !== 'secret' || input.value.length >= 4 && input.value.split(/[\r\n]+/).every(line => line.length === 0 || line.length >= 4) && input.value.trim().length >= 4, '秘密值至少需要 4 个字符');
export type VariableInput = z.infer<typeof VariableInputSchema>;
export const EnvironmentVariableSchema = z.strictObject({ name: VariableNameSchema, kind: VariableKindSchema,
  value: z.string().optional(), updatedAt: z.iso.datetime(), updatedBy: BuildIdSchema,
}).refine(row => row.kind === 'plain' ? typeof row.value === 'string' : row.value === undefined);
export const EnvironmentListSchema = z.array(z.strictObject({ name: EnvironmentNameSchema }));
export type EnvironmentVariable = z.infer<typeof EnvironmentVariableSchema>;
