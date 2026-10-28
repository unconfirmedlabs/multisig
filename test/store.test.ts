import { expect, test } from 'bun:test';
import { mkdtemp, readdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { withDeviceLock, writeNew } from '../src/store.ts';

test('concurrent exclusive writes publish one complete private record without leftover files', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'multisig-store-'));
  try {
    const path = join(dir, 'record.json');
    const results = await Promise.allSettled([
      writeNew(path, { value: 'first' }),
      writeNew(path, { value: 'second' }),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find((result) => result.status === 'rejected');
    expect(rejected?.reason.code).toBe('FILE_EXISTS');
    expect(['first', 'second']).toContain((await Bun.file(path).json()).value);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect(await readdir(dir)).toEqual(['record.json']);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('device lock prevents competing operations and releases after failure', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'multisig-lock-'));
  try {
    await expect(
      withDeviceLock(dir, 123, async () => {
        await expect(
          withDeviceLock(dir, 123, async () => {
            throw new Error('Competing operation must not run');
          }),
        ).rejects.toMatchObject({ code: 'DEVICE_BUSY' });
        throw new Error('Device operation failed');
      }),
    ).rejects.toThrow('Device operation failed');
    expect(await withDeviceLock(dir, 123, async () => 'recovered')).toBe('recovered');
    expect(await readdir(join(dir, 'locks'))).toEqual([]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
