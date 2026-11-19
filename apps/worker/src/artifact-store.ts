import { constants } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, open, opendir, rename, rm } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';

export interface ArtifactMetadata { key: string; size: number; sha256: string }
export interface ArtifactStore {
  put(buildId: string, directory: string, signal: AbortSignal): Promise<ArtifactMetadata>;
  open(key: string, relativePath: string): Promise<{ size: number; body: AsyncIterable<Uint8Array> }>;
  remove(key: string): Promise<void>;
}

/** Reject encoded separators too: callers must URL-decode once before this boundary. */
export function safeRelativePath(path: string): string[] {
  if (!path || isAbsolute(path) || /[\\\x00-\x1f%:]/.test(path) ||
      path.split('/').some((part) => !part || part === '.' || part === '..')) throw new Error('unsafe_artifact_path');
  return path.split('/');
}

/** Includes the root and all ancestors. Storage must be private to the trusted worker/gateway. */
export async function checkedPath(root: string, path: string, directory = false): Promise<string> {
  let current = resolve(root);
  const parts = safeRelativePath(path);
  for (const [index, part] of ['', ...parts].entries()) {
    if (part) current = join(current, part);
    const stat = await lstat(current);
    const isDirectory = index < parts.length || directory;
    if (stat.isSymbolicLink() || (isDirectory ? !stat.isDirectory() : !stat.isFile()) ||
        (!isDirectory && stat.nlink !== 1)) throw new Error('unsafe_artifact_entry');
  }
  return current;
}

/** Directory snapshots; digest = SHA-256 of sorted JSON [path, size, file-sha256] records + LF. */
export class LocalFsArtifactStore implements ArtifactStore {
  private readonly base: string;
  constructor(base: string, private readonly maxBytes = 100 * 1024 * 1024, private readonly maxEntries = 10000) {
    this.base = resolve(base);
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || !Number.isSafeInteger(maxEntries) || maxEntries < 1) {
      throw new Error('invalid_artifact_limits');
    }
  }
  private key(key: string): string {
    if (!/^[a-f0-9-]{36}\/[a-f0-9-]{36}$/.test(key)) throw new Error('unsafe_artifact_key');
    return key;
  }
  async put(buildId: string, directory: string, signal: AbortSignal): Promise<ArtifactMetadata> {
    if (!/^[a-f0-9-]{36}$/.test(buildId)) throw new Error('unsafe_build_id');
    signal.throwIfAborted();
    await mkdir(this.base, { recursive: true, mode: 0o700 });
    if (!(await lstat(this.base)).isDirectory() || (await lstat(this.base)).isSymbolicLink()) throw new Error('unsafe_artifact_root');
    const parent = join(this.base, buildId);
    await mkdir(parent, { recursive: true, mode: 0o700 });
    await checkedPath(this.base, buildId, true);
    const nonce = randomUUID();
    const staging = join(parent, `.staging-${nonce}`);
    const key = `${buildId}/${nonce}`;
    await mkdir(staging, { mode: 0o700 });
    let size = 0;
    let entries = 0;
    const records: Array<[string, number, string]> = [];
    const visit = async (relative: string, depth: number): Promise<void> => {
      signal.throwIfAborted();
      if (depth > 64 || ++entries > this.maxEntries) throw new Error('artifact_entry_limit');
      const source = await checkedPath(directory, relative, (await lstat(join(directory, relative))).isDirectory());
      const stat = await lstat(source);
      const target = join(staging, relative);
      if (stat.isDirectory()) {
        await mkdir(target, { mode: 0o700 });
        for await (const entry of await opendir(source)) await visit(`${relative}/${entry.name}`, depth + 1);
      } else {
        if (size + stat.size > this.maxBytes) throw new Error('artifact_size_limit');
        const input = await open(source, constants.O_RDONLY | constants.O_NOFOLLOW);
        const hash = createHash('sha256');
        let fileSize = 0;
        try {
          const output = await open(target, 'wx', 0o600);
          try {
            for await (const chunk of input.createReadStream()) {
              signal.throwIfAborted();
              size += chunk.length; fileSize += chunk.length;
              if (size > this.maxBytes) throw new Error('artifact_size_limit');
              hash.update(chunk);
              await output.writeFile(chunk);
            }
          } finally { await output.close(); }
        } finally { await input.close(); }
        records.push([relative, fileSize, hash.digest('hex')]);
      }
    };
    try {
      const rootStat = await lstat(directory);
      if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error('unsafe_artifact_root');
      // Stream names so the entry budget applies before an untrusted directory is buffered.
      for await (const entry of await opendir(directory)) await visit(entry.name, 0);
      signal.throwIfAborted();
      const manifest = createHash('sha256');
      for (const record of records.sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) {
        manifest.update(JSON.stringify(record) + '\n');
      }
      await rename(staging, join(this.base, key));
      return { key, size, sha256: manifest.digest('hex') };
    } catch (error) {
      await rm(staging, { recursive: true, force: true });
      throw error;
    }
  }
  async open(key: string, relativePath: string) {
    this.key(key);
    safeRelativePath(relativePath);
    const path = await checkedPath(this.base, `${key}/${relativePath}`);
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.nlink !== 1) throw new Error('unsafe_artifact_entry');
      return { size: stat.size, body: handle.createReadStream() };
    } catch (error) { await handle.close(); throw error; }
  }
  async remove(key: string): Promise<void> {
    this.key(key);
    const path = await checkedPath(this.base, key, true);
    await rm(path, { recursive: true });
  }
}
