import { test, expect } from 'bun:test';
import { p256 } from '@noble/curves/nist.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { blake2b } from '@noble/hashes/blake2.js';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import { verifyPersonalMessageSignature, verifyTransactionSignature } from '@mysten/sui/verify';
import { PivSigner, compactSignature, keyReference } from '../src/hardware.ts';
import { parseTlv, decodeSlot } from '../src/piv-native.ts';
import { fixtureProposal, c } from './domain.test.ts';

const privateKey = new Uint8Array(32).fill(3);
const ref = keyReference({
  serial: 123,
  slot: '9c',
  algorithm: 0x11,
  pinPolicy: 3,
  touchPolicy: 2,
  publicKeyHex: bytesToHex(p256.getPublicKey(privateKey, false)),
});
test('PIV digest boundary matches independent SDK transaction and BCS personal-message signing', async () => {
  let observed = '';
  const signer = new PivSigner(ref, async (digest, expected) => {
    observed = digest;
    expect(expected).toBe(bytesToHex(p256.getPublicKey(privateKey, false)));
    return bytesToHex(p256.sign(hexToBytes(digest), privateKey, { prehash: false, format: 'der' }));
  });
  const proposal = await fixtureProposal();
  const tx = Buffer.from(proposal.transactionBytes, 'base64');
  const signature = (await signer.signTransaction(tx)).signature;
  const prefix = Buffer.concat([Buffer.from([0, 0, 0]), tx]);
  expect(observed).toBe(bytesToHex(sha256(blake2b(prefix, { dkLen: 32 }))));
  expect((await verifyTransactionSignature(tx, signature)).toSuiAddress()).toBe(c.toSuiAddress());
  const message = new TextEncoder().encode('Sagat authentication with ✓');
  const signed = await signer.signPersonalMessage(message);
  expect((await verifyPersonalMessageSignature(message, signed.signature)).toSuiAddress()).toBe(
    c.toSuiAddress(),
  );
  expect(await c.getPublicKey().verifyPersonalMessage(message, signed.signature)).toBe(true);
});
test('high-S normalizes; malformed DER and incorrect hash layers fail', async () => {
  const digest = sha256(new Uint8Array([1]));
  const sig = p256.Signature.fromBytes(p256.sign(digest, privateKey, { prehash: false }));
  const n = p256.Point.Fn.ORDER;
  const high = new p256.Signature(sig.r, n - sig.s).toBytes('der');
  expect(p256.Signature.fromBytes(compactSignature(bytesToHex(high))).s <= n / 2n).toBe(true);
  expect(() => compactSignature('300602010102010100')).toThrow();
  const bad = new PivSigner(ref, async (d) =>
    bytesToHex(p256.sign(sha256(hexToBytes(d)), privateKey, { prehash: false, format: 'der' })),
  );
  await expect(bad.signPersonalMessage(new Uint8Array([1]))).rejects.toThrow();
});
test('native TLV parsing fails closed on missing, duplicate and truncated public metadata', () => {
  expect(() => parseTlv(new Uint8Array([1, 2, 3]))).toThrow();
  expect(() => parseTlv(new Uint8Array([1, 1, 3, 1, 1, 4]))).toThrow();
  expect(() => decodeSlot(new Uint8Array([1, 1, 0x11]), '9c', false)).toThrow();
});
test('firmware 5.8 ECC metadata unwraps its nested public-key template', () => {
  const point = p256.getPublicKey(privateKey, false);
  const metadata = Buffer.concat([
    Buffer.from([1, 1, 0x11, 2, 2, 3, 2, 3, 1, 1, 4, 67, 0x86, 65]),
    point,
  ]);
  const slot = decodeSlot(metadata, '9c', false);
  expect(slot.publicKeyHex).toBe(bytesToHex(point));
  expect(slot.pinPolicy).toBe(3);
  expect(slot.touchPolicy).toBe(2);
  expect(() =>
    decodeSlot(
      Buffer.concat([Buffer.from([1, 1, 0x11, 2, 2, 3, 2, 3, 1, 1, 4, 65]), point]),
      '9c',
      false,
    ),
  ).toThrow();
});
