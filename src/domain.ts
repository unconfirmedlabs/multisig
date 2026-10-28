import { Schema } from 'effect';
import { publicKeyFromSuiBytes } from '@mysten/sui/verify';
import { MultiSigPublicKey } from '@mysten/sui/multisig';
import { parseSerializedSignature } from '@mysten/sui/cryptography';
import { Transaction } from '@mysten/sui/transactions';
import { fromBase64, toBase64, normalizeSuiAddress, isValidSuiAddress } from '@mysten/sui/utils';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { assert, fail } from './errors.ts';

export const NETWORKS = ['mainnet', 'testnet', 'devnet', 'localnet'] as const;
export type Network = (typeof NETWORKS)[number];
export interface Member {
  publicKey: string;
  weight: number;
  order: number;
  label?: string;
}
export interface Wallet {
  type: 'multisig.wallet';
  version: 1;
  address: string;
  name: string | null;
  threshold: number;
  members: Member[];
}
export interface Proposal {
  type: 'multisig.proposal';
  version: 1;
  id: string;
  network: Network;
  chainIdentifier: string | null;
  wallet: Wallet;
  transactionBytes: string;
  digest: string;
  createdAt: string;
  description: string | null;
}
export interface Signature {
  type: 'multisig.signature';
  version: 1;
  proposalId: string;
  digest: string;
  publicKey: string;
  signature: string;
}
export interface KeyRef {
  type: 'multisig.piv-key';
  version: 1;
  serial: number;
  slot: string;
  publicKey: string;
  address: string;
  pinPolicy: number;
  touchPolicy: number;
}

const MemberSchema = Schema.Struct({
  publicKey: Schema.String,
  weight: Schema.Number,
  order: Schema.Number,
  label: Schema.optional(Schema.String),
});
const WalletSchema = Schema.Struct({
  type: Schema.Literal('multisig.wallet'),
  version: Schema.Literal(1),
  address: Schema.String,
  name: Schema.NullOr(Schema.String),
  threshold: Schema.Number,
  members: Schema.Array(MemberSchema),
});
const ProposalSchema = Schema.Struct({
  type: Schema.Literal('multisig.proposal'),
  version: Schema.Literal(1),
  id: Schema.String,
  network: Schema.Literal(...NETWORKS),
  chainIdentifier: Schema.NullOr(Schema.String),
  wallet: WalletSchema,
  transactionBytes: Schema.String,
  digest: Schema.String,
  createdAt: Schema.String,
  description: Schema.NullOr(Schema.String),
});
const SignatureSchema = Schema.Struct({
  type: Schema.Literal('multisig.signature'),
  version: Schema.Literal(1),
  proposalId: Schema.String,
  digest: Schema.String,
  publicKey: Schema.String,
  signature: Schema.String,
});
const KeySchema = Schema.Struct({
  type: Schema.Literal('multisig.piv-key'),
  version: Schema.Literal(1),
  serial: Schema.Number,
  slot: Schema.String,
  publicKey: Schema.String,
  address: Schema.String,
  pinPolicy: Schema.Number,
  touchPolicy: Schema.Number,
});
function decode<A, I>(schema: Schema.Schema<A, I>, input: unknown): A {
  try {
    return Schema.decodeUnknownSync(schema, { onExcessProperty: 'error' })(input);
  } catch {
    fail('INVALID_FORMAT', 'Input does not match its versioned schema.');
  }
}
export function record(input: unknown): Record<string, any> {
  assert(
    input && typeof input === 'object' && !Array.isArray(input),
    'INVALID_FORMAT',
    'Expected a JSON object.',
  );
  return input as Record<string, any>;
}
export function base64(value: string): Uint8Array {
  assert(
    typeof value === 'string' && value.length > 0 && /^[A-Za-z0-9+/]*={0,2}$/.test(value),
    'INVALID_BASE64',
    'Expected canonical padded base64.',
  );
  const bytes = fromBase64(value);
  assert(toBase64(bytes) === value, 'INVALID_BASE64', 'Expected canonical padded base64.');
  return bytes;
}
export function address(value: string): string {
  assert(
    typeof value === 'string' && isValidSuiAddress(normalizeSuiAddress(value)),
    'INVALID_ADDRESS',
    'Invalid Sui address.',
  );
  return normalizeSuiAddress(value);
}
export function publicKey(value: string) {
  const bytes = base64(value);
  assert(
    [0, 1, 2].includes(bytes[0]!),
    'UNSUPPORTED_SCHEME',
    'Members must use Ed25519, Secp256k1, or Secp256r1.',
  );
  const key = publicKeyFromSuiBytes(bytes);
  assert(
    key.toSuiPublicKey() === value,
    'INVALID_PUBLIC_KEY',
    'Public key must include its Sui scheme flag.',
  );
  return key;
}
export function multisig(wallet: Wallet) {
  return MultiSigPublicKey.fromPublicKeys({
    threshold: wallet.threshold,
    publicKeys: wallet.members.map((m) => ({
      publicKey: publicKey(m.publicKey),
      weight: m.weight,
    })),
  });
}
export function createWallet(
  membersInput: unknown,
  threshold: number,
  name: string | null = null,
): Wallet {
  assert(
    Array.isArray(membersInput) && membersInput.length >= 1 && membersInput.length <= 10,
    'INVALID_MEMBERS',
    'A native multisig needs 1–10 members.',
  );
  const members: Member[] = membersInput.map((input, i) => {
    const m = record(input);
    assert(
      m.order === undefined || m.order === i,
      'INVALID_ORDER',
      'Members must be in contiguous order starting at zero.',
    );
    assert(
      Number.isInteger(m.weight) && m.weight >= 1 && m.weight <= 255,
      'INVALID_WEIGHT',
      'Member weights must be integers from 1 to 255.',
    );
    publicKey(m.publicKey);
    return {
      publicKey: m.publicKey,
      weight: m.weight,
      order: i,
      ...(typeof m.label === 'string' ? { label: m.label } : {}),
    };
  });
  assert(
    new Set(members.map((m) => m.publicKey)).size === members.length,
    'DUPLICATE_MEMBER',
    'A member key can appear only once.',
  );
  assert(
    Number.isInteger(threshold) &&
      threshold >= 1 &&
      threshold <= 65535 &&
      threshold <= members.reduce((s, m) => s + m.weight, 0),
    'INVALID_THRESHOLD',
    'Threshold must be reachable and a positive u16.',
  );
  const wallet: Wallet = {
    type: 'multisig.wallet',
    version: 1,
    address: '',
    name,
    threshold,
    members,
  };
  wallet.address = multisig(wallet).toSuiAddress();
  return wallet;
}
export function parseWallet(input: unknown): Wallet {
  const raw = record(input);
  let value: Record<string, any>;
  if (raw.type === 'sagat.multisig-composition' && raw.version === 1) value = record(raw.multisig);
  else value = record(decode(WalletSchema, raw));
  const wallet = createWallet(value.members, value.threshold, value.name ?? null);
  assert(
    value.address === wallet.address,
    'WALLET_ADDRESS_MISMATCH',
    'Composition does not derive the declared multisig address.',
  );
  return wallet;
}
export function parseKey(input: unknown): KeyRef {
  const key = decode(KeySchema, input);
  assert(
    Number.isSafeInteger(key.serial) &&
      key.serial > 0 &&
      /^(9a|9c|9d|9e|8[2-9a-f]|9[0-5])$/.test(key.slot),
    'INVALID_KEY_REF',
    'Invalid device serial or PIV slot.',
  );
  assert(
    base64(key.publicKey)[0] === 2 && publicKey(key.publicKey).toSuiAddress() === key.address,
    'INVALID_KEY_REF',
    'Key must identify a Secp256r1 Sui address.',
  );
  return { ...key };
}
export function proposalId(network: string, walletAddress: string, bytes: string) {
  return bytesToHex(
    sha256(new TextEncoder().encode(JSON.stringify([network, walletAddress, bytes]))),
  );
}
export function transactionData(bytes: string) {
  const data = base64(bytes);
  const tx = Transaction.from(data);
  const value = tx.getData();
  assert(value.sender, 'MISSING_SENDER', 'TransactionData must have a sender.');
  assert(
    value.gasData.owner === value.sender,
    'SPONSORED_UNSUPPORTED',
    'A separate gas owner requires sponsor signatures; v1 accepts self-funded transactions.',
  );
  assert(
    value.gasData.budget !== null && value.gasData.price !== null && value.gasData.payment !== null,
    'UNBUILT_TRANSACTION',
    'Import finalized TransactionData bytes, not transaction-kind bytes.',
  );
  return tx;
}
export async function createProposal(
  wallet: Wallet,
  bytes: string,
  network: Network,
  chainIdentifier: string | null,
  description: string | null = null,
): Promise<Proposal> {
  assert(
    NETWORKS.includes(network),
    'INVALID_NETWORK',
    'Choose mainnet, testnet, devnet, or localnet.',
  );
  const tx = transactionData(bytes);
  assert(
    tx.getData().sender === wallet.address,
    'WRONG_SENDER',
    'Transaction sender must be the multisig address.',
  );
  return {
    type: 'multisig.proposal',
    version: 1,
    id: proposalId(network, wallet.address, bytes),
    network,
    chainIdentifier,
    wallet,
    transactionBytes: bytes,
    digest: await tx.getDigest(),
    createdAt: new Date().toISOString(),
    description,
  };
}
export async function parseProposal(input: unknown): Promise<Proposal> {
  const p = decode(ProposalSchema, input);
  const wallet = parseWallet(p.wallet);
  const expected = await createProposal(
    wallet,
    p.transactionBytes,
    p.network,
    p.chainIdentifier,
    p.description,
  );
  assert(
    expected.id === p.id && expected.digest === p.digest,
    'PROPOSAL_MISMATCH',
    'Proposal digest or ID does not match transaction bytes.',
  );
  assert(
    p.chainIdentifier === null || (p.chainIdentifier.length > 0 && p.chainIdentifier.length <= 128),
    'INVALID_CHAIN',
    'Invalid chain identifier.',
  );
  return { ...p, wallet };
}
export async function verifyMemberSignature(p: Proposal, input: unknown): Promise<Signature> {
  const s = decode(SignatureSchema, input);
  assert(
    s.proposalId === p.id && s.digest === p.digest,
    'WRONG_PROPOSAL',
    'Signature belongs to a different proposal.',
  );
  assert(
    p.wallet.members.some((m) => m.publicKey === s.publicKey),
    'NOT_MEMBER',
    'Signature key is not a member of this composition.',
  );
  const key = publicKey(s.publicKey);
  const parsed = parseSerializedSignature(s.signature);
  assert(
    ['ED25519', 'Secp256k1', 'Secp256r1'].includes(parsed.signatureScheme),
    'UNSUPPORTED_SCHEME',
    'Expected a single-member signature.',
  );
  assert(
    await key.verifyTransaction(base64(p.transactionBytes), s.signature),
    'INVALID_SIGNATURE',
    'Signature does not verify against the exact transaction bytes and member key.',
  );
  return { ...s };
}
export async function tally(p: Proposal, signatures: unknown[]) {
  const verified: Signature[] = [];
  for (const input of signatures) {
    const s = await verifyMemberSignature(p, input);
    assert(
      !verified.some((v) => v.publicKey === s.publicKey),
      'DUPLICATE_SIGNATURE',
      'Only one signature per member is allowed.',
    );
    verified.push(s);
  }
  verified.sort(
    (a, b) =>
      p.wallet.members.findIndex((m) => m.publicKey === a.publicKey) -
      p.wallet.members.findIndex((m) => m.publicKey === b.publicKey),
  );
  const weight = verified.reduce(
    (sum, s) => sum + p.wallet.members.find((m) => m.publicKey === s.publicKey)!.weight,
    0,
  );
  return {
    signatures: verified,
    currentWeight: weight,
    threshold: p.wallet.threshold,
    ready: weight >= p.wallet.threshold,
  };
}
export async function combine(p: Proposal, signatures: unknown[]) {
  const result = await tally(p, signatures);
  assert(
    result.ready,
    'THRESHOLD_NOT_MET',
    `Collected weight ${result.currentWeight}; threshold is ${result.threshold}.`,
  );
  const signature = multisig(p.wallet).combinePartialSignatures(
    result.signatures.map((s) => s.signature),
  );
  assert(
    await multisig(p.wallet).verifyTransaction(base64(p.transactionBytes), signature),
    'INVALID_MULTISIG',
    'Combined signature failed SDK verification.',
  );
  return { ...result, signature, digest: p.digest, transactionBytes: p.transactionBytes };
}
