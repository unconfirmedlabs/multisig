import { test, expect } from 'bun:test';
import { bcs } from '@mysten/sui/bcs';
import { ObjectError } from '@mysten/sui/client';
import type { SuiGrpcClient } from '@mysten/sui/grpc';
import { Transaction } from '@mysten/sui/transactions';
import { verifyTransactionSignature } from '@mysten/sui/verify';
import { toBase64 } from '@mysten/sui/utils';
import {
  aliasesObjectId,
  getAliases,
  aliasCommand,
  signAliasTransaction,
  executeAliasTransaction,
  verifyAccountSignature,
  validateAccountTransaction,
  type AccountTransaction,
  ALIASES_TYPE,
} from '../src/aliases.ts';
import { a, c } from './domain.test.ts';

const owner = a.toSuiAddress(),
  backup = c.toSuiAddress();
function response(aliases = [owner, backup]) {
  const id = aliasesObjectId(owner);
  return {
    object: {
      objectId: id,
      type: ALIASES_TYPE,
      content: bcs
        .struct('AddressAliases', { id: bcs.Address, aliases: bcs.vector(bcs.Address) })
        .serialize({ id, aliases })
        .toBytes(),
    },
  };
}
async function accountFixture(): Promise<AccountTransaction> {
  const tx = new Transaction();
  tx.setSender(owner);
  tx.setGasOwner(owner);
  tx.setGasBudget(1_000_000);
  tx.setGasPrice(1000);
  tx.setGasPayment([
    { objectId: '0x123', version: '1', digest: '11111111111111111111111111111111' },
  ]);
  const [coin] = tx.splitCoins(tx.gas, [1]);
  tx.transferObjects([coin], backup);
  const bytes = await tx.build();
  return {
    type: 'multisig.account-transaction',
    version: 1,
    network: 'testnet',
    chainIdentifier: 'fixture-chain',
    sender: owner,
    signerAddress: backup,
    transactionBytes: toBase64(bytes),
    digest: await tx.getDigest(),
    operation: 'alias.transfer-sui',
  };
}

test('address alias state defaults only on an explicit not-found; transport failures fail closed', async () => {
  const absent = {
    getObject: async () => {
      throw new ObjectError('notExists', 'missing', { reason: 'notFound' });
    },
  } as unknown as SuiGrpcClient;
  expect(await getAliases(absent, owner)).toEqual({
    address: owner,
    objectId: aliasesObjectId(owner),
    enabled: false,
    aliases: [owner],
  });
  const offline = {
    getObject: async () => {
      throw Error('offline');
    },
  } as unknown as SuiGrpcClient;
  await expect(getAliases(offline, owner)).rejects.toThrow('offline');
});
test('alias state validates BCS, rejects duplicates and retains the original authority', async () => {
  const client = { getObject: async () => response() } as unknown as SuiGrpcClient;
  const state = await getAliases(client, owner);
  expect(state.aliases).toEqual([owner, backup]);
  expect(() => aliasCommand('remove', owner, state, owner)).toThrow();
  expect(() => aliasCommand('add', owner, state, backup)).toThrow();
  const duplicate = { getObject: async () => response([owner, owner]) } as unknown as SuiGrpcClient;
  await expect(getAliases(duplicate, owner)).rejects.toThrow();
  const trailing = response();
  trailing.object.content = Uint8Array.from([...trailing.object.content, 0]);
  await expect(
    getAliases({ getObject: async () => trailing } as unknown as SuiGrpcClient, owner),
  ).rejects.toThrow();
});
test('a distinct alias key signs exact bytes as the original address, preserving raw signature scheme', async () => {
  const tx = await accountFixture();
  let submitted: Uint8Array | undefined;
  const client = {
    getObject: async () => response(),
    getChainIdentifier: async () => ({ chainIdentifier: 'fixture-chain' }),
    executeTransaction: async (input: any) => {
      submitted = input.transaction;
      return { $kind: 'Transaction', Transaction: { digest: tx.digest } };
    },
  } as unknown as SuiGrpcClient;
  const signature = await signAliasTransaction(client, tx, c);
  let hardwareCalls = 0;
  const retrySigner = Object.create(c);
  retrySigner.signTransaction = async () => {
    hardwareCalls++;
    throw Error('Retry must reuse the verified saved signature');
  };
  expect(await signAliasTransaction(client, tx, retrySigner, signature)).toBe(signature);
  expect(hardwareCalls).toBe(0);
  const wrongSigner = await a.signTransaction(Buffer.from(tx.transactionBytes, 'base64'));
  await expect(verifyAccountSignature(tx, wrongSigner.signature)).rejects.toThrow();
  expect(
    (
      await verifyTransactionSignature(Buffer.from(tx.transactionBytes, 'base64'), signature)
    ).toSuiAddress(),
  ).toBe(backup);
  expect(Transaction.from(tx.transactionBytes).getData().sender).toBe(owner);
  await executeAliasTransaction(client, tx, signature);
  expect(Buffer.from(submitted!).toString('base64')).toBe(tx.transactionBytes);
  await expect(validateAccountTransaction({ ...tx, digest: 'forged' })).rejects.toThrow();
  await expect(validateAccountTransaction({ ...tx, sender: backup })).rejects.toThrow();
  await expect(validateAccountTransaction({ ...tx, operation: 'alias.add' })).rejects.toThrow();
});
test('alias execution rechecks chain and preserves confirmed on-chain failures for journaling', async () => {
  const tx = await accountFixture();
  let submitted = false;
  const client = {
    getChainIdentifier: async () => ({ chainIdentifier: 'other-chain' }),
    executeTransaction: async () => {
      submitted = true;
      return {};
    },
  } as unknown as SuiGrpcClient;
  await expect(executeAliasTransaction(client, tx, 'sig')).rejects.toThrow();
  expect(submitted).toBe(false);
  const failed = {
    $kind: 'FailedTransaction',
    FailedTransaction: { digest: tx.digest, status: { success: false } },
  };
  const returned = await executeAliasTransaction(
    {
      getChainIdentifier: async () => ({ chainIdentifier: 'fixture-chain' }),
      executeTransaction: async () => failed,
    } as unknown as SuiGrpcClient,
    tx,
    'sig',
  );
  expect(returned.$kind).toBe('FailedTransaction');
  expect(returned.FailedTransaction?.digest).toBe(tx.digest);
});
