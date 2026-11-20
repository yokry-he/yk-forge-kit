import { z } from 'zod';
import { BuildIdSchema, BuildLogContentSchema, BuildLogStreamSchema, DeploymentSchema } from './builds';

// SSH operands are data, never options, shell fragments, URLs or known_hosts patterns.
export const SshHostSchema = z.string().min(1).max(253).regex(/^[a-zA-Z0-9](?:[a-zA-Z0-9.-]*[a-zA-Z0-9])?$/)
  .refine(value => {
    if (value.includes('..') || value.toLowerCase() === 'metadata.google.internal') return false;
    if (/^[0-9.]+$/.test(value)) {
      const octets = value.split('.');
      if (octets.length !== 4 || octets.some(part => !/^(0|[1-9][0-9]{0,2})$/.test(part) || Number(part) > 255)) return false;
      const first = Number(octets[0]);
      return first !== 0 && first < 224 && !(first === 169 && Number(octets[1]) === 254);
    }
    return value.split('.').every(label => label.length <= 63 && !label.startsWith('-') && !label.endsWith('-'));
  });
export const SshUserSchema = z.string().regex(/^[a-z_][a-z0-9_-]{0,31}$/).refine(value => value !== 'root');
export const SshHostKeySchema = z.string().max(8192).regex(/^(ssh-ed25519|ecdsa-sha2-nistp256|ssh-rsa) [A-Za-z0-9+/]+={0,2}$/);
export const DeployBasePathSchema = z.string().max(255).regex(/^\/(?:srv|home|var\/www)\/[a-zA-Z0-9_-]+(?:\/[a-zA-Z0-9_-]+)*$/);
export const SshPrivateKeySchema = z.string().max(32768).regex(/^-----BEGIN (?:(?:OPENSSH|RSA|EC) )?PRIVATE KEY-----[\s\S]+-----END (?:(?:OPENSSH|RSA|EC) )?PRIVATE KEY-----\s*$/);
const targetFields = {
  name: z.string().trim().min(1).max(150), host: SshHostSchema, port: z.number().int().min(1).max(65535).default(22),
  username: SshUserSchema, hostKey: SshHostKeySchema, basePath: DeployBasePathSchema,
  retention: z.number().int().min(1).max(50).default(5),
};
export const DeployTargetCreateSchema = z.strictObject({ ...targetFields, privateKey: SshPrivateKeySchema });
export const DeployTargetUpdateSchema = z.strictObject({ ...targetFields, privateKey: SshPrivateKeySchema.optional() });
export type DeployTargetCreate = z.infer<typeof DeployTargetCreateSchema>;
export type DeployTargetUpdate = z.infer<typeof DeployTargetUpdateSchema>;
export const DeployCreateSchema = z.strictObject({ buildId: BuildIdSchema, deployTargetId: BuildIdSchema });
export const DEPLOY_QUEUE_NAME = 'deployments';
export const DEPLOY_JOB_NAME = 'deploy';
export const DeployJobPayloadSchema = z.strictObject({ deploymentId: BuildIdSchema });
export type DeployJobPayload = z.infer<typeof DeployJobPayloadSchema>;
export const DeployLogEventSchema = z.strictObject({ deploymentId: BuildIdSchema, seq: z.number().int().min(1),
  stream: BuildLogStreamSchema, content: BuildLogContentSchema, ts: z.iso.datetime() });
export type DeployLogEvent = z.infer<typeof DeployLogEventSchema>;
export const DeployStreamStatusSchema = z.strictObject({ deployment: DeploymentSchema });
/** Future image adapter must resolve an immutable image digest; B12 accepts static artifacts only. */
export type DeployArtifact = { kind: 'static'; key: string; sha256: string } | { kind: 'image'; digest: string };
export const deployIsActive = (status: string) => status === 'pending' || status === 'running';
export const EmptyDeployRequestSchema = z.strictObject({});
export const DeployStreamEndSchema = z.strictObject({ deploymentId: BuildIdSchema,
  status: DeploymentSchema.shape.status.exclude(['pending', 'running']), lastSeq: z.number().int().min(0) });
export type DeployStreamEnd = z.infer<typeof DeployStreamEndSchema>;
