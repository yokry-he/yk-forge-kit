import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readdir, rm, symlink, writeFile, link } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { LocalFsArtifactStore } from '../src/artifact-store';

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture(limit?: number) {
  const root = await mkdtemp(join(tmpdir(), 'forgekit-artifact-test-')); roots.push(root);
  const source = join(root, 'source'); await mkdir(source);
  await writeFile(join(source, 'index.html'), '<html>hello</html>');
  return { root, source, store: new LocalFsArtifactStore(join(root, 'store'), limit), signal: new AbortController().signal };
}
describe('local artifact snapshots', () => {
  it('copies independent immutable bytes, records stable digest and streams a file', async () => {
    const f = await fixture();
    const first = await f.store.put(randomUUID(), f.source, f.signal);
    const second = await f.store.put(randomUUID(), f.source, f.signal);
    expect(first.sha256).toBe(second.sha256);
    expect(first.sha256).toMatch(/^[a-f0-9]{64}$/);
    await writeFile(join(f.source, 'index.html'), 'changed');
    const file = await f.store.open(first.key, 'index.html');
    let body = ''; for await (const bytes of file.body) body += Buffer.from(bytes).toString();
    expect(file.size).toBe(Buffer.byteLength(body)); expect(first.size).toBe(file.size);
    expect(body).toBe('<html>hello</html>');
    await f.store.remove(first.key);
    await expect(f.store.open(first.key, 'index.html')).rejects.toThrow();
  });
  it.each(['../index.html', '/etc/passwd', 'x/../../etc/passwd', 'x\\..\\index.html', '%2e%2e/index.html', 'x//index.html', './index.html', 'x\0'])('rejects traversal %s', async (path) => {
    const f = await fixture(); const saved = await f.store.put(randomUUID(), f.source, f.signal);
    await expect(f.store.open(saved.key, path)).rejects.toThrow();
    await expect(f.store.open(path, 'index.html')).rejects.toThrow();
    await expect(f.store.remove(path)).rejects.toThrow();
  });
  it.each(['file', 'directory', 'root', 'hardlink'] as const)('rejects %s links while publishing', async (kind) => {
    const f = await fixture();
    let source = f.source;
    if (kind === 'root') { source = join(f.root, 'linked'); await symlink(f.source, source); }
    else if (kind === 'hardlink') await link(join(f.source, 'index.html'), join(f.source, 'linked'));
    else await symlink(kind === 'file' ? '/etc/passwd' : f.root, join(f.source, 'linked'));
    await expect(f.store.put(randomUUID(), source, f.signal)).rejects.toThrow('unsafe_artifact');
  });
  it('rejects links introduced into stored paths before reading', async () => {
    const f = await fixture(); const saved = await f.store.put(randomUUID(), f.source, f.signal);
    const path = join(f.root, 'store', saved.key, 'linked'); await symlink('/etc', path);
    await expect(f.store.open(saved.key, 'linked/passwd')).rejects.toThrow('unsafe_artifact');
  });
  it('rejects oversized artifacts and removes partial copies', async () => {
    const f = await fixture(2); const id = randomUUID();
    await expect(f.store.put(id, f.source, f.signal)).rejects.toThrow('artifact_size_limit');
    expect(await readdir(join(f.root, 'store', id))).toEqual([]);
  });
  it('honors cancellation and bounds entry count', async () => {
    const f = await fixture();
    await expect(f.store.put(randomUUID(), f.source, AbortSignal.abort())).rejects.toThrow();
    await writeFile(join(f.source, 'another'), 'x');
    await expect(new LocalFsArtifactStore(join(f.root, 'limited'), 100, 1).put(randomUUID(), f.source, f.signal))
      .rejects.toThrow('artifact_entry_limit');
  });
});
