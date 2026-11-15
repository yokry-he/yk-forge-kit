export type AssetId = 'official.theme';
export type AssetTarget = 'vue-web';

export interface AssetManifest {
  id: AssetId;
  version: string;
  name: string;
  description: string;
  target: AssetTarget[];
  dependencies: AssetId[];
  provides: string[];
}

export interface AssetLock {
  schemaVersion: 1;
  assets: Record<string, { version: string; files: Record<string, string> }>;
}

export interface AssetChange {
  path: string;
  action: 'create' | 'modify';
  before: string | null;
  after: string;
}

export interface AssetInstallPlan {
  asset: AssetManifest;
  changes: AssetChange[];
  lock: AssetLock;
  alreadyInstalled: boolean;
}

export class AssetError extends Error {
  constructor(message: string) { super(message); this.name = 'AssetError'; }
}

const THEME: AssetManifest = {
  id: 'official.theme',
  version: '1.0.0',
  name: '主题系统',
  description: '为 Vue 项目安装语义化颜色 Token 和深色主题样式。',
  target: ['vue-web'],
  dependencies: [],
  provides: ['theme-tokens'],
};
const BUILT_INS: Readonly<Record<AssetId, AssetManifest>> = { 'official.theme': THEME };

export function listAssets(): AssetManifest[] {
  return Object.values(BUILT_INS).map((item) => ({ ...item, dependencies: [...item.dependencies], target: [...item.target], provides: [...item.provides] }));
}

export function resolveAssets(ids: string[], target: AssetTarget): AssetManifest[] {
  const order: AssetManifest[] = [];
  const visiting = new Set<string>();
  const visited = new Set<string>();
  function visit(id: string): void {
    if (visited.has(id)) return;
    if (visiting.has(id)) throw new AssetError(`资产依赖存在环：${id}`);
    const asset = BUILT_INS[id as AssetId];
    if (!asset) throw new AssetError(`未知资产：${id}`);
    if (!asset.target.includes(target)) throw new AssetError(`资产不支持目标平台：${id} → ${target}`);
    visiting.add(id);
    for (const dependency of asset.dependencies) visit(dependency);
    visiting.delete(id);
    visited.add(id);
    order.push(asset);
  }
  ids.forEach(visit);
  return order;
}

export function emptyAssetLock(): AssetLock { return { schemaVersion: 1, assets: {} }; }

export function parseAssetLock(source: string | null): AssetLock {
  if (source === null) return emptyAssetLock();
  let value: unknown;
  try { value = JSON.parse(source); } catch { throw new AssetError('资产锁文件不是有效 JSON。'); }
  if (!value || typeof value !== 'object') throw new AssetError('无效的资产锁文件。');
  const lock = value as Record<string, unknown>;
  if (lock.schemaVersion !== 1 || !lock.assets || typeof lock.assets !== 'object' || Array.isArray(lock.assets)) {
    throw new AssetError('不支持的资产锁文件格式。');
  }
  for (const entry of Object.values(lock.assets as Record<string, unknown>)) {
    if (!entry || typeof entry !== 'object') throw new AssetError('资产锁文件记录无效。');
    const asset = entry as Record<string, unknown>;
    if (typeof asset.version !== 'string' || !asset.files || typeof asset.files !== 'object' || Array.isArray(asset.files)) {
      throw new AssetError('资产锁文件记录无效。');
    }
    if (Object.entries(asset.files as Record<string, unknown>).some(([path, hash]) => !path || typeof hash !== 'string')) {
      throw new AssetError('资产锁文件的文件摘要无效。');
    }
  }
  return value as AssetLock;
}

// Non-cryptographic deterministic fingerprint for local drift detection.
// A later registry protocol may add SHA-256 signatures; this is not a security signature.
export function fingerprint(content: string): string {
  let hash = 2166136261;
  for (let i = 0; i < content.length; i++) {
    hash ^= content.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

const themeCss = `:root {
  --fk-bg: #09090b;
  --fk-surface: #18181b;
  --fk-text: #fafafa;
  --fk-muted: #a1a1aa;
  --fk-brand: #8b5cf6;
  --fk-accent: #22d3ee;
}
`;
const themeImport = "@import './forgekit/theme.css';\n";

/** This planner is pure: the CLI applies changes only after preflight checks. */
export function planAssetInstall(
  assetId: string,
  target: AssetTarget,
  files: Record<string, string | null>,
  lock: AssetLock,
): AssetInstallPlan {
  const [asset] = resolveAssets([assetId], target);
  if (!asset) throw new AssetError('未找到资产。');
  const installed = lock.assets[asset.id];
  if (installed) {
    if (installed.version !== asset.version) throw new AssetError('检测到其他资产版本，请使用未来的显式升级流程。');
    for (const [path, hash] of Object.entries(installed.files)) {
      if (files[path] === null || files[path] === undefined || fingerprint(files[path]) !== hash) {
        throw new AssetError(`已安装资产文件被修改：${path}；请手动处理，避免覆盖用户代码。`);
      }
    }
    return { asset, changes: [], lock, alreadyInstalled: true };
  }
  if (asset.id !== 'official.theme') throw new AssetError('当前暂无该资产的安装器。');
  const originalStyle = files['src/style.css'];
  if (originalStyle === null || originalStyle === undefined) throw new AssetError('未找到 src/style.css，请先选择兼容的 Vue 项目。');
  if (files['src/forgekit/theme.css'] !== null && files['src/forgekit/theme.css'] !== undefined) {
    throw new AssetError('主题文件已存在，拒绝覆盖。');
  }
  if (originalStyle.includes(themeImport.trim())) throw new AssetError('检测到主题导入已存在，但锁文件缺失，请人工确认。');
  const changes: AssetChange[] = [
    { path: 'src/forgekit/theme.css', action: 'create', before: null, after: themeCss },
    { path: 'src/style.css', action: 'modify', before: originalStyle, after: themeImport + originalStyle },
  ];
  const newLock: AssetLock = {
    schemaVersion: 1,
    assets: { ...lock.assets, [asset.id]: { version: asset.version, files: Object.fromEntries(changes.map((item) => [item.path, fingerprint(item.after)])) } },
  };
  return { asset, changes, lock: newLock, alreadyInstalled: false };
}
