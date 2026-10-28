import { describe, test, expect } from 'bun:test';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { Secp256k1Keypair } from '@mysten/sui/keypairs/secp256k1';
import { Secp256r1Keypair } from '@mysten/sui/keypairs/secp256r1';
import { Transaction } from '@mysten/sui/transactions';
import { toBase64 } from '@mysten/sui/utils';
import {
  createWallet,
  parseWallet,
  createProposal,
  parseProposal,
  combine,
  verifyMemberSignature,
  tally,
  type Proposal,
  type Signature,
} from '../src/domain.ts';
import { exportWallet, exportProposal, importProposal } from '../src/sagat.ts';

export const a = Ed25519Keypair.fromSecretKey(new Uint8Array(32).fill(1));
export const b = Secp256k1Keypair.fromSecretKey(new Uint8Array(32).fill(2));
export const c = Secp256r1Keypair.fromSecretKey(new Uint8Array(32).fill(3));
export const fixtureWallet = () =>
  createWallet(
    [a, b, c].map((k) => ({ publicKey: k.getPublicKey().toSuiPublicKey(), weight: 1 })),
    2,
    'test',
  );
export async function fixtureProposal() {
  const wallet = fixtureWallet();
  const tx = new Transaction();
  tx.setSender(wallet.address);
  tx.setGasOwner(wallet.address);
  tx.setGasBudget(1_000_000);
  tx.setGasPrice(1000);
  tx.setGasPayment([
    { objectId: '0x123', version: '1', digest: '11111111111111111111111111111111' },
  ]);
  const [coin] = tx.splitCoins(tx.gas, [1]);
  tx.transferObjects([coin], a.toSuiAddress());
  return createProposal(wallet, toBase64(await tx.build()), 'testnet', 'fixture-chain');
}
export async function signed(p: Proposal, k: typeof a | typeof b | typeof c): Promise<Signature> {
  const signature = (await k.signTransaction(Buffer.from(p.transactionBytes, 'base64'))).signature;
  return {
    type: 'multisig.signature',
    version: 1,
    proposalId: p.id,
    digest: p.digest,
    publicKey: k.getPublicKey().toSuiPublicKey(),
    signature,
  };
}
describe('native multisig invariants', () => {
  test('mixed-scheme 2/3 is independently verified by the SDK', async () => {
    const p = await fixtureProposal();
    const one = await signed(p, a),
      two = await signed(p, c);
    expect((await tally(p, [one])).ready).toBe(false);
    await expect(combine(p, [one])).rejects.toThrow('threshold');
    const result = await combine(p, [two, one]);
    expect(result.currentWeight).toBe(2);
    expect(result.ready).toBe(true);
  });
  test('duplicate keys, weights, thresholds and member-order substitution are rejected', () => {
    const wallet = fixtureWallet();
    expect(() => createWallet([wallet.members[0], wallet.members[0]], 2)).toThrow();
    expect(() =>
      createWallet([{ publicKey: a.getPublicKey().toSuiPublicKey(), weight: 1.1 }], 1),
    ).toThrow();
    expect(() =>
      createWallet([{ publicKey: a.getPublicKey().toSuiPublicKey(), weight: 1 }], 2),
    ).toThrow();
    expect(() => parseWallet({ ...wallet, members: [...wallet.members].reverse() })).toThrow();
    expect(() => parseWallet({ ...wallet, address: a.toSuiAddress() })).toThrow();
  });
  test('altered digest, bytes, sender, signer, duplicate and forged weight fail', async () => {
    const p = await fixtureProposal(),
      s = await signed(p, a);
    await expect(parseProposal({ ...p, digest: 'tampered' })).rejects.toThrow();
    await expect(
      parseProposal({ ...p, transactionBytes: toBase64(new Uint8Array([0, 1])) }),
    ).rejects.toThrow();
    await expect(
      verifyMemberSignature(p, { ...s, publicKey: b.getPublicKey().toSuiPublicKey() }),
    ).rejects.toThrow();
    await expect(tally(p, [s, s])).rejects.toThrow();
    await expect(verifyMemberSignature(p, { ...s, weight: 99 })).rejects.toThrow();
    const foreign = createWallet([{ publicKey: a.getPublicKey().toSuiPublicKey(), weight: 1 }], 1);
    await expect(createProposal(foreign, p.transactionBytes, 'testnet', null)).rejects.toThrow();
  });
  test('Sagat exports round-trip exact bytes, ordered composition and verified signatures', async () => {
    const p = await fixtureProposal();
    const sigs = [await signed(p, a), await signed(p, c)];
    expect(parseWallet(exportWallet(p.wallet))).toEqual(p.wallet);
    const exported = await exportProposal(p, sigs);
    const imported = await importProposal(exported);
    expect(imported.proposal.wallet).toEqual(p.wallet);
    expect(imported.proposal.transactionBytes).toBe(p.transactionBytes);
    expect((await combine(imported.proposal, imported.signatures)).ready).toBe(true);
    await expect(
      importProposal({ ...exported, proposal: { ...exported.proposal, digest: 'forged' } }),
    ).rejects.toThrow();
    const modified = structuredClone(exported);
    modified.proposal.signatures[0]!.weight = 255;
    expect(
      (
        await tally(
          (
            await importProposal(modified)
          ).proposal,
          (
            await importProposal(modified)
          ).signatures,
        )
      ).currentWeight,
    ).toBe(2);
  });
});
