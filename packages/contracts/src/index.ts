/** Shared wire contracts, deliberately free of framework dependencies. */
export interface HealthResponse {
  status: 'ok';
  service: 'forgekit-api';
  timestamp: string;
}

export interface ProjectSummary {
  id: string;
  name: string;
  targets: Array<'web' | 'h5' | 'mobile' | 'miniapp' | 'desktop'>;
}

/** Metadata persisted by the project registry; it does not imply source files were generated. */
export interface ProjectRecord {
  id: string;
  slug: string;
  name: string;
  /** Template ID from the @forgekit/project-core registry, e.g. 'vue-web'. */
  template: string;
  features: Array<'theme' | 'router' | 'pinia'>;
  createdAt: string;
}

export interface ProjectAssetRecord {
  id: number;
  projectId: string;
  assetId: string;
  version: string;
  status: 'planned' | 'applied';
  createdAt: string;
}

export interface ProjectMemberRecord {
  userId: string;
  displayName: string;
  role: 'owner' | 'editor' | 'viewer';
  joinedAt: string;
}

export interface ProjectMembersResponse {
  members: ProjectMemberRecord[];
  currentUserId: string | null;
  currentRole: 'owner' | 'editor' | 'viewer' | null;
}

/** Unsigned local verification evidence, never sufficient to authorize a database status change. */
export interface AssetVerificationReceipt {
  schemaVersion: 1;
  kind: 'forgekit.asset-verification';
  project: string;
  assetId: string;
  assetVersion: string;
  files: Array<{ path: string; sha256: string }>;
  lockSha256: string;
  verifiedAt: string;
}

export function parseAssetVerificationReceipt(source: string): AssetVerificationReceipt {
  let parsed: unknown;
  try { parsed = JSON.parse(source); } catch { throw new Error('校验回执不是有效 JSON。'); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('回执必须是对象。');
  const value = parsed as Record<string, unknown>;
  const sha256 = (x: unknown) => typeof x === 'string' && /^[a-f0-9]{64}$/.test(x);
  if (value.schemaVersion !== 1 || value.kind !== 'forgekit.asset-verification' ||
    typeof value.project !== 'string' || !/^[a-z][a-z0-9-]{0,59}$/.test(value.project) ||
    typeof value.assetId !== 'string' || typeof value.assetVersion !== 'string' ||
    !sha256(value.lockSha256) || typeof value.verifiedAt !== 'string' ||
    !Number.isFinite(Date.parse(value.verifiedAt)) || !Array.isArray(value.files) || value.files.length === 0 || value.files.length > 100) {
    throw new Error('回执结构或字段格式无效。');
  }
  const paths = new Set<string>();
  for (const file of value.files) {
    if (!file || typeof file !== 'object' || typeof file.path !== 'string' ||
      !/^src\/(?:[\w.-]+\/)*[\w.-]+$/.test(file.path) || !sha256(file.sha256) || paths.has(file.path)) {
      throw new Error('回执文件摘要无效或重复。');
    }
    paths.add(file.path);
  }
  return parsed as AssetVerificationReceipt;
}

export const API_VERSION = 'v1' as const;
