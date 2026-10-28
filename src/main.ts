#!/usr/bin/env bun
import { Effect } from 'effect';
import { parse, help, program, render } from './cli.ts';
import { errorOf } from './errors.ts';

if (process.argv[2] === '--internal-piv') {
  try {
    const { nativeOperation } = await import('./piv-native.ts');
    const chunks: Uint8Array[] = [];
    let size = 0;
    for await (const chunk of Bun.stdin.stream()) {
      size += chunk.byteLength;
      if (size > 16384) throw new Error('Native request too large');
      chunks.push(chunk);
    }
    const request = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    const data = await nativeOperation(request);
    process.stdout.write(JSON.stringify({ ok: true, data }) + '\n');
  } catch (e) {
    const error = errorOf(e);
    process.stdout.write(
      JSON.stringify({
        ok: false,
        error: {
          code: error.code,
          message: error.message,
          exit: error.exit,
          details: error.details,
        },
      }) + '\n',
    );
  }
} else {
  try {
    const p = parse(process.argv.slice(2));
    if (p.flags.version) process.stdout.write('0.1.0\n');
    else if (p.flags.help) process.stdout.write(help(p.command));
    else {
      const exit = await Effect.runPromiseExit(program(p));
      if (exit._tag === 'Failure') {
        const { Cause, Option } = await import('effect');
        const failure = Cause.failureOption(exit.cause);
        throw Option.isSome(failure) ? failure.value : new Error('Operation interrupted.');
      }
      await render(exit.value, p);
    }
  } catch (e) {
    const error = errorOf(e);
    process.stderr.write(
      JSON.stringify({
        error: {
          code: error.code,
          message: error.message,
          ...(error.details ? { details: error.details } : {}),
        },
      }) + '\n',
    );
    process.exitCode = error.exit ?? (error.code === 'USAGE' ? 2 : 3);
  }
}
