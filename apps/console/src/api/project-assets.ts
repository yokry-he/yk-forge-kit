import type { ProjectAssetRecord } from '@forgekit/contracts';
import { projectRequest } from './projects';

export function listProjectAssets(slug: string): Promise<ProjectAssetRecord[]> {
  return projectRequest<ProjectAssetRecord[]>(`/${encodeURIComponent(slug)}/assets`);
}

export function planProjectAsset(slug: string, assetId: string): Promise<ProjectAssetRecord> {
  return projectRequest<ProjectAssetRecord>(`/${encodeURIComponent(slug)}/assets`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ assetId }),
  });
}

/** Server metadata CAS only; no local source code is changed. */
export function upgradeProjectAssetPlan(slug: string, assetId: string, expectedVersion: string): Promise<ProjectAssetRecord> {
  return projectRequest<ProjectAssetRecord>(`/${encodeURIComponent(slug)}/assets/${encodeURIComponent(assetId)}/plan`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ expectedVersion }),
  });
}
