import { Context, Layer } from 'effect';
import { SuiGrpcClient } from '@mysten/sui/grpc';
import { Transaction, coinWithBalance } from '@mysten/sui/transactions';
import { toBase64 } from '@mysten/sui/utils';
import type { Network, Proposal, Wallet } from './domain.ts';
import { address, base64, createProposal } from './domain.ts';
import { assert, CliError } from './errors.ts';

export const endpoints: Record<Network, string> = {
  mainnet: 'https://fullnode.mainnet.sui.io:443',
  testnet: 'https://fullnode.testnet.sui.io:443',
  devnet: 'https://fullnode.devnet.sui.io:443',
  localnet: 'http://127.0.0.1:9000',
};
export function validateEndpoint(url: string) {
  const value = new URL(url);
  assert(
    !value.username && !value.password && !value.search && !value.hash,
    'INVALID_ENDPOINT',
    'Endpoints cannot contain credentials, a query, or a fragment.',
  );
  assert(
    value.protocol === 'https:' ||
      (value.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(value.hostname)),
    'INVALID_ENDPOINT',
    'Use HTTPS, or HTTP on localhost.',
  );
  return url.replace(/\/$/, '');
}
export class Chain extends Context.Tag('multisig/Chain')<
  Chain,
  {
    client: (network: Network, rpc?: string) => SuiGrpcClient;
  }
>() {}
export const ChainLive = Layer.succeed(Chain, {
  client: (network, rpc) =>
    new SuiGrpcClient({
      network: network === 'localnet' ? 'unknown' : network,
      baseUrl: validateEndpoint(rpc ?? endpoints[network]),
    }),
});
export async function checkChain(
  client: SuiGrpcClient,
  proposal: Proposal,
  allowUnverified = false,
) {
  const { chainIdentifier } = await client.getChainIdentifier({
    signal: AbortSignal.timeout(20_000),
  });
  assert(
    proposal.chainIdentifier !== null || allowUnverified,
    'CHAIN_UNVERIFIED',
    'Proposal has no pinned chain identity. Import it with --pin-chain, or explicitly use --allow-unverified-network.',
  );
  assert(
    proposal.chainIdentifier === null || proposal.chainIdentifier === chainIdentifier,
    'CHAIN_MISMATCH',
    'RPC chain identifier differs from the proposal.',
  );
  return chainIdentifier;
}
export interface BuildInput {
  kind: 'sui' | 'coin' | 'object' | 'json';
  recipient?: string;
  amount?: string;
  coinType?: string;
  objectIds?: string[];
  json?: unknown;
  gasBudget?: string;
}
export function amount(value: string): bigint {
  assert(
    /^(0|[1-9][0-9]*)$/.test(value),
    'INVALID_AMOUNT',
    'Amounts are integer base units expressed as decimal strings.',
  );
  const number = BigInt(value);
  assert(
    number > 0n && number <= (1n << 64n) - 1n,
    'INVALID_AMOUNT',
    'Amount must be a positive u64.',
  );
  return number;
}
export async function buildProposal(
  client: SuiGrpcClient,
  wallet: Wallet,
  network: Network,
  input: BuildInput,
  description: string | null,
) {
  const tx =
    input.kind === 'json' ? Transaction.from(JSON.stringify(input.json)) : new Transaction();
  assert(
    !tx.getData().sender || tx.getData().sender === wallet.address,
    'WRONG_SENDER',
    'Transaction JSON declares a different sender.',
  );
  tx.setSender(wallet.address);
  if (input.gasBudget) tx.setGasBudget(amount(input.gasBudget));
  if (input.kind === 'sui') {
    const [coin] = tx.splitCoins(tx.gas, [amount(input.amount!)]);
    tx.transferObjects([coin], address(input.recipient!));
  } else if (input.kind === 'coin') {
    tx.transferObjects(
      [coinWithBalance({ type: input.coinType!, balance: amount(input.amount!) })],
      address(input.recipient!),
    );
  } else if (input.kind === 'object') {
    assert(input.objectIds?.length, 'MISSING_OBJECT', 'Provide at least one --object.');
    tx.transferObjects(
      input.objectIds!.map((id) => tx.object(address(id))),
      address(input.recipient!),
    );
  }
  const chain = await client.getChainIdentifier({ signal: AbortSignal.timeout(20_000) });
  const bytes = await tx.build({ client });
  return createProposal(wallet, toBase64(bytes), network, chain.chainIdentifier, description);
}
export async function simulate(client: SuiGrpcClient, p: Proposal) {
  // Bytes are already finalized. No Transaction builder or gas selection here.
  return client.simulateTransaction({
    transaction: base64(p.transactionBytes),
    checksEnabled: true,
    doGasSelection: false,
    include: { effects: true, balanceChanges: true },
    signal: AbortSignal.timeout(30_000),
  });
}
export async function executeExact(client: SuiGrpcClient, p: Proposal, signature: string) {
  try {
    return await client.executeTransaction({
      transaction: base64(p.transactionBytes),
      signatures: [signature],
      include: { effects: true, balanceChanges: true },
      signal: AbortSignal.timeout(45_000),
    });
  } catch {
    throw new CliError({
      code: 'EXECUTION_UNKNOWN',
      message:
        'Submission did not return a definitive result. Reconcile this digest before retrying; no automatic retry was attempted.',
      exit: 5,
      details: { digest: p.digest, network: p.network },
    });
  }
}
