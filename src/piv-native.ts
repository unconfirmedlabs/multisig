// Loaded only in an isolated invocation of the same CLI. No Rust/helper executable.
import { dlopen, ptr, toArrayBuffer, type Pointer } from 'bun:ffi';
import { assert, CliError } from './errors.ts';
import { PIV_SLOTS } from './slots.ts';
import type { ScannedSlot } from './slots.ts';

const bindings = {
  ykpiv_init: { args: ['ptr', 'i32'], returns: 'i32' },
  ykpiv_done: { args: ['ptr'], returns: 'i32' },
  ykpiv_list_readers: { args: ['ptr', 'ptr', 'ptr'], returns: 'i32' },
  ykpiv_connect: { args: ['ptr', 'ptr'], returns: 'i32' },
  ykpiv_disconnect: { args: ['ptr'], returns: 'i32' },
  ykpiv_get_serial: { args: ['ptr', 'ptr'], returns: 'i32' },
  ykpiv_get_version: { args: ['ptr', 'ptr', 'u64'], returns: 'i32' },
  ykpiv_transfer_data: { args: ['ptr', 'ptr', 'ptr', 'i64', 'ptr', 'ptr', 'ptr'], returns: 'i32' },
  ykpiv_authenticate2: { args: ['ptr', 'ptr', 'u64'], returns: 'i32' },
  ykpiv_verify_select: { args: ['ptr', 'ptr', 'u64', 'ptr', 'bool'], returns: 'i32' },
  ykpiv_sign_data: { args: ['ptr', 'ptr', 'u64', 'ptr', 'ptr', 'u8', 'u8'], returns: 'i32' },
  ykpiv_util_generate_key: {
    args: ['ptr', 'u8', 'u8', 'u8', 'u8', 'ptr', 'ptr', 'ptr', 'ptr', 'ptr', 'ptr'],
    returns: 'i32',
  },
  ykpiv_util_free: { args: ['ptr', 'ptr'], returns: 'i32' },
} as const;

export interface NativeRequest {
  op: 'devices' | 'slots' | 'inspect' | 'generate' | 'sign';
  serial?: number;
  slot?: string;
  library?: string;
  managementKey?: string;
  pin?: string;
  digest?: string;
  expectedPublicKey?: string;
}
export interface SlotInfo {
  slot: string;
  empty: boolean;
  publicKeyHex?: string;
  algorithm?: number;
  pinPolicy?: number;
  touchPolicy?: number;
  origin?: number;
  certificatePresent: boolean;
}

export function parseTlv(data: Uint8Array): Map<number, Uint8Array> {
  const result = new Map<number, Uint8Array>();
  for (let offset = 0; offset < data.length; ) {
    const tag = data[offset++]!;
    assert(offset < data.length, 'MALFORMED_METADATA', 'Truncated TLV length.');
    let length = data[offset++]!;
    if (length & 0x80) {
      const count = length & 0x7f;
      assert(
        count >= 1 && count <= 3 && offset + count <= data.length,
        'MALFORMED_METADATA',
        'Invalid TLV length.',
      );
      length = 0;
      for (let i = 0; i < count; i++) length = length * 256 + data[offset++]!;
    }
    assert(
      !result.has(tag) && offset + length <= data.length,
      'MALFORMED_METADATA',
      'Duplicate or truncated TLV value.',
    );
    result.set(tag, data.slice(offset, offset + length));
    offset += length;
  }
  return result;
}
export function decodeSlot(
  metadata: Uint8Array,
  slot: string,
  certificatePresent: boolean,
): SlotInfo {
  const values = parseTlv(metadata);
  const algorithm = values.get(1);
  const policy = values.get(2);
  const origin = values.get(3);
  const pub = values.get(4);
  assert(
    algorithm?.length === 1 &&
      policy?.length === 2 &&
      origin?.length === 1 &&
      pub &&
      pub.length > 0,
    'SLOT_STATE_UNKNOWN',
    'Slot metadata is incomplete; refusing to infer an empty slot.',
  );
  // PIV tag 04 contains the algorithm's public-key template, not bare SEC1 bytes.
  // ECC templates wrap the uncompressed point in tag 86 (e.g. 86 41 04... for P-256).
  let point = pub;
  if (algorithm[0] === 0x11 || algorithm[0] === 0x14) {
    const template = parseTlv(pub);
    const value = template.get(0x86);
    assert(
      template.size === 1 && value?.length === (algorithm[0] === 0x11 ? 65 : 97) && value[0] === 4,
      'MALFORMED_METADATA',
      'Invalid ECC public-key template.',
    );
    point = value;
  }
  return {
    slot,
    empty: false,
    algorithm: algorithm[0],
    pinPolicy: policy[0],
    touchPolicy: policy[1],
    origin: origin[0],
    publicKeyHex: Buffer.from(point).toString('hex'),
    certificatePresent,
  };
}
const certTags: Record<string, number> = { '9a': 0x05, '9c': 0x0a, '9d': 0x0b, '9e': 0x01 };
function slotNumber(slot: string) {
  assert(
    /^(9a|9c|9d|9e|8[2-9a-f]|9[0-5])$/.test(slot),
    'INVALID_SLOT',
    'Choose a signing-capable PIV slot; management and attestation slots are forbidden.',
  );
  return parseInt(slot, 16);
}

export async function nativeOperation(request: NativeRequest): Promise<unknown> {
  assert(
    process.arch === 'arm64' || process.arch === 'x64',
    'UNSUPPORTED_ABI',
    'PIV FFI currently supports 64-bit arm64/x64 ABIs.',
  );
  assert(
    process.platform === 'darwin' || process.platform === 'linux',
    'UNSUPPORTED_PLATFORM',
    'PIV FFI currently supports macOS and Linux.',
  );
  const paths = request.library
    ? [request.library]
    : process.platform === 'darwin'
      ? ['/opt/homebrew/lib/libykpiv.dylib', '/usr/local/lib/libykpiv.dylib']
      : [
          '/usr/lib/x86_64-linux-gnu/libykpiv.so',
          '/usr/lib/aarch64-linux-gnu/libykpiv.so',
          '/usr/local/lib/libykpiv.so',
        ];
  assert(
    paths.every((p) => p.startsWith('/')),
    'INVALID_LIBRARY',
    'Native library paths must be absolute.',
  );
  const path = (
    await Promise.all(paths.map(async (p) => ((await Bun.file(p).exists()) ? p : null)))
  ).find(Boolean);
  assert(
    path,
    'PIV_LIBRARY_MISSING',
    'Install Yubico libykpiv: `brew install yubico-piv-tool` or `apt install libykpiv-dev`.',
  );
  const library = dlopen(path!, bindings);
  const lib = library.symbols;
  function check(rc: number, operation: string) {
    if (rc === 0) return;
    const code =
      rc === -10
        ? 'PIN_REJECTED'
        : rc === -13
          ? 'PIN_LOCKED'
          : rc === -5
            ? 'AUTHENTICATION_FAILED'
            : 'PIV_ERROR';
    throw new CliError({
      code,
      message: `Yubico ${operation} failed (code ${rc}). No authentication retry was attempted.`,
      exit: 3,
    });
  }
  const cell = new BigUint64Array(1);
  let state: Pointer | null = null;
  try {
    check(lib.ykpiv_init(ptr(cell), 0), 'initialization');
    state = Number(cell[0]) as Pointer;
    assert(
      state && Number.isSafeInteger(state),
      'PIV_ERROR',
      'Native library returned an invalid state pointer.',
    );
    const readerBuffer = Buffer.alloc(8192);
    const readerLength = new BigUint64Array([8192n]);
    check(
      lib.ykpiv_list_readers(state, ptr(readerBuffer), ptr(readerLength)),
      'reader enumeration',
    );
    assert(readerLength[0]! <= 8192n, 'PIV_ERROR', 'Reader enumeration exceeded its buffer.');
    const readers = readerBuffer
      .subarray(0, Number(readerLength[0]))
      .toString('utf8')
      .split('\0')
      .filter(Boolean);
    const devices: { serial: number; firmware: string; reader: string }[] = [];
    let selected = false;
    for (const reader of readers) {
      if (!/yubi/i.test(reader)) continue;
      const name = Buffer.from(reader + '\0');
      check(lib.ykpiv_connect(state, ptr(name)), 'connection');
      const serial = new Uint32Array(1);
      const version = Buffer.alloc(64);
      check(lib.ykpiv_get_serial(state, ptr(serial)), 'serial read');
      check(lib.ykpiv_get_version(state, ptr(version), 64n), 'version read');
      const device = {
        serial: serial[0]!,
        firmware: version.toString('utf8').split('\0')[0]!,
        reader,
      };
      devices.push(device);
      if (request.op !== 'devices' && request.serial === device.serial) {
        selected = true;
        break;
      }
      check(lib.ykpiv_disconnect(state), 'disconnect');
    }
    if (request.op === 'devices') return { devices, library: path };
    assert(
      selected,
      'DEVICE_NOT_FOUND',
      'The requested YubiKey serial is not connected or PIV is unavailable.',
    );
    function apdu(template: number[], input = Buffer.alloc(0)) {
      const command = Buffer.from(template);
      const output = Buffer.alloc(8192);
      const length = new BigUint64Array([8192n]);
      const status = new Int32Array(1);
      check(
        lib.ykpiv_transfer_data(
          state!,
          ptr(command),
          input.length ? ptr(input) : null,
          BigInt(input.length),
          ptr(output),
          ptr(length),
          ptr(status),
        ),
        'APDU transport',
      );
      assert(length[0]! <= 8192n, 'PIV_ERROR', 'APDU response exceeded its buffer.');
      return { status: status[0]!, data: output.subarray(0, Number(length[0])) };
    }
    function inspect(slot: string): SlotInfo {
      const slotId = slotNumber(slot);
      const metadata = apdu([0, 0xf7, 0, slotId]);
      const cert = certTags[slot] ?? 0x0d + slotId - 0x82;
      const object = apdu([0, 0xcb, 0x3f, 0xff], Buffer.from([0x5c, 3, 0x5f, 0xc1, cert]));
      assert(
        object.status === 0x9000 || object.status === 0x6a82,
        'SLOT_STATE_UNKNOWN',
        'Certificate state could not be read.',
      );
      if (metadata.status === 0x6a88) {
        assert(
          object.status === 0x6a82,
          'SLOT_OCCUPIED',
          'A certificate exists in this slot; refusing generation.',
        );
        return { slot, empty: true, certificatePresent: false };
      }
      assert(
        metadata.status === 0x9000,
        'SLOT_STATE_UNKNOWN',
        `Metadata is unavailable (status ${metadata.status.toString(16)}); refusing generation.`,
      );
      return decodeSlot(metadata.data, slot, object.status === 0x9000);
    }
    if (request.op === 'slots') {
      const slots: ScannedSlot[] = PIV_SLOTS.map((definition) => {
        try {
          const info = inspect(definition.slot);
          return { ...definition, ...info, state: info.empty ? 'empty' : 'occupied' };
        } catch (e) {
          const error =
            e instanceof CliError
              ? { code: e.code, message: e.message }
              : { code: 'SLOT_STATE_UNKNOWN', message: 'Slot metadata could not be read.' };
          return {
            ...definition,
            state: error.code === 'SLOT_OCCUPIED' ? 'occupied' : 'unknown',
            ...(error.code === 'SLOT_OCCUPIED' ? { certificatePresent: true } : {}),
            error,
          };
        }
      });
      return { ...devices.at(-1), slots };
    }
    const slot = request.slot!;
    const slotId = slotNumber(slot);
    const before = inspect(slot);
    if (request.op === 'inspect') return { ...devices.at(-1), ...before };
    if (request.op === 'generate') {
      assert(
        before.empty,
        'SLOT_OCCUPIED',
        'This PIV slot already holds a key; overwriting is not supported.',
      );
      const key = Buffer.from(request.managementKey ?? '', 'hex');
      try {
        assert(
          [16, 24, 32].includes(key.length),
          'INVALID_CREDENTIAL',
          'Management key must contain 16, 24, or 32 bytes.',
        );
        check(
          lib.ykpiv_authenticate2(state, ptr(key), BigInt(key.length)),
          'management authentication',
        );
      } finally {
        key.fill(0);
        delete request.managementKey;
      }
      // Recheck immediately before mutation. Other PIV applications must remain closed.
      assert(inspect(slot).empty, 'SLOT_OCCUPIED', 'The selected PIV slot is no longer empty.');
      const point = new BigUint64Array(1);
      const length = new BigUint64Array(1);
      let generatedHex: string | undefined;
      try {
        const rc = lib.ykpiv_util_generate_key(
          state,
          slotId,
          0x11,
          3,
          2,
          null,
          null,
          null,
          null,
          ptr(point),
          ptr(length),
        );
        if (rc !== 0)
          throw new CliError({
            code: 'GENERATION_UNKNOWN',
            message:
              'Key generation may have been applied. Inspect/recover this slot before retrying.',
            exit: 5,
            details: { serial: request.serial, slot, nativeCode: rc },
          });
        if (!point[0] || length[0] !== 65n)
          throw new CliError({
            code: 'GENERATION_UNKNOWN',
            message: 'Generation returned an unexpected public point. Inspect/recover the slot.',
            exit: 5,
            details: { serial: request.serial, slot },
          });
        generatedHex = Buffer.from(toArrayBuffer(Number(point[0]) as Pointer, 0, 65)).toString(
          'hex',
        );
      } finally {
        if (point[0]) lib.ykpiv_util_free(state, Number(point[0]) as Pointer);
      }
      let after: SlotInfo;
      try {
        after = inspect(slot);
      } catch {
        throw new CliError({
          code: 'GENERATION_UNKNOWN',
          message:
            'Key was generated but post-generation inspection failed. Recover the public key from metadata.',
          exit: 5,
          details: { serial: request.serial, slot, publicKeyHex: generatedHex },
        });
      }
      if (after.publicKeyHex !== generatedHex || after.pinPolicy !== 3 || after.touchPolicy !== 2)
        throw new CliError({
          code: 'GENERATION_UNKNOWN',
          message: 'Generated key/policy verification failed. Inspect and recover the slot.',
          exit: 5,
          details: { serial: request.serial, slot, publicKeyHex: generatedHex },
        });
      return {
        serial: request.serial,
        firmware: devices.at(-1)!.firmware,
        ...after,
        outcome: 'applied',
      };
    }
    assert(
      !before.empty && before.algorithm === 0x11,
      'WRONG_DEVICE_KEY',
      'Slot must hold a P-256 key.',
    );
    assert(
      before.publicKeyHex === request.expectedPublicKey,
      'WRONG_DEVICE_KEY',
      'The device/slot key does not match the saved reference.',
    );
    const digest = Buffer.from(request.digest ?? '', 'hex');
    assert(
      digest.length === 32 && request.digest?.length === 64,
      'INVALID_DIGEST',
      'PIV signing requires exactly 32 digest bytes.',
    );
    const pin = Buffer.from(request.pin ?? '', 'utf8');
    const tries = new Int32Array(1);
    try {
      assert(
        pin.length >= 6 && pin.length <= 8 && !pin.includes(0),
        'INVALID_CREDENTIAL',
        'PIV PIN must contain 6–8 bytes without NUL.',
      );
      check(
        lib.ykpiv_verify_select(state, ptr(pin), BigInt(pin.length), ptr(tries), false),
        'PIN verification',
      );
    } finally {
      pin.fill(0);
      delete request.pin;
    }
    const signature = Buffer.alloc(256);
    const length = new BigUint64Array([256n]);
    process.stderr.write(
      JSON.stringify({ event: 'touch_required', message: 'Touch your YubiKey when it flashes.' }) +
        '\n',
    );
    const signingResult = lib.ykpiv_sign_data(
      state,
      ptr(digest),
      32n,
      ptr(signature),
      ptr(length),
      0x11,
      slotId,
    );
    if (signingResult === -5)
      throw new CliError({
        code: 'SIGNING_NOT_AUTHORIZED',
        message:
          'PIN verification succeeded, but signing was not authorized. The required touch may have timed out. No signature was returned; start another request when ready.',
        exit: 3,
      });
    check(signingResult, 'signing');
    assert(
      length[0]! >= 8n && length[0]! <= 80n,
      'INVALID_SIGNATURE',
      'Unexpected P-256 DER signature length.',
    );
    return {
      serial: request.serial,
      slot,
      publicKeyHex: before.publicKeyHex,
      der: signature.subarray(0, Number(length[0])).toString('hex'),
    };
  } finally {
    if (state) lib.ykpiv_done(state);
    library.close();
  }
}
