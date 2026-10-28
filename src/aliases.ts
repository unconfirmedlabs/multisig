import { bcs } from '@mysten/sui/bcs';
import { ObjectError } from '@mysten/sui/client';
import type { SuiGrpcClient } from '@mysten/sui/grpc';
import type { Signer } from '@mysten/sui/cryptography';
import { Transaction } from '@mysten/sui/transactions';
import { deriveObjectID, normalizeStructTag, toBase64 } from '@mysten/sui/utils';
import { verifyTransactionSignature } from '@mysten/sui/verify';
import { address, base64, transactionData, type Network } from './domain.ts';
import { assert, CliError } from './errors.ts';
import { amount } from './chain.ts';

export const ALIAS_STATE = '0xa';
export const ALIASES_TYPE = '0x2::address_alias::AddressAliases';
const AliasesBcs = bcs.struct('AddressAliases', {
  id: bcs.Address,
  aliases: bcs.vector(bcs.Address),
});

export interface AliasState {
  address: string;
  objectId: string;
  enabled: boolean;
  aliases: string[];
}
export function aliasesObjectId(owner: string) {
  return deriveObjectID(
    ALIAS_STATE,
    '0x2::address_alias::AliasKey',
    bcs.Address.serialize(address(owner)).toBytes(),
  );
}
export async function getAliases(client: SuiGrpcClient, owner: string): Promise<AliasState> {
  const sender = address(owner);
  const objectId = aliasesObjectId(sender);
  let result;
  try {
    result = await client.getObject({
      objectId,
      include: { content: true },
      signal: AbortSignal.timeout(20_000),
    });
  } catch (e) {
    if (e instanceof ObjectError && e.reason === 'notFound')
      return { address: sender, objectId, enabled: false, aliases: [sender] };
    throw e;
  }
  assert(
    normalizeStructTag(result.object.type) === normalizeStructTag(ALIASES_TYPE),
    'INVALID_ALIAS_STATE',
    'Derived object has an unexpected type.',
  );
  const parsed = AliasesBcs.parse(result.object.content);
  assert(
    parsed.id === objectId && parsed.aliases.length > 0 && parsed.aliases.length <= 8,
    'INVALID_ALIAS_STATE',
    'Invalid address alias state.',
  );
  assert(
    new Set(parsed.aliases).size === parsed.aliases.length &&
      Buffer.from(AliasesBcs.serialize(parsed).toBytes()).equals(
        Buffer.from(result.object.content),
      ),
    'INVALID_ALIAS_STATE',
    'Alias state has duplicate addresses or noncanonical BCS.',
  );
  return { address: sender, objectId, enabled: true, aliases: parsed.aliases.map(address) };
}

export interface AccountTransaction {
  type: 'multisig.account-transaction';
  version: 1;
  network: Network;
  chainIdentifier: string;
  sender: string;
  signerAddress: string;
  transactionBytes: string;
  digest: string;
  operation: 'alias.enable' | 'alias.add' | 'alias.remove' | 'alias.transfer-sui';
  expectedAliases?: string[];
}

export function aliasCommand(
  kind: 'enable' | 'add' | 'remove',
  owner: string,
  state: AliasState,
  alias?: string,
): Transaction {
  const tx = new Transaction();
  tx.setSender(address(owner));
  if (kind === 'enable') {
    assert(!state.enabled, 'ALIASES_ALREADY_ENABLED', 'Address aliases are already enabled.');
    tx.moveCall({ target: '0x2::address_alias::enable', arguments: [tx.object(ALIAS_STATE)] });
  } else {
    assert(state.enabled, 'ALIASES_NOT_ENABLED', 'Run alias enable for the address first.');
    const target = address(alias!);
    if (kind === 'add') {
      assert(
        !state.aliases.includes(target),
        'ALIAS_ALREADY_EXISTS',
        'This address is already an allowed alias.',
      );
      assert(
        state.aliases.length < 8,
        'TOO_MANY_ALIASES',
        'An address can have at most eight aliases.',
      );
    } else {
      assert(
        state.aliases.includes(target),
        'ALIAS_NOT_FOUND',
        'The alias is not currently authorized.',
      );
      assert(state.aliases.length > 1, 'LAST_ALIAS', 'Cannot remove the last alias.');
      assert(
        target !== state.address,
        'SELF_ALIAS_REMOVAL_DISABLED',
        'This CLI preserves the original address authority; removing its self-alias is not supported.',
      );
    }
    tx.moveCall({
      target: `0x2::address_alias::${kind}`,
      arguments: [tx.object(state.objectId), tx.pure.address(target)],
    });
  }
  return tx;
}

export async function buildAliasTransaction(
  client: SuiGrpcClient,
  input: {
    network: Network;
    owner: string;
    signerAddress: string;
    operation: 'enable' | 'add' | 'remove' | 'transfer-sui';
    alias?: string;
    recipient?: string;
    amount?: string;
  },
): Promise<AccountTransaction> {
  const owner = address(input.owner);
  const signerAddress = address(input.signerAddress);
  const state = await getAliases(client, owner);
  assert(
    state.aliases.includes(signerAddress),
    'SIGNER_NOT_AUTHORIZED',
    'Selected key is not an allowed alias for this address.',
  );
  if (input.operation === 'add') {
    assert(
      state.aliases.includes(owner),
      'ORIGINAL_NOT_AUTHORIZED',
      'This setup preserves the original key; its own address must still be authorized.',
    );
    assert(
      address(input.alias!) !== owner,
      'ALIAS_ALREADY_EXISTS',
      'The backup address must differ from the original address.',
    );
  }
  let tx: Transaction;
  let expectedAliases: string[] | undefined;
  if (input.operation === 'transfer-sui') {
    tx = new Transaction();
    tx.setSender(owner);
    const [coin] = tx.splitCoins(tx.gas, [amount(input.amount!)]);
    tx.transferObjects([coin], address(input.recipient!));
  } else {
    tx = aliasCommand(input.operation, owner, state, input.alias);
    expectedAliases =
      input.operation === 'enable'
        ? [owner]
        : input.operation === 'add'
          ? [...state.aliases, address(input.alias!)]
          : state.aliases.filter((a) => a !== address(input.alias!));
  }
  const { chainIdentifier } = await client.getChainIdentifier({
    signal: AbortSignal.timeout(20_000),
  });
  const bytes = await tx.build({ client });
  const transactionBytes = toBase64(bytes);
  transactionData(transactionBytes);
  return {
    type: 'multisig.account-transaction',
    version: 1,
    network: input.network,
    chainIdentifier,
    sender: owner,
    signerAddress,
    transactionBytes,
    digest: await Transaction.from(bytes).getDigest(),
    operation: `alias.${input.operation}`,
    ...(expectedAliases ? { expectedAliases } : {}),
  };
}

export async function signAliasTransaction(
  client: SuiGrpcClient,
  tx: AccountTransaction,
  signer: Signer,
  existingSignature?: string,
) {
  await validateAccountTransaction(tx);
  assert(
    signer.toSuiAddress() === tx.signerAddress,
    'WRONG_SIGNER',
    'The key does not match the planned signer.',
  );
  const actual = await client.getChainIdentifier({ signal: AbortSignal.timeout(20_000) });
  assert(
    actual.chainIdentifier === tx.chainIdentifier,
    'CHAIN_MISMATCH',
    'RPC chain identity changed after construction.',
  );
  const state = await getAliases(client, tx.sender);
  assert(
    state.aliases.includes(tx.signerAddress),
    'SIGNER_NOT_AUTHORIZED',
    'The key is no longer an allowed alias.',
  );
  if (existingSignature) {
    await verifyAccountSignature(tx, existingSignature);
    return existingSignature;
  }
  const bytes = base64(tx.transactionBytes);
  const signed = await signer.signTransaction(bytes);
  assert(
    await signer.getPublicKey().verifyTransaction(bytes, signed.signature),
    'INVALID_SIGNATURE',
    'Account signature failed SDK verification.',
  );
  return signed.signature;
}

export async function verifyAccountSignature(tx: AccountTransaction, signature: string) {
  const publicKey = await verifyTransactionSignature(base64(tx.transactionBytes), signature);
  assert(
    publicKey.toSuiAddress() === tx.signerAddress,
    'WRONG_SIGNER',
    'Saved account signature does not match the planned signer.',
  );
}

export async function executeAliasTransaction(
  client: SuiGrpcClient,
  tx: AccountTransaction,
  signature: string,
) {
  await validateAccountTransaction(tx);
  assert(
    (await client.getChainIdentifier({ signal: AbortSignal.timeout(20_000) })).chainIdentifier ===
      tx.chainIdentifier,
    'CHAIN_MISMATCH',
    'RPC chain identity changed before execution.',
  );
  let result;
  try {
    result = await client.executeTransaction({
      transaction: base64(tx.transactionBytes),
      signatures: [signature],
      include: { effects: true, balanceChanges: true },
      signal: AbortSignal.timeout(45_000),
    });
  } catch {
    throw new CliError({
      code: 'EXECUTION_UNKNOWN',
      message:
        'Alias transaction outcome is unknown. Reconcile the recorded digest before retrying.',
      exit: 5,
      details: { digest: tx.digest, sender: tx.sender, network: tx.network },
    });
  }
  return result;
}

export async function validateAccountTransaction(tx: AccountTransaction) {
  assert(
    tx.type === 'multisig.account-transaction' && tx.version === 1,
    'INVALID_FORMAT',
    'Unsupported account transaction format.',
  );
  const decoded = transactionData(tx.transactionBytes);
  assert(
    decoded.getData().sender === address(tx.sender),
    'WRONG_SENDER',
    'Account transaction sender does not match its metadata.',
  );
  assert(
    (await decoded.getDigest()) === tx.digest,
    'PROPOSAL_MISMATCH',
    'Account digest does not match the exact transaction bytes.',
  );
  const commands = decoded.getData().commands;
  if (tx.operation === 'alias.transfer-sui') {
    assert(
      commands.length === 2 &&
        commands[0]?.$kind === 'SplitCoins' &&
        commands[1]?.$kind === 'TransferObjects',
      'OPERATION_MISMATCH',
      'Transaction commands do not match a SUI transfer.',
    );
  } else {
    assert(
      ['alias.enable', 'alias.add', 'alias.remove'].includes(tx.operation),
      'OPERATION_MISMATCH',
      'Unknown account operation.',
    );
    const call = commands[0];
    assert(
      commands.length === 1 &&
        call?.$kind === 'MoveCall' &&
        address(call.MoveCall.package) === address('0x2') &&
        call.MoveCall.module === 'address_alias' &&
        call.MoveCall.function === tx.operation.slice(6),
      'OPERATION_MISMATCH',
      'Transaction commands do not match the reviewed alias operation.',
    );
    assert(
      tx.expectedAliases?.includes(address(tx.sender)),
      'ORIGINAL_NOT_AUTHORIZED',
      'The planned alias set must retain the original address.',
    );
  }
}
