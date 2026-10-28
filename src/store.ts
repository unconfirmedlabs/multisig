import { Context, Layer } from 'effect';
// Node is used only for atomic/exclusive filesystem operations unavailable in Bun.
import { mkdir, open, link, unlink } from 'node:fs/promises';
import { join, dirname, resolve } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { CliError, assert } from './errors.ts';

export const MAX_INPUT = 4 * 1024 * 1024;
export async function readJson(path: string): Promise<unknown> {
  let text: string;
  if (path === '-') {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of Bun.stdin.stream()) {
      size += chunk.byteLength;
      assert(size <= MAX_INPUT, 'INPUT_TOO_LARGE', 'Input exceeds 4 MiB.');
      chunks.push(Buffer.from(chunk));
    }
    text = Buffer.concat(chunks).toString('utf8');
  } else {
    const file = Bun.file(path);
    assert(file.size <= MAX_INPUT, 'INPUT_TOO_LARGE', 'Input exceeds 4 MiB.');
    text = await file.text();
    assert(Buffer.byteLength(text) <= MAX_INPUT, 'INPUT_TOO_LARGE', 'Input exceeds 4 MiB.');
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new CliError({ code: 'INVALID_JSON', message: 'Expected UTF-8 JSON input.' });
  }
}
export async function writeNew(path: string, data: unknown) {
  const bytes = JSON.stringify(data, null, 2) + '\n';
  await mkdir(dirname(resolve(path)), { recursive: true, mode: 0o700 });
  const temp = `${resolve(path)}.${randomUUID()}.tmp`;
  const h = await open(temp, 'wx', 0o600);
  try {
    try {
      await h.writeFile(bytes);
      await h.sync();
    } finally {
      await h.close();
    }
    try {
      await link(temp, resolve(path));
    } catch (e: any) {
      if (e.code === 'EEXIST')
        throw new CliError({ code: 'FILE_EXISTS', message: `Refusing to overwrite ${path}.` });
      throw e;
    }
  } finally {
    await unlink(temp);
  }
}
function component(value: string) {
  assert(
    /^[A-Za-z0-9_-]{1,180}$/.test(value),
    'INVALID_ID',
    'Store identifiers must be plain names or digests.',
  );
  return value;
}
export class Store extends Context.Tag('multisig/Store')<
  Store,
  {
    root: string;
    get: (collection: string, id: string) => Promise<unknown>;
    put: (collection: string, id: string, data: unknown) => Promise<void>;
    list: (collection: string) => Promise<string[]>;
  }
>() {}
export function storeLayer(root = join(homedir(), '.local', 'share', 'multisig')) {
  const dir = resolve(root);
  function path(collection: string, id: string) {
    return join(dir, component(collection), `${component(id)}.json`);
  }
  return Layer.succeed(Store, {
    root: dir,
    get: (collection, id) => readJson(path(collection, id)),
    put: async (collection, id, data) => {
      try {
        await writeNew(path(collection, id), data);
      } catch (e) {
        if (e instanceof CliError && e.code === 'FILE_EXISTS') {
          const existing = await readJson(path(collection, id));
          assert(
            JSON.stringify(existing) === JSON.stringify(data),
            'STATE_CONFLICT',
            'An immutable record already exists with different content.',
          );
          return;
        }
        throw e;
      }
    },
    list: async (collection) => {
      try {
        const files = [];
        for await (const file of new Bun.Glob('*.json').scan({
          cwd: join(dir, component(collection)),
          onlyFiles: true,
        }))
          files.push(file.slice(0, -5));
        return files.sort();
      } catch (e: any) {
        if (e.code === 'ENOENT') return [];
        throw e;
      }
    },
  });
}
export async function withDeviceLock<A>(root: string, serial: number, f: () => Promise<A>) {
  const lockdir = join(root, 'locks');
  await mkdir(lockdir, { recursive: true, mode: 0o700 });
  const path = join(lockdir, `${serial}.lock`);
  let h;
  try {
    h = await open(path, 'wx', 0o600);
  } catch (e: any) {
    if (e.code !== 'EEXIST') throw e;
    throw new CliError({
      code: 'DEVICE_BUSY',
      message: `Device lock exists at ${path}. Check that no operation is running before removing a stale lock.`,
      exit: 3,
    });
  }
  try {
    await h.writeFile(JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }));
    return await f();
  } finally {
    await h.close();
    await unlink(path);
  }
}
