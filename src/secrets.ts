import { openSync, readSync, closeSync } from 'node:fs';
import { ReadStream } from 'node:tty';
import { assert } from './errors.ts';

// Credentials are read from a dedicated FD or the controlling terminal, never argv/env.
export function secret(
  prompt: string,
  fd: number | undefined,
  interactive: boolean,
  maxBytes = 256,
): Buffer {
  let input = fd;
  let tty: ReadStream | undefined;
  if (input === undefined) {
    assert(
      interactive,
      'CREDENTIAL_REQUIRED',
      'Use a dedicated --pin-fd/--management-key-fd or run interactively.',
    );
    try {
      input = openSync('/dev/tty', 'r+');
      tty = new ReadStream(input);
      tty.setRawMode(true);
    } catch {
      if (input !== undefined) closeSync(input);
      assert(
        false,
        'CREDENTIAL_REQUIRED',
        'No controlling terminal is available; provide a credential FD.',
      );
    }
    process.stderr.write(prompt);
  }
  const out = Buffer.alloc(maxBytes);
  const byte = Buffer.alloc(1);
  let length = 0;
  try {
    while (readSync(input!, byte, 0, 1, null) === 1) {
      if (byte[0] === 10 || byte[0] === 13) break;
      assert(byte[0] !== 3 && byte[0] !== 4, 'CANCELLED', 'Credential entry cancelled.');
      if ((byte[0] === 127 || byte[0] === 8) && tty) {
        if (length) out[--length] = 0;
        continue;
      }
      assert(length < maxBytes - 1, 'INVALID_CREDENTIAL', 'Credential input is too long.');
      out[length++] = byte[0]!;
    }
    assert(length > 0, 'CREDENTIAL_REQUIRED', 'Credential input was empty.');
    return Buffer.from(out.subarray(0, length));
  } finally {
    out.fill(0);
    byte.fill(0);
    if (tty) {
      try {
        tty.setRawMode(false);
        process.stderr.write('\n');
      } finally {
        closeSync(input!);
      }
    }
  }
}
