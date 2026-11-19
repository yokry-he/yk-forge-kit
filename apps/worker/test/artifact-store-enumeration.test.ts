import { createHash, randomUUID } from 'node:crypto';
import type { Dir } from 'node:fs';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LocalFsArtifactStore } from '../src/artifact-store';

vi.mock('node:fs/promises', async (importOriginal) => ({
  ...await importOriginal<typeof import('node:fs/promises')>(),
}));

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

describe('bounded artifact directory enumeration', () => {
  it.each(['root', 'nested'])('stops reading an oversized %s directory at the shared entry limit', async (location) => {
    const root = await fs.mkdtemp(join(tmpdir(), 'forgekit-artifact-enumeration-')); roots.push(root);
    const source = join(root, 'source'); await fs.mkdir(source);
    const directory = location === 'nested' ? join(source, 'nested') : source;
    if (location === 'nested') await fs.mkdir(directory);
    for (let index = 0; index < 20; index++) await fs.writeFile(join(directory, `${index}.txt`), 'x');

    const opened: Array<{ path: string; handle: Dir; yielded: number }> = [];
    const opendir = fs.opendir;
    vi.spyOn(fs, 'opendir').mockImplementation(async (path) => {
      const handle = await opendir(path);
      const observed = { path: String(path), handle, yielded: 0 }; opened.push(observed);
      const iterator = handle[Symbol.asyncIterator].bind(handle);
      vi.spyOn(handle, Symbol.asyncIterator).mockImplementation(async function* () {
        for await (const entry of iterator()) { observed.yielded++; yield entry; }
      });
      return handle;
    });
    const readdir = vi.spyOn(fs, 'readdir');
    const id = randomUUID();
    const store = new LocalFsArtifactStore(join(root, 'store'), 100, 3);
    await expect(store.put(id, source, new AbortController().signal)).rejects.toThrow('artifact_entry_limit');

    // The first over-budget entry stops enumeration, including across directory levels.
    expect(opened.map(({ path, yielded }) => [path, yielded])).toEqual(location === 'nested'
      ? [[source, 1], [directory, 3]] : [[source, 4]]);
    expect(readdir).not.toHaveBeenCalled();
    for (const { handle } of opened) await expect(handle.read()).rejects.toMatchObject({ code: 'ERR_DIR_CLOSED' });
    expect(await fs.readdir(join(root, 'store', id))).toEqual([]);
  });

  it('accepts exactly the entry budget and preserves the sorted manifest digest', async () => {
    const root = await fs.mkdtemp(join(tmpdir(), 'forgekit-artifact-enumeration-')); roots.push(root);
    const source = join(root, 'source'); await fs.mkdir(source);
    await fs.writeFile(join(source, 'z.txt'), 'last');
    await fs.mkdir(join(source, 'a'));
    await fs.writeFile(join(source, 'a/first.txt'), 'first');
    const store = new LocalFsArtifactStore(join(root, 'store'), 100, 3);
    const saved = await store.put(randomUUID(), source, new AbortController().signal);
    const records = [['a/first.txt', 5, createHash('sha256').update('first').digest('hex')],
      ['z.txt', 4, createHash('sha256').update('last').digest('hex')]];
    const expected = createHash('sha256').update(records.map((record) => JSON.stringify(record) + '\n').join('')).digest('hex');
    expect(saved).toMatchObject({ size: 9, sha256: expected });
  });
});
