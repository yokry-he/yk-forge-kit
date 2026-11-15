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
  template: 'vue-web';
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

export const API_VERSION = 'v1' as const;
