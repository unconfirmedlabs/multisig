import { parseArgs } from 'node:util';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { Effect, Layer } from 'effect';
import { verifyPersonalMessageSignature } from '@mysten/sui/verify';
import { Transaction } from '@mysten/sui/transactions';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { assert, attempt, CliError } from './errors.ts';
import { Store, storeLayer, readJson, writeNew } from './store.ts';
import { Hardware, hardwareLayer, keyReference, PivSigner } from './hardware.ts';
import {
  Chain,
  ChainLive,
  endpoints,
  checkChain,
  buildProposal,
  simulate,
  executeExact,
} from './chain.ts';
import {
  NETWORKS,
  address,
  base64,
  parseKey,
  parseWallet,
  parseProposal,
  createWallet,
  createProposal,
  publicKey,
  tally,
  combine,
  verifyMemberSignature,
  record,
  type Proposal,
  type Signature,
  type Network,
  type Wallet,
  type KeyRef,
} from './domain.ts';
import { secret } from './secrets.ts';
import { importProposal, exportProposal, exportWallet, SagatClient, messages } from './sagat.ts';
import { Terminal } from './terminal.ts';
import { getSlots, pickAddress, selectDevice, slotTable, type SlotOverview } from './device-ui.ts';
import {
  getAliases,
  buildAliasTransaction,
  signAliasTransaction,
  executeAliasTransaction,
  verifyAccountSignature,
} from './aliases.ts';

const globals = [
  'json',
  'non-interactive',
  'data-dir',
  'network',
  'rpc-url',
  'library',
  'output',
  'yes',
  'help',
  'version',
];
const booleanOptions = [
  'json',
  'non-interactive',
  'yes',
  'help',
  'version',
  'sagat',
  'pin-chain',
  'allow-unverified-network',
  'factory-management-key',
];
const repeatedOptions = ['signature', 'object'];
const stringOptions = [
  'data-dir',
  'network',
  'rpc-url',
  'library',
  'output',
  'input',
  'device',
  'slot',
  'key',
  'pin-fd',
  'management-key-fd',
  'members',
  'threshold',
  'name',
  'wallet',
  'proposal',
  'recipient',
  'amount',
  'coin-type',
  'gas-budget',
  'description',
  'message',
  'public-key',
  'address',
  'cursor',
  'limit',
  'digest',
  'api-url',
  'token-fd',
  'id',
  'proposer',
  'alias',
  'status',
];
const commandFlags: Record<string, string[]> = {
  ui: [],
  doctor: [],
  'device list': [],
  'device slots': ['device'],
  'device inspect': ['device', 'slot'],
  'key generate': ['device', 'slot', 'management-key-fd', 'factory-management-key'],
  'key export': ['device', 'slot'],
  'key address': ['key', 'device', 'slot'],
  'wallet create': ['members', 'threshold', 'name'],
  'wallet import': ['input'],
  'wallet export': ['wallet', 'sagat'],
  'wallet list': [],
  'wallet show': ['wallet'],
  balance: ['wallet', 'address', 'cursor', 'limit'],
  objects: ['wallet', 'address', 'cursor', 'limit'],
  'tx build-sui': ['wallet', 'recipient', 'amount', 'gas-budget', 'description'],
  'tx build-coin': ['wallet', 'recipient', 'amount', 'coin-type', 'gas-budget', 'description'],
  'tx build-object': ['wallet', 'recipient', 'object', 'gas-budget', 'description'],
  'tx build-json': ['wallet', 'input', 'gas-budget', 'description'],
  'tx import': ['wallet', 'input', 'pin-chain', 'description'],
  'tx inspect': ['proposal'],
  'tx simulate': ['proposal', 'allow-unverified-network'],
  'proposal create': ['wallet', 'input', 'pin-chain', 'description'],
  'proposal import': ['input', 'pin-chain'],
  'proposal list': [],
  'proposal show': ['proposal'],
  'proposal export': ['proposal', 'sagat'],
  'proposal sign': ['proposal', 'key', 'pin-fd', 'allow-unverified-network'],
  'proposal signature-import': ['proposal', 'input'],
  'proposal combine': ['proposal', 'signature'],
  'proposal execute': ['proposal', 'signature', 'allow-unverified-network'],
  'proposal status': ['proposal', 'allow-unverified-network'],
  'proposal cancel': ['proposal'],
  'message sign': ['key', 'message', 'input', 'pin-fd'],
  'message verify': ['message', 'input', 'signature', 'public-key'],
  'alias show': ['address'],
  'alias enable': ['key', 'address', 'pin-fd'],
  'alias add': ['key', 'address', 'alias', 'pin-fd'],
  'alias remove': ['key', 'address', 'alias', 'pin-fd'],
  'alias transfer-sui': ['key', 'address', 'recipient', 'amount', 'pin-fd'],
  'sagat login': ['key', 'pin-fd', 'api-url'],
  'sagat wallets': ['api-url', 'token-fd'],
  'sagat wallet-create': ['api-url', 'token-fd', 'wallet'],
  'sagat wallet-show': ['api-url', 'token-fd', 'wallet'],
  'sagat invitations': ['api-url', 'token-fd', 'key'],
  'sagat accept': ['api-url', 'token-fd', 'wallet', 'key', 'pin-fd'],
  'sagat reject': ['api-url', 'token-fd', 'wallet', 'key', 'pin-fd'],
  'sagat proposals': ['api-url', 'token-fd', 'wallet', 'status', 'cursor', 'limit'],
  'sagat proposal-get': ['api-url', 'digest', 'pin-chain'],
  'sagat propose': ['api-url', 'proposal', 'key', 'pin-fd', 'allow-unverified-network'],
  'sagat vote': ['api-url', 'id', 'proposal', 'signature'],
  'sagat cancel': ['api-url', 'id', 'key', 'pin-fd'],
  'sagat verify': ['api-url', 'digest'],
  'sagat add-proposer': ['api-url', 'token-fd', 'wallet', 'key', 'pin-fd', 'proposer'],
  'sagat remove-proposer': ['api-url', 'token-fd', 'wallet', 'key', 'pin-fd', 'proposer'],
};
export interface Parsed {
  command: string;
  flags: Record<string, string | boolean | string[] | undefined>;
}
export function parse(argv: string[]): Parsed {
  const options: Record<string, { type: 'string' | 'boolean'; multiple?: boolean }> = {};
  for (const name of booleanOptions) options[name] = { type: 'boolean' };
  for (const name of stringOptions) options[name] = { type: 'string' };
  for (const name of repeatedOptions) options[name] = { type: 'string', multiple: true };
  let parsed;
  try {
    parsed = parseArgs({ args: argv, options, allowPositionals: true, strict: true, tokens: true });
  } catch (e) {
    throw new CliError({
      code: 'USAGE',
      message: e instanceof Error ? e.message : 'Invalid arguments.',
      exit: 2,
    });
  }
  const command =
    parsed.positionals.join(' ') || (parsed.values.help || parsed.values.version ? '' : 'ui');
  if (!parsed.values.help && !parsed.values.version) {
    assert(
      command in commandFlags,
      'USAGE',
      `Unknown command ${JSON.stringify(command)}. Use --help.`,
    );
    const allowed = new Set([...globals, ...commandFlags[command]!]);
    const counts = new Map<string, number>();
    for (const token of parsed.tokens)
      if (token.kind === 'option') {
        assert(allowed.has(token.name), 'USAGE', `--${token.name} is not valid for ${command}.`);
        counts.set(token.name, (counts.get(token.name) ?? 0) + 1);
        assert(
          repeatedOptions.includes(token.name) || counts.get(token.name) === 1,
          'USAGE',
          `--${token.name} may appear only once.`,
        );
      }
  }
  return { command, flags: parsed.values as Parsed['flags'] };
}
export function help(command = '') {
  const list = command in commandFlags ? { [command]: commandFlags[command] } : commandFlags;
  return `multisig 0.1.0 — native Sui multisigs with YubiKey PIV\n\nUsage: multisig <command> [options]\n\n${Object.entries(
    list,
  )
    .map(
      ([name, flags]) =>
        `  ${name}${flags!.length ? '  ' + flags!.map((f) => '--' + f).join(' ') : ''}`,
    )
    .join(
      '\n',
    )}\n\nGlobal: --json --non-interactive --data-dir DIR --network NETWORK --rpc-url URL\n        --output FILE --yes --library ABSOLUTE_PATH --help --version\n\nJSON data on stdout; structured errors/progress on stderr. Files are never overwritten.\nUse '-' for JSON stdin. Amounts are integer base units (MIST for SUI).\nMutations/signing require --yes in non-interactive mode. --yes never bypasses a PIN or touch.\nCredentials: --pin-fd N, --management-key-fd N, --token-fd N; never put a secret in argv.\nNetwork defaults to testnet for construction; proposals retain their own network.\nKey generation requires explicit --device and --slot; occupied slots are rejected.\nSee README.md for complete workflows and docs/cli-contract.md for error/exit contracts.\n`;
}
const str = (p: Parsed, name: string) => p.flags[name] as string | undefined;
function required(p: Parsed, name: string) {
  const value = str(p, name);
  assert(value !== undefined && value.length > 0, 'USAGE', `--${name} is required.`);
  return value;
}
function number(p: Parsed, name: string, fallback?: number) {
  const text = str(p, name);
  if (text === undefined && fallback !== undefined) return fallback;
  assert(
    text !== undefined && /^(0|[1-9][0-9]*)$/.test(text),
    'USAGE',
    `--${name} must be an integer.`,
  );
  const value = Number(text);
  assert(Number.isSafeInteger(value), 'USAGE', `--${name} is outside the safe integer range.`);
  return value;
}
function fd(p: Parsed, name: string) {
  const value = str(p, name);
  if (value === undefined) return undefined;
  const n = number(p, name);
  assert(n >= 3, 'USAGE', 'Use a dedicated credential FD >= 3; stdin/stdout/stderr are reserved.');
  return n;
}
const interactive = (p: Parsed) =>
  !p.flags['non-interactive'] && !!process.stdin.isTTY && !!process.stderr.isTTY;
async function acknowledge(p: Parsed, prompt: string) {
  if (p.flags.yes) return;
  assert(
    interactive(p),
    'CONFIRMATION_REQUIRED',
    'Review the input, then pass --yes to explicitly authorize this operation.',
  );
  const reply = secret(`${prompt} Type yes to continue: `, undefined, true);
  try {
    assert(reply.toString() === 'yes', 'CANCELLED', 'Operation cancelled.');
  } finally {
    reply.fill(0);
  }
}
function network(p: Parsed, proposal?: Proposal): Network {
  const value = str(p, 'network') ?? proposal?.network ?? 'testnet';
  assert(
    NETWORKS.includes(value as Network),
    'INVALID_NETWORK',
    'Choose mainnet, testnet, devnet, or localnet.',
  );
  if (proposal)
    assert(
      value === proposal.network,
      'NETWORK_MISMATCH',
      'The requested network differs from the immutable proposal.',
    );
  return value as Network;
}
function stamp() {
  return new Date().toISOString();
}
function signatureId(p: Proposal, s: Signature) {
  return `${p.id}_${bytesToHex(sha256(new TextEncoder().encode(s.publicKey)))}`;
}
async function load(source: string, collection: string, store: typeof Store.Service) {
  return (await Bun.file(source).exists()) || source === '-'
    ? readJson(source)
    : store.get(collection, source);
}
async function wallet(p: Parsed, store: typeof Store.Service) {
  return parseWallet(await load(required(p, 'wallet'), 'wallets', store));
}
async function proposal(p: Parsed, store: typeof Store.Service) {
  return parseProposal(await load(required(p, 'proposal'), 'proposals', store));
}
async function signatures(p: Proposal, store: typeof Store.Service) {
  const ids = (await store.list('signatures')).filter((id) => id.startsWith(p.id + '_'));
  return Promise.all(ids.map((id) => store.get('signatures', id))) as Promise<Signature[]>;
}
async function saveSignature(p: Proposal, input: unknown, store: typeof Store.Service) {
  const s = await verifyMemberSignature(p, input);
  const id = signatureId(p, s);
  try {
    const prior = await store.get('signatures', id);
    // Randomized ECDSA may produce another valid signature; the first valid one wins.
    return await verifyMemberSignature(p, prior);
  } catch (e: any) {
    if (e.code !== 'ENOENT') throw e;
  }
  try {
    await store.put('signatures', id, s);
  } catch (e) {
    if (!(e instanceof CliError && e.code === 'STATE_CONFLICT')) throw e;
    return verifyMemberSignature(p, await store.get('signatures', id));
  }
  return s;
}
async function saveProposal(p: Proposal, store: typeof Store.Service) {
  try {
    const prior = await parseProposal(await store.get('proposals', p.id));
    assert(
      prior.transactionBytes === p.transactionBytes &&
        prior.wallet.address === p.wallet.address &&
        prior.network === p.network &&
        prior.chainIdentifier === p.chainIdentifier,
      'STATE_CONFLICT',
      'Existing immutable proposal has different chain metadata.',
    );
    return prior;
  } catch (e: any) {
    if (e.code !== 'ENOENT') throw e;
  }
  await store.put('proposals', p.id, p);
  return p;
}
function makeSigner(p: Parsed, key: KeyRef, hardware: typeof Hardware.Service) {
  return new PivSigner(key, async (digest, expectedPublicKey) => {
    const pin = secret('PIV PIN: ', fd(p, 'pin-fd'), interactive(p));
    try {
      return (
        await hardware.call({
          op: 'sign',
          serial: key.serial,
          slot: key.slot,
          digest,
          expectedPublicKey,
          pin: pin.toString('utf8'),
        })
      ).der as string;
    } finally {
      pin.fill(0);
    }
  });
}
async function key(p: Parsed, store: typeof Store.Service) {
  return parseKey(await load(required(p, 'key'), 'keys', store));
}
function review(p: Proposal) {
  const transaction = Transaction.from(base64(p.transactionBytes)).getData();
  function pure(arg: any): Uint8Array | undefined {
    if (arg?.$kind !== 'Input') return undefined;
    const input = transaction.inputs[arg.Input];
    return input?.$kind === 'Pure' ? base64(input.Pure.bytes) : undefined;
  }
  const intent = transaction.commands.map((command) => {
    if (command.$kind === 'SplitCoins')
      return {
        operation: 'splitCoins',
        amountsBaseUnits: command.SplitCoins.amounts.map((arg) => {
          const bytes = pure(arg);
          return bytes?.length === 8
            ? Buffer.from(bytes).readBigUInt64LE().toString()
            : { argument: arg };
        }),
      };
    if (command.$kind === 'TransferObjects') {
      const recipient = pure(command.TransferObjects.address);
      return {
        operation: 'transferObjects',
        recipient:
          recipient?.length === 32
            ? '0x' + Buffer.from(recipient).toString('hex')
            : { argument: command.TransferObjects.address },
        objects: command.TransferObjects.objects,
      };
    }
    if (command.$kind === 'MoveCall')
      return {
        operation: 'moveCall',
        target: `${command.MoveCall.package}::${command.MoveCall.module}::${command.MoveCall.function}`,
        typeArguments: command.MoveCall.typeArguments,
      };
    return { operation: command.$kind, command };
  });
  return {
    id: p.id,
    network: p.network,
    chainIdentifier: p.chainIdentifier,
    digest: p.digest,
    wallet: p.wallet,
    description: p.description,
    intent,
    transaction,
  };
}
function printReview(value: unknown) {
  process.stderr.write(JSON.stringify(value, null, 2) + '\n');
}

export function runCommand(p: Parsed) {
  return Effect.gen(function* () {
    const store = yield* Store;
    const hardware = yield* Hardware;
    const chain = yield* Chain;
    return yield* attempt(async (): Promise<unknown> => {
      const command = p.command;
      if (command === 'doctor') {
        let device: unknown;
        try {
          device = await hardware.call({ op: 'devices' });
        } catch (e) {
          device =
            e instanceof CliError ? { code: e.code, message: e.message } : { available: false };
        }
        return {
          version: '0.1.0',
          runtime: `Bun ${Bun.version}`,
          platform: process.platform,
          arch: process.arch,
          dataDir: store.root,
          piv: device,
        };
      }
      if (command === 'device list') return hardware.call({ op: 'devices' });
      if (command === 'device slots') {
        if (str(p, 'device')) return getSlots(hardware, number(p, 'device'));
        assert(
          interactive(p),
          'DEVICE_REQUIRED',
          'Provide --device SERIAL in non-interactive mode. Run device list --json to discover serials.',
        );
        const terminal = new Terminal();
        try {
          return getSlots(hardware, (await selectDevice(hardware, terminal)).serial);
        } finally {
          terminal.close();
        }
      }
      if (command === 'device inspect')
        return hardware.call({
          op: 'inspect',
          serial: number(p, 'device'),
          slot: str(p, 'slot') ?? '9c',
        });
      if (command === 'key generate' || command === 'key export') {
        const serial = number(p, 'device');
        const slot = command === 'key generate' ? required(p, 'slot') : (str(p, 'slot') ?? '9c');
        let info = await hardware.call({ op: 'inspect', serial, slot });
        if (command === 'key generate') {
          assert(
            info.empty,
            'SLOT_OCCUPIED',
            'Slot already holds a key. Use key export to recover its public reference.',
          );
          printReview({
            device: serial,
            slot,
            algorithm: 'P256',
            pinPolicy: 'always',
            touchPolicy: 'always',
            credentialsChanged: false,
          });
          await acknowledge(p, 'Generate a new non-exportable key on this YubiKey?');
          assert(
            !(p.flags['factory-management-key'] && str(p, 'management-key-fd')),
            'USAGE',
            'Choose either a management-key FD or explicit factory-management-key mode.',
          );
          const management = p.flags['factory-management-key']
            ? Buffer.from('010203040506070801020304050607080102030405060708')
            : secret('PIV management key (hex): ', fd(p, 'management-key-fd'), interactive(p));
          try {
            const managementKey = management.toString('utf8');
            assert(
              /^(?:[a-fA-F0-9]{32}|[a-fA-F0-9]{48}|[a-fA-F0-9]{64})$/.test(managementKey),
              'INVALID_CREDENTIAL',
              'Management key must be 16, 24, or 32 bytes in hex.',
            );
            const operation = randomUUID();
            await store.put('operations', operation, {
              operation: 'piv.generate',
              serial,
              slot,
              startedAt: stamp(),
              outcome: 'unknown',
            });
            info = await hardware.call({ op: 'generate', serial, slot, managementKey });
            try {
              await store.put('operation-results', operation, {
                operation: 'piv.generate',
                serial,
                slot,
                outcome: 'applied',
                completedAt: stamp(),
                publicKeyHex: info.publicKeyHex,
              });
            } catch {
              throw new CliError({
                code: 'KEY_GENERATED_PERSISTENCE_FAILED',
                message:
                  'Key generation succeeded, but its receipt could not be saved. Recover with key export; do not regenerate.',
                exit: 5,
                details: { outcome: 'applied', reference: keyReference(info), operation },
              });
            }
          } finally {
            management.fill(0);
          }
        }
        const reference = keyReference(info);
        try {
          await store.put('keys', `${serial}_${slot}`, reference);
        } catch (e) {
          throw new CliError({
            code: 'KEY_REFERENCE_WRITE_FAILED',
            message:
              'The key exists on the device, but saving its reference failed. Recover with key export.',
            exit: 5,
            details: { reference },
          });
        }
        return reference;
      }
      if (command === 'key address' || command === 'ui') {
        if (str(p, 'key')) {
          assert(
            !str(p, 'device') && !str(p, 'slot'),
            'USAGE',
            'Choose --key, or select a device and slot.',
          );
          const k = await key(p, store);
          return { address: k.address, publicKey: k.publicKey, serial: k.serial, slot: k.slot };
        }
        if (command === 'key address' && str(p, 'device') && str(p, 'slot')) {
          const reference = keyReference(
            await hardware.call({
              op: 'inspect',
              serial: number(p, 'device'),
              slot: required(p, 'slot').toLowerCase(),
            }),
          );
          const keyId = `${reference.serial}_${reference.slot}`;
          await store.put('keys', keyId, reference);
          return { keyId, ...reference };
        }
        assert(
          interactive(p),
          'INTERACTIVE_REQUIRED',
          'Run multisig key address in a terminal, or provide --key REF / --device SERIAL --slot SLOT.',
        );
        const terminal = new Terminal();
        try {
          const result = await pickAddress(
            hardware,
            terminal,
            str(p, 'device') ? number(p, 'device') : undefined,
            str(p, 'slot'),
          );
          const { keyId, ...reference } = result;
          await store.put('keys', keyId, reference);
          terminal.write(
            `\nSaved public reference: ${keyId}\nUse it again with: multisig key address --key ${keyId}\n`,
          );
          return result;
        } finally {
          terminal.close();
        }
      }
      if (command.startsWith('alias ')) {
        const operation = command.slice(6) as 'show' | 'enable' | 'add' | 'remove' | 'transfer-sui';
        const n = network(p);
        const endpoint = str(p, 'rpc-url') ?? endpoints[n];
        const client = chain.client(n, str(p, 'rpc-url'));
        if (operation === 'show')
          return {
            network: n,
            endpoint,
            ...(await getAliases(client, address(required(p, 'address')))),
          };
        const reference = await key(p, store);
        const sender = address(str(p, 'address') ?? reference.address);
        const tx = await buildAliasTransaction(client, {
          network: n,
          owner: sender,
          signerAddress: reference.address,
          operation,
          alias:
            operation === 'add' || operation === 'remove'
              ? address(required(p, 'alias'))
              : undefined,
          recipient: operation === 'transfer-sui' ? address(required(p, 'recipient')) : undefined,
          amount: operation === 'transfer-sui' ? required(p, 'amount') : undefined,
        });
        await store.put('account-transactions', tx.digest, tx);
        const preview = await client.simulateTransaction({
          transaction: base64(tx.transactionBytes),
          doGasSelection: false,
          checksEnabled: true,
          include: { effects: true, balanceChanges: true },
          signal: AbortSignal.timeout(30_000),
        });
        const previewTx = preview.Transaction ?? preview.FailedTransaction;
        assert(
          previewTx.status.success,
          'SIMULATION_FAILED',
          'Alias transaction simulation failed; no signature was requested.',
        );
        printReview({
          operation: tx.operation,
          network: n,
          endpoint,
          sender,
          signerAddress: reference.address,
          digest: tx.digest,
          expectedAliases: tx.expectedAliases,
          ...(operation === 'add'
            ? {
                authorization:
                  'The added alias can independently control this address and modify its aliases.',
              }
            : {}),
          transaction: Transaction.from(base64(tx.transactionBytes)).getData(),
        });
        await acknowledge(p, 'Sign and submit this account transaction?');
        const savedSignature = async (): Promise<string | undefined> => {
          let saved;
          try {
            saved = record(await store.get('account-signatures', tx.digest));
          } catch (e: any) {
            if (e.code === 'ENOENT') return undefined;
            throw e;
          }
          assert(
            saved.digest === tx.digest &&
              saved.signerAddress === reference.address &&
              typeof saved.signature === 'string',
            'WRONG_SIGNER',
            'Saved account signature metadata does not match this transaction.',
          );
          await verifyAccountSignature(tx, saved.signature);
          return saved.signature;
        };
        let signature = await signAliasTransaction(
          client,
          tx,
          makeSigner(p, reference, hardware),
          await savedSignature(),
        );
        try {
          await store.put('account-signatures', tx.digest, {
            digest: tx.digest,
            signerAddress: reference.address,
            signature,
          });
        } catch (e) {
          if (!(e instanceof CliError && e.code === 'STATE_CONFLICT')) throw e;
          const firstSignature = await savedSignature();
          assert(firstSignature, 'INVALID_SIGNATURE', 'Saved account signature is missing.');
          signature = firstSignature;
        }
        const receipt = randomUUID();
        await store.put('submissions', receipt, {
          operation: tx.operation,
          digest: tx.digest,
          network: n,
          endpoint,
          startedAt: stamp(),
          outcome: 'unknown',
        });
        const result = await executeAliasTransaction(client, tx, signature);
        try {
          await store.put('submission-results', receipt, {
            digest: tx.digest,
            outcome: 'applied',
            result,
          });
        } catch {
          throw new CliError({
            code: 'EXECUTED_PERSISTENCE_FAILED',
            message: 'The account transaction executed, but its receipt could not be saved.',
            exit: 5,
            details: { outcome: 'applied', digest: tx.digest, result },
          });
        }
        if (result.$kind === 'FailedTransaction')
          throw new CliError({
            code: 'EXECUTION_FAILED',
            message: 'The account transaction executed but failed on chain.',
            exit: 4,
            details: { digest: tx.digest, result },
          });
        let after: Awaited<ReturnType<typeof getAliases>>;
        try {
          await client.waitForTransaction({ result, timeout: 30_000 });
          after = await getAliases(client, sender);
          if (tx.expectedAliases)
            assert(
              tx.expectedAliases.length === after.aliases.length &&
                tx.expectedAliases.every((a) => after.aliases.includes(a)),
              'ALIAS_STATE_MISMATCH',
              'Transaction executed, but the current alias set differs from the planned set.',
            );
        } catch {
          throw new CliError({
            code: 'EXECUTED_RECONCILIATION_PENDING',
            message:
              'The account transaction executed successfully; alias-state reconciliation is pending.',
            exit: 5,
            details: { outcome: 'applied', digest: tx.digest, sender },
          });
        }
        return {
          digest: tx.digest,
          network: n,
          outcome: 'applied',
          sender,
          signerAddress: reference.address,
          aliases: after.aliases,
          aliasesObjectId: after.objectId,
          result,
        };
      }
      if (command === 'wallet create') {
        const input = await readJson(required(p, 'members'));
        const members = Array.isArray(input) ? input : record(input).members;
        const w = createWallet(members, number(p, 'threshold'), str(p, 'name') ?? null);
        await store.put('wallets', w.address, w);
        return w;
      }
      if (command === 'wallet import') {
        const w = parseWallet(await readJson(required(p, 'input')));
        await store.put('wallets', w.address, w);
        return w;
      }
      if (command === 'wallet list')
        return Promise.all((await store.list('wallets')).map((id) => store.get('wallets', id)));
      if (command === 'wallet show' || command === 'wallet export') {
        const w = await wallet(p, store);
        return p.flags.sagat ? exportWallet(w) : w;
      }
      if (command === 'balance' || command === 'objects') {
        assert(!(str(p, 'wallet') && str(p, 'address')), 'USAGE', 'Choose --wallet or --address.');
        const owner = str(p, 'wallet')
          ? (await wallet(p, store)).address
          : address(required(p, 'address'));
        const limit = number(p, 'limit', 50);
        assert(limit >= 1 && limit <= 100, 'USAGE', 'Limit must be between 1 and 100.');
        const client = chain.client(network(p), str(p, 'rpc-url'));
        const options = {
          owner,
          limit,
          cursor: str(p, 'cursor'),
          signal: AbortSignal.timeout(20_000),
        };
        return command === 'balance'
          ? client.listBalances(options)
          : client.listOwnedObjects({ ...options, include: { json: true } });
      }
      if (command.startsWith('tx build-')) {
        const w = await wallet(p, store);
        const n = network(p);
        const kind = command.slice(9) as 'sui' | 'coin' | 'object' | 'json';
        const built = await buildProposal(
          chain.client(n, str(p, 'rpc-url')),
          w,
          n,
          {
            kind,
            recipient: kind !== 'json' ? required(p, 'recipient') : undefined,
            amount: kind === 'sui' || kind === 'coin' ? required(p, 'amount') : undefined,
            coinType: kind === 'coin' ? required(p, 'coin-type') : undefined,
            objectIds: p.flags.object as string[] | undefined,
            json: kind === 'json' ? await readJson(required(p, 'input')) : undefined,
            gasBudget: str(p, 'gas-budget'),
          },
          str(p, 'description') ?? null,
        );
        return saveProposal(built, store);
      }
      if (command === 'tx import' || command === 'proposal create') {
        const input = await readJson(required(p, 'input'));
        const raw = typeof input === 'string' ? input : record(input).transactionBytes;
        const n = network(p);
        const identity = p.flags['pin-chain']
          ? (await chain.client(n, str(p, 'rpc-url')).getChainIdentifier()).chainIdentifier
          : null;
        return saveProposal(
          await createProposal(
            await wallet(p, store),
            raw,
            n,
            identity,
            str(p, 'description') ?? null,
          ),
          store,
        );
      }
      if (command === 'proposal import') {
        const imported = await importProposal(await readJson(required(p, 'input')));
        if (p.flags['pin-chain']) {
          const actual = (
            await chain
              .client(network(p, imported.proposal), str(p, 'rpc-url'))
              .getChainIdentifier()
          ).chainIdentifier;
          assert(
            imported.proposal.chainIdentifier === null ||
              imported.proposal.chainIdentifier === actual,
            'CHAIN_MISMATCH',
            'An existing proposal chain pin cannot be replaced.',
          );
          imported.proposal = { ...imported.proposal, chainIdentifier: actual };
        }
        const saved = await saveProposal(imported.proposal, store);
        for (const s of imported.signatures) await saveSignature(saved, s, store);
        return { ...saved, importedSignatures: imported.signatures.length };
      }
      if (command === 'proposal list')
        return Promise.all((await store.list('proposals')).map((id) => store.get('proposals', id)));
      if (command === 'tx inspect' || command === 'proposal show') {
        const value = await proposal(p, store);
        return { ...review(value), ...(await tally(value, await signatures(value, store))) };
      }
      if (command === 'proposal export') {
        const value = await proposal(p, store);
        return p.flags.sagat ? exportProposal(value, await signatures(value, store)) : value;
      }
      if (command === 'message sign') {
        assert(
          !(str(p, 'message') && str(p, 'input')),
          'USAGE',
          'Choose --message or a JSON string from --input.',
        );
        const text = str(p, 'message') ?? (await readJson(required(p, 'input')));
        assert(typeof text === 'string', 'USAGE', 'Personal message input must be a JSON string.');
        printReview({ operation: 'personalMessage', message: text });
        await acknowledge(p, 'Sign this personal message?');
        const k = await key(p, store);
        const signed = await makeSigner(p, k, hardware).signPersonalMessage(
          new TextEncoder().encode(text),
        );
        assert(
          (
            await verifyPersonalMessageSignature(new TextEncoder().encode(text), signed.signature)
          ).toSuiPublicKey() === k.publicKey,
          'INVALID_SIGNATURE',
          'Personal message failed SDK verification.',
        );
        return { ...signed, publicKey: k.publicKey, address: k.address };
      }
      if (command === 'message verify') {
        const text = str(p, 'message') ?? (await readJson(required(p, 'input')));
        assert(typeof text === 'string', 'USAGE', 'Message must be a string.');
        const values = p.flags.signature as string[];
        assert(values?.length === 1, 'USAGE', 'Provide exactly one --signature.');
        const k = await verifyPersonalMessageSignature(new TextEncoder().encode(text), values[0]!);
        if (str(p, 'public-key'))
          assert(
            k.toSuiPublicKey() === str(p, 'public-key'),
            'INVALID_SIGNATURE',
            'Signature belongs to another public key.',
          );
        return { valid: true, publicKey: k.toSuiPublicKey(), address: k.toSuiAddress() };
      }
      if (command.startsWith('proposal ') || command === 'tx simulate') {
        const value = await proposal(p, store);
        const n = network(p, value);
        if (command === 'proposal cancel') {
          await acknowledge(
            p,
            'Mark this proposal cancelled locally? Existing signatures remain valid on chain.',
          );
          await store.put('cancelled', value.id, { id: value.id, cancelledAt: stamp() });
          return { id: value.id, status: 'cancelled', signaturesRevoked: false };
        }
        if (command === 'proposal signature-import')
          return saveSignature(value, await readJson(required(p, 'input')), store);
        let collected = await signatures(value, store);
        for (const file of (p.flags.signature as string[]) ?? [])
          collected.push(await verifyMemberSignature(value, await readJson(file)));
        if (command === 'proposal combine') return combine(value, collected);
        const signingKey = command === 'proposal sign' ? await key(p, store) : undefined;
        if (signingKey)
          assert(
            value.wallet.members.some((m) => m.publicKey === signingKey.publicKey),
            'NOT_MEMBER',
            'The selected PIV key is not a multisig member.',
          );
        const client = chain.client(n, str(p, 'rpc-url'));
        if (command === 'proposal status') {
          const chainIdentifier = await checkChain(
            client,
            value,
            !!p.flags['allow-unverified-network'],
          );
          try {
            const result = await client.getTransaction({
              digest: value.digest,
              include: { effects: true },
              signal: AbortSignal.timeout(20_000),
            });
            return {
              digest: value.digest,
              network: n,
              chainIdentifier,
              endpoint: str(p, 'rpc-url') ?? endpoints[n],
              result,
            };
          } catch {
            throw new CliError({
              code: 'STATUS_UNCONFIRMED',
              message:
                'Transaction was not confirmed by this RPC. This does not prove that submission failed.',
              exit: 5,
              details: { digest: value.digest },
            });
          }
        }
        await checkChain(client, value, !!p.flags['allow-unverified-network']);
        if (command === 'tx simulate') return simulate(client, value);
        if (command === 'proposal sign') {
          assert(
            !(await store.list('cancelled')).includes(value.id),
            'PROPOSAL_CANCELLED',
            'This proposal is marked cancelled locally.',
          );
          const k = signingKey!;
          printReview(review(value));
          await acknowledge(p, 'Sign these exact transaction bytes?');
          const signed = await makeSigner(p, k, hardware).signTransaction(
            base64(value.transactionBytes),
          );
          return saveSignature(
            value,
            {
              type: 'multisig.signature',
              version: 1,
              proposalId: value.id,
              digest: value.digest,
              publicKey: k.publicKey,
              signature: signed.signature,
            },
            store,
          );
        }
        if (command === 'proposal execute') {
          assert(
            !(await store.list('cancelled')).includes(value.id),
            'PROPOSAL_CANCELLED',
            'This proposal is marked cancelled locally.',
          );
          const combined = await combine(value, collected);
          printReview({
            ...review(value),
            currentWeight: combined.currentWeight,
            threshold: combined.threshold,
            rpc: str(p, 'rpc-url') ?? endpoints[n],
          });
          await acknowledge(p, 'Submit this transaction to Sui?');
          const receipt = randomUUID();
          await store.put('submissions', receipt, {
            proposalId: value.id,
            digest: value.digest,
            network: n,
            endpoint: str(p, 'rpc-url') ?? endpoints[n],
            startedAt: stamp(),
            outcome: 'unknown',
          });
          const result = await executeExact(client, value, combined.signature);
          try {
            await store.put('submission-results', receipt, {
              proposalId: value.id,
              digest: value.digest,
              outcome: 'applied',
              result,
            });
          } catch {
            throw new CliError({
              code: 'EXECUTED_PERSISTENCE_FAILED',
              message:
                'The network executed the transaction, but its local receipt could not be saved. Reconcile by digest.',
              exit: 5,
              details: { outcome: 'applied', digest: value.digest, receipt, result },
            });
          }
          if (result.$kind === 'FailedTransaction')
            throw new CliError({
              code: 'EXECUTION_FAILED',
              message: 'Transaction executed but failed on chain.',
              exit: 4,
              details: { digest: value.digest, result },
            });
          return { digest: value.digest, network: n, outcome: 'applied', result };
        }
      }
      if (command.startsWith('sagat ')) return runSagat(p, store, hardware, chain);
      throw new CliError({ code: 'USAGE', message: 'Unsupported command.', exit: 2 });
    });
  });
}

async function runSagat(
  p: Parsed,
  store: typeof Store.Service,
  hardware: typeof Hardware.Service,
  chain: typeof Chain.Service,
) {
  const endpoint = str(p, 'api-url') ?? 'https://api.sagat.mystenlabs.com';
  let token: string | undefined;
  const tokenFd = fd(p, 'token-fd');
  if (tokenFd !== undefined) {
    const bytes = secret('', tokenFd, false, 16384);
    try {
      token = bytes.toString();
    } finally {
      bytes.fill(0);
    }
  }
  const api = new SagatClient(endpoint, token);
  const command = p.command.slice(6);
  const identifier = () => number(p, 'id');
  const expiry = () => new Date(Date.now() + 10 * 60_000).toISOString();
  async function signMessage(text: string) {
    printReview({ api: endpoint, message: text });
    await acknowledge(p, 'Sign this Sagat request?');
    const k = await key(p, store);
    return makeSigner(p, k, hardware).signPersonalMessage(new TextEncoder().encode(text));
  }
  if (command === 'login') {
    const end = expiry();
    const signed = await signMessage(messages.connect(end));
    const result = await api.request('/auth/script-connect', 'POST', {
      signature: signed.signature,
      expiry: end,
    });
    assert(
      typeof result.token === 'string',
      'SAGAT_AUTH_ERROR',
      'Sagat did not return a script token.',
    );
    // A requested token is stdout data; do not persist it implicitly.
    return { api: endpoint, token: result.token, expiresInSeconds: 3600 };
  }
  if (command === 'wallets') return api.request('/addresses/connections');
  if (command === 'invitations')
    return api.request(
      '/addresses/invitations/' + encodeURIComponent((await key(p, store)).publicKey),
    );
  if (command === 'wallet-show')
    return api.request('/multisig/' + (await wallet(p, store)).address);
  if (command === 'wallet-create') {
    const w = await wallet(p, store);
    printReview({ api: endpoint, wallet: w });
    await acknowledge(p, 'Register this multisig in Sagat?');
    return api.request('/multisig', 'POST', {
      publicKeys: w.members.map((m) => m.publicKey),
      weights: w.members.map((m) => m.weight),
      threshold: w.threshold,
      name: w.name ?? undefined,
    });
  }
  if (command === 'accept' || command === 'reject') {
    const w = await wallet(p, store);
    const k = await key(p, store);
    assert(
      w.members.some((m) => m.publicKey === k.publicKey),
      'NOT_MEMBER',
      'Selected key is not a member.',
    );
    const signed = await signMessage(
      command === 'accept' ? messages.accept(w.address) : messages.reject(w.address),
    );
    return api.request(`/multisig/${w.address}/${command}`, 'POST', {
      signature: signed.signature,
    });
  }
  if (command === 'proposals') {
    const w = await wallet(p, store);
    const query = new URLSearchParams({
      multisigAddress: w.address,
      network: network(p),
      perPage: String(number(p, 'limit', 50)),
    });
    if (str(p, 'cursor')) query.set('nextCursor', str(p, 'cursor')!);
    if (str(p, 'status')) query.set('status', str(p, 'status')!);
    return api.request('/proposals?' + query);
  }
  if (command === 'proposal-get') {
    const remote = await api.request(
      '/proposals/digest/' + encodeURIComponent(required(p, 'digest')),
    );
    const imported = await importProposal({
      type: 'sagat.proposal',
      version: 1,
      proposal: remote,
      multisig: remote.multisig,
    });
    if (p.flags['pin-chain'])
      imported.proposal.chainIdentifier = (
        await chain.client(network(p, imported.proposal), str(p, 'rpc-url')).getChainIdentifier()
      ).chainIdentifier;
    const saved = await saveProposal(imported.proposal, store);
    for (const s of imported.signatures) await saveSignature(saved, s, store);
    return saved;
  }
  if (command === 'propose') {
    const value = await proposal(p, store);
    const k = await key(p, store);
    const client = chain.client(network(p, value), str(p, 'rpc-url'));
    await checkChain(client, value, !!p.flags['allow-unverified-network']);
    printReview({ api: endpoint, ...review(value) });
    await acknowledge(p, 'Sign and publish this Sagat proposal?');
    const signed = await makeSigner(p, k, hardware).signTransaction(base64(value.transactionBytes));
    return api.request('/proposals', 'POST', {
      multisigAddress: value.wallet.address,
      transactionBytes: value.transactionBytes,
      signature: signed.signature,
      network: value.network,
      description: value.description ?? undefined,
    });
  }
  if (command === 'vote') {
    const value = await proposal(p, store);
    const files = p.flags.signature as string[];
    assert(files?.length === 1, 'USAGE', 'Provide one signature artifact with --signature FILE.');
    const s = await verifyMemberSignature(value, await readJson(files[0]!));
    printReview({ api: endpoint, proposalId: identifier(), digest: value.digest });
    await acknowledge(p, 'Submit this signature to Sagat?');
    // Resolve the ID by digest first so an unrelated numeric ID cannot receive a signature.
    const remote = await api.request('/proposals/digest/' + encodeURIComponent(value.digest));
    assert(
      remote.id === identifier() && remote.transactionBytes === value.transactionBytes,
      'WRONG_PROPOSAL',
      'Remote proposal ID/bytes differ.',
    );
    return api.request(`/proposals/${identifier()}/vote`, 'POST', { signature: s.signature });
  }
  if (command === 'cancel') {
    const signed = await signMessage(messages.cancel(identifier()));
    return api.request(`/proposals/${identifier()}/cancel`, 'POST', {
      signature: signed.signature,
    });
  }
  if (command === 'verify') {
    await acknowledge(p, 'Ask Sagat to reconcile on-chain execution?');
    return api.request(
      `/proposals/${encodeURIComponent(required(p, 'digest'))}/verify-by-digest`,
      'POST',
    );
  }
  if (command === 'add-proposer' || command === 'remove-proposer') {
    const w = await wallet(p, store);
    const k = await key(p, store);
    assert(
      w.members.some((m) => m.publicKey === k.publicKey),
      'NOT_MEMBER',
      'Selected key is not a member.',
    );
    const proposer = address(required(p, 'proposer'));
    const end = expiry();
    const text =
      command === 'add-proposer'
        ? messages.addProposer(proposer, w.address, end)
        : messages.removeProposer(proposer, w.address, end);
    const signed = await signMessage(text);
    return api.request(`/multisig/${w.address}/${command}`, 'POST', {
      proposer,
      signature: signed.signature,
      expiry: end,
    });
  }
  throw new CliError({ code: 'USAGE', message: 'Unsupported Sagat operation.', exit: 2 });
}

export function program(p: Parsed) {
  const root = str(p, 'data-dir') ?? join(homedir(), '.local', 'share', 'multisig');
  const operation = Effect.gen(function* () {
    if (str(p, 'output'))
      yield* attempt(async () => {
        assert(
          !(await Bun.file(str(p, 'output')!).exists()),
          'FILE_EXISTS',
          'Output already exists; refusing before performing the operation.',
        );
      });
    return yield* runCommand(p);
  });
  return operation.pipe(
    Effect.provide(
      Layer.mergeAll(storeLayer(root), hardwareLayer(root, str(p, 'library')), ChainLive),
    ),
  );
}
export async function render(value: unknown, p: Parsed) {
  if (str(p, 'output')) {
    try {
      await writeNew(str(p, 'output')!, value);
    } catch {
      throw new CliError({
        code: 'OUTPUT_WRITE_FAILED',
        message:
          'The operation completed, but its output file could not be written. Do not assume a mutation was rolled back.',
        exit: 5,
        details: {
          outcome: 'applied',
          command: p.command,
          ...(p.command === 'sagat login' ? { tokenOmitted: true } : { result: value }),
        },
      });
    }
    process.stdout.write(JSON.stringify({ written: str(p, 'output') }) + '\n');
  } else if (p.command === 'device slots' && !p.flags.json)
    process.stdout.write(slotTable(value as SlotOverview));
  else
    process.stdout.write(
      JSON.stringify(
        value,
        (_, v) => (typeof v === 'bigint' ? v.toString() : v),
        p.flags.json ? undefined : 2,
      ) + '\n',
    );
}
