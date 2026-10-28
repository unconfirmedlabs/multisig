import { Context, Layer } from 'effect';
import { Signer } from '@mysten/sui/cryptography';
import { Secp256r1PublicKey } from '@mysten/sui/keypairs/secp256r1';
import { p256 } from '@noble/curves/nist.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { hexToBytes, bytesToHex } from '@noble/hashes/utils.js';
import type { NativeRequest } from './piv-native.ts';
import { CliError, assert } from './errors.ts';
import type { KeyRef } from './domain.ts';
import { parseKey, publicKey } from './domain.ts';
import { withDeviceLock } from './store.ts';
import { homedir } from 'node:os';
import { join } from 'node:path';

export function compactSignature(derHex: string): Uint8Array {
  assert(
    typeof derHex === 'string' && /^(?:[a-f0-9]{2}){8,80}$/.test(derHex),
    'INVALID_SIGNATURE',
    'Malformed DER signature.',
  );
  try {
    const signature = p256.Signature.fromBytes(hexToBytes(derHex), 'der');
    const n = p256.Point.Fn.ORDER;
    assert(
      signature.r > 0n && signature.r < n && signature.s > 0n && signature.s < n,
      'INVALID_SIGNATURE',
      'ECDSA scalars are outside the P-256 order.',
    );
    const lowS = signature.s > n / 2n ? n - signature.s : signature.s;
    return new p256.Signature(signature.r, lowS).toBytes('compact');
  } catch {
    throw new CliError({ code: 'INVALID_SIGNATURE', message: 'Invalid P-256 DER signature.' });
  }
}
export function keyReference(info: Record<string, any>): KeyRef {
  assert(
    info.algorithm === 0x11 && !info.empty && typeof info.publicKeyHex === 'string',
    'WRONG_DEVICE_KEY',
    'Expected a P-256 key in the selected slot.',
  );
  const compressed = p256.Point.fromHex(info.publicKeyHex).toBytes(true);
  const key = new Secp256r1PublicKey(compressed);
  return parseKey({
    type: 'multisig.piv-key',
    version: 1,
    serial: info.serial,
    slot: info.slot,
    publicKey: key.toSuiPublicKey(),
    address: key.toSuiAddress(),
    pinPolicy: info.pinPolicy,
    touchPolicy: info.touchPolicy,
  });
}

export async function nativeCall(request: NativeRequest, timeoutMs = 45_000): Promise<any> {
  const compiled = Bun.main.startsWith('/$bunfs/') || Bun.main.includes('$bunfs');
  const args = compiled
    ? [process.execPath, '--internal-piv']
    : [process.execPath, Bun.main, '--internal-piv'];
  const child = Bun.spawn(args, {
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'inherit',
    env: { ...process.env, RUST_LOG: undefined },
  });
  const abort = () => child.kill('SIGKILL');
  process.once('SIGINT', abort);
  process.once('SIGTERM', abort);
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill('SIGKILL');
  }, timeoutMs);
  try {
    child.stdin.write(JSON.stringify(request));
    child.stdin.end();
    delete request.pin;
    delete request.managementKey;
    const output = await new Response(child.stdout).text();
    const code = await child.exited;
    assert(output.length <= 128 * 1024, 'PIV_ERROR', 'Native response exceeded its size limit.');
    if (timedOut || code !== 0)
      throw new CliError({
        code: request.op === 'generate' ? 'GENERATION_UNKNOWN' : 'PIV_UNAVAILABLE',
        message:
          request.op === 'generate'
            ? 'The native operation stopped; generation may have occurred. Inspect/export the slot before retrying.'
            : 'PIV operation stopped or timed out.',
        exit: request.op === 'generate' ? 5 : 3,
      });
    let response;
    try {
      response = JSON.parse(output);
    } catch {
      throw new CliError({
        code: 'PIV_ERROR',
        message: 'Native worker returned an invalid response.',
        exit: 3,
      });
    }
    if (!response.ok) throw new CliError(response.error);
    return response.data;
  } finally {
    clearTimeout(timer);
    process.removeListener('SIGINT', abort);
    process.removeListener('SIGTERM', abort);
  }
}
export class Hardware extends Context.Tag('multisig/Hardware')<
  Hardware,
  {
    call: (request: NativeRequest) => Promise<any>;
  }
>() {}
export function hardwareLayer(root: string, library?: string) {
  return Layer.succeed(Hardware, {
    call: (request) =>
      request.op === 'devices'
        ? nativeCall({ ...request, library })
        : withDeviceLock(join(homedir(), '.cache', 'multisig'), request.serial!, () =>
            nativeCall({ ...request, library }),
          ),
  });
}

export class PivSigner extends Signer {
  constructor(
    readonly reference: KeyRef,
    readonly signDigest: (digest: string, expectedPublicKey: string) => Promise<string>,
  ) {
    super();
  }
  getKeyScheme() {
    return 'Secp256r1' as const;
  }
  getPublicKey() {
    return publicKey(this.reference.publicKey) as Secp256r1PublicKey;
  }
  async sign(bytes: Uint8Array): Promise<Uint8Array<ArrayBuffer>> {
    // SDK signWithIntent already adds the intent and Blake2b. ECDSA adds SHA-256 once.
    const digest = sha256(bytes);
    const point = p256.Point.fromBytes(this.getPublicKey().toRawBytes()).toBytes(false);
    const der = await this.signDigest(bytesToHex(digest), bytesToHex(point));
    const signature = compactSignature(der);
    assert(
      p256.verify(signature, digest, this.getPublicKey().toRawBytes(), {
        prehash: false,
        lowS: true,
      }),
      'INVALID_SIGNATURE',
      'Hardware signature failed independent P-256 verification.',
    );
    return Uint8Array.from(signature);
  }
}
