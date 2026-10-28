import { test, expect } from 'bun:test';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { Effect } from 'effect';
import { storeLayer, Store, writeNew } from '../src/store.ts';
import { parse } from '../src/cli.ts';
import { fixtureProposal, signed, a, c } from './domain.test.ts';

const entry = join(import.meta.dir, '../src/main.ts');
async function cli(args: string[]) {
  const proc = Bun.spawn([process.execPath, entry, ...args], {
    stdout: 'pipe',
    stderr: 'pipe',
    stdin: 'ignore',
  });
  return {
    code: await proc.exited,
    out: await new Response(proc.stdout).text(),
    err: await new Response(proc.stderr).text(),
  };
}
test('strict arguments and pipes have stable output without network/hardware initialization', async () => {
  expect(() => parse(['wallet', 'show', '--wallet', 'x', '--pin-fd', '3'])).toThrow();
  expect(() => parse(['wallet', 'show', '--wallet', 'x', '--wallet', 'y'])).toThrow();
  const help = await cli(['--help']);
  expect(help.code).toBe(0);
  expect(help.err).toBe('');
  expect(help.out).toContain('key generate');
  const bad = await cli(['--not-a-flag']);
  expect(bad.code).toBe(2);
  expect(bad.out).toBe('');
  expect(JSON.parse(bad.err).error.code).toBe('USAGE');
});
test('atomic no-overwrite protects existing files', async () => {
  const file = join(tmpdir(), `multisig-${randomUUID()}.json`);
  await writeNew(file, { value: 1 });
  await expect(writeNew(file, { value: 2 })).rejects.toThrow();
  expect(await Bun.file(file).json()).toEqual({ value: 1 });
  await Bun.file(file).delete();
});
test('two concurrent signature imports retain both members and combine through the CLI', async () => {
  const dir = join(tmpdir(), `multisig-test-${randomUUID()}`);
  const p = await fixtureProposal();
  const proposal = join(dir, 'proposal.json'),
    sa = join(dir, 'a.json'),
    sc = join(dir, 'c.json');
  await writeNew(proposal, p);
  await writeNew(sa, await signed(p, a));
  await writeNew(sc, await signed(p, c));
  const common = ['--data-dir', dir, '--json', '--non-interactive'];
  const imported = await Promise.all([
    cli(['proposal', 'signature-import', '--proposal', proposal, '--input', sa, ...common]),
    cli(['proposal', 'signature-import', '--proposal', proposal, '--input', sc, ...common]),
  ]);
  expect(imported.map((r) => r.code)).toEqual([0, 0]);
  const combined = await cli(['proposal', 'combine', '--proposal', proposal, ...common]);
  expect(combined.code).toBe(0);
  expect(JSON.parse(combined.out).currentWeight).toBe(2);
  const invalid = await cli([
    'proposal',
    'sign',
    '--proposal',
    proposal,
    '--key',
    'missing',
    ...common,
  ]);
  expect(invalid.out).toBe('');
  expect(invalid.code).not.toBe(0);
});
