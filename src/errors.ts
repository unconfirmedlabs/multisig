import { Data, Effect } from 'effect';

export class CliError extends Data.TaggedError('CliError')<{
  code: string;
  message: string;
  exit?: number;
  details?: unknown;
}> {}

export function fail(code: string, message: string, details?: unknown): never {
  throw new CliError({ code, message, details });
}

export function assert(condition: unknown, code: string, message: string): asserts condition {
  if (!condition) fail(code, message);
}

export function errorOf(e: unknown): CliError {
  return e instanceof CliError
    ? e
    : new CliError({
        code: 'OPERATION_FAILED',
        message: e instanceof Error ? e.message : String(e),
        exit: 4,
      });
}

export const attempt = <A>(f: () => Promise<A>) => Effect.tryPromise({ try: f, catch: errorOf });
export const sync = <A>(f: () => A) => Effect.try({ try: f, catch: errorOf });
