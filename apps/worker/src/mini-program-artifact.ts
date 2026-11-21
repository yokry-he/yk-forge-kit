import { createHash } from 'node:crypto';
import { mkdir, open, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { checkedPath, safeRelativePath, type LocalFsArtifactStore } from '@forgekit/artifact-store';
export async function materializeMiniProgram(store: Pick<LocalFsArtifactStore, 'list' | 'open'>, artifact: { key: string; sha256: string }, directory: string, signal: AbortSignal, platform: 'weapp' | 'alipay', required: readonly string[]) {
  let count = 0, total = 0;
  const records: Array<[string, number, string]> = [];
  for await (const path of store.list(artifact.key)) {
    signal.throwIfAborted(); safeRelativePath(path);
    if (++count > 10000 || path.split('/').some(part => part === 'node_modules')) throw new Error(`${platform}_artifact_entry_invalid`);
    const file = await store.open(artifact.key, path);
    const target = join(directory, path); await mkdir(dirname(target), { recursive: true, mode: 0o700 });
    const output = await open(target, 'wx', 0o600), hash = createHash('sha256'); let size = 0;
    try {
      for await (const chunk of file.body) {
        signal.throwIfAborted(); total += chunk.length; size += chunk.length;
        if (total > 104857600) throw new Error(`${platform}_artifact_size`);
        hash.update(chunk); await output.writeFile(chunk);
      }
    } finally { file.close?.(); await output.close(); }
    records.push([path, size, hash.digest('hex')]);
  }
  const digest = createHash('sha256');
  for (const row of records.sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) digest.update(JSON.stringify(row) + '\n');
  if (digest.digest('hex') !== artifact.sha256) throw new Error(`${platform}_artifact_integrity`);
  for (const path of required) await checkedPath(directory, path);
  const app = JSON.parse(await readFile(join(directory, 'app.json'), 'utf8')) as { pages?: unknown };
  if (!Array.isArray(app.pages) || !app.pages.length) throw new Error(`${platform}_app_invalid`);
}
