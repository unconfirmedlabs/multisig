import { test, expect } from 'bun:test';
import { p256 } from '@noble/curves/nist.js';
import { summarizeSlots, slotTable } from '../src/device-ui.ts';
import { PIV_SLOTS, type DeviceSlots } from '../src/slots.ts';
import { terminalText } from '../src/terminal.ts';
import { parse, runCommand } from '../src/cli.ts';
import { Effect, Layer, Cause, Option } from 'effect';
import { Store } from '../src/store.ts';
import { Hardware } from '../src/hardware.ts';
import { Chain } from '../src/chain.ts';

test('slot overview distinguishes empty, occupied, unknown and supported Sui keys', () => {
  expect(PIV_SLOTS).toHaveLength(24);
  expect(new Set(PIV_SLOTS.map((s) => s.slot)).size).toBe(24);
  const data: DeviceSlots = {
    serial: 123,
    firmware: '5.8.0',
    reader: 'YubiKey',
    slots: [
      {
        slot: '9a',
        name: 'Authentication',
        state: 'empty',
        empty: true,
        certificatePresent: false,
      },
      {
        slot: '9c',
        name: 'Digital signature',
        state: 'occupied',
        empty: false,
        algorithm: 0x11,
        publicKeyHex: Buffer.from(p256.getPublicKey(new Uint8Array(32).fill(3), false)).toString(
          'hex',
        ),
        pinPolicy: 3,
        touchPolicy: 2,
        certificatePresent: false,
      },
      {
        slot: '9d',
        name: 'Key management',
        state: 'occupied',
        algorithm: 0x14,
        certificatePresent: true,
      },
      {
        slot: '9e',
        name: 'Card authentication',
        state: 'unknown',
        error: { code: 'PIV_ERROR', message: 'Unreadable' },
      },
    ],
  };
  const view = summarizeSlots(data);
  expect(view.slots[1]!.keyId).toBe('123_9c');
  expect(view.slots[1]!.suiAddress).toStartWith('0x');
  expect(view.slots[0]!.suiAddress).toBeNull();
  expect(view.slots[2]!.suiAddress).toBeNull();
  expect(view.slots[3]!.state).toBe('unknown');
  const table = slotTable(view);
  expect(table).toContain('occupied');
  expect(table).toContain('unknown');
  expect(table).toContain('P-256');
  expect(terminalText('device\u001b[2J\nspoof')).toBe('device\\u001b[2J\\u000aspoof');
});

test('interactive entry points fail before device initialization in noninteractive mode', async () => {
  let calls = 0;
  const layers = Layer.mergeAll(
    Layer.succeed(Store, {
      root: '/unused',
      get: async () => {},
      put: async () => {},
      list: async () => [],
    }),
    Layer.succeed(Hardware, {
      call: async () => {
        calls++;
        throw Error('Unexpected hardware call');
      },
    }),
    Layer.succeed(Chain, {
      client: () => {
        throw Error('Unexpected network call');
      },
    }),
  );
  for (const args of [
    ['key', 'address', '--non-interactive'],
    ['device', 'slots', '--non-interactive'],
    ['--non-interactive'],
  ]) {
    const exit = await Effect.runPromiseExit(runCommand(parse(args)).pipe(Effect.provide(layers)));
    expect(exit._tag).toBe('Failure');
    if (exit._tag === 'Failure') {
      const e = Option.getOrThrow(Cause.failureOption(exit.cause));
      expect(['INTERACTIVE_REQUIRED', 'DEVICE_REQUIRED']).toContain(e.code);
    }
  }
  expect(calls).toBe(0);
});
