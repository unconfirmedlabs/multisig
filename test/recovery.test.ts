import { test, expect } from 'bun:test';
import { Effect, Layer, Cause, Option } from 'effect';
import { Store, writeNew } from '../src/store.ts';
import { Hardware } from '../src/hardware.ts';
import { Chain } from '../src/chain.ts';
import { parse, runCommand } from '../src/cli.ts';
import { fixtureProposal, c } from './domain.test.ts';
import { p256 } from '@noble/curves/nist.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';

function failure(exit: any) {
  expect(exit._tag).toBe('Failure');
  const result = Cause.failureOption(exit.cause);
  expect(Option.isSome(result)).toBe(true);
  return Option.getOrThrow(result) as any;
}
const noChain = Layer.succeed(Chain, {
  client: () => {
    throw Error('Unexpected network call');
  },
});
test('post-generation receipt failure reports applied outcome and recoverable public key', async () => {
  const layers = Layer.mergeAll(
    noChain,
    Layer.succeed(Store, {
      root: '/unused',
      get: async () => {
        throw Error('Unexpected read');
      },
      list: async () => [],
      put: async (collection) => {
        if (collection === 'operation-results') throw Error('disk full');
      },
    }),
    Layer.succeed(Hardware, {
      call: async (request) =>
        request.op === 'inspect'
          ? { empty: true }
          : {
              serial: 123,
              slot: '9c',
              algorithm: 0x11,
              pinPolicy: 3,
              touchPolicy: 2,
              publicKeyHex: bytesToHex(p256.getPublicKey(new Uint8Array(32).fill(3), false)),
            },
    }),
  );
  const command = parse([
    'key',
    'generate',
    '--device',
    '123',
    '--slot',
    '9c',
    '--factory-management-key',
    '--yes',
    '--non-interactive',
  ]);
  const result = failure(
    await Effect.runPromiseExit(runCommand(command).pipe(Effect.provide(layers))),
  );
  expect(result.code).toBe('KEY_GENERATED_PERSISTENCE_FAILED');
  expect(result.exit).toBe(5);
  expect(result.details.outcome).toBe('applied');
  expect(result.details.reference.address).toBe(c.toSuiAddress());
});
test('native proposal import cannot replace an existing chain pin', async () => {
  const p = await fixtureProposal();
  const path = join(tmpdir(), `multisig-pin-${randomUUID()}.json`);
  await writeNew(path, p);
  let writes = 0;
  const layers = Layer.mergeAll(
    Layer.succeed(Store, {
      root: '/unused',
      get: async () => {
        throw Error('Unexpected read');
      },
      list: async () => [],
      put: async () => {
        writes++;
      },
    }),
    Layer.succeed(Hardware, {
      call: async () => {
        throw Error('Unexpected hardware call');
      },
    }),
    Layer.succeed(Chain, {
      client: () =>
        ({ getChainIdentifier: async () => ({ chainIdentifier: 'different-chain' }) }) as any,
    }),
  );
  const command = parse([
    'proposal',
    'import',
    '--input',
    path,
    '--pin-chain',
    '--non-interactive',
  ]);
  const result = failure(
    await Effect.runPromiseExit(runCommand(command).pipe(Effect.provide(layers))),
  );
  expect(result.code).toBe('CHAIN_MISMATCH');
  expect(writes).toBe(0);
  await Bun.file(path).delete();
});
