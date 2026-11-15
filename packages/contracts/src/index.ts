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

export const API_VERSION = 'v1' as const;
