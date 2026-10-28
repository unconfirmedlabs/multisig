# Contributing

Use Bun 1.4.0 (the CI version) and the committed lockfile:

```sh
bun install --frozen-lockfile
bun run format:check
bun run check
bun run build
./dist/multisig --help
./dist/multisig --version
```

`bun run format` applies formatting. Tests use software keys, temporary files,
and mocked network/device services; they require neither a YubiKey nor funds.
The CI matrix checks Linux and macOS builds and offline command startup. It
does not certify hardware compatibility on either runner.

The executable targets the build host's OS and CPU. Hardware commands also need
the matching system `libykpiv` and PC/SC service. Keep hardware/live-network
validation separate from unit tests and document the exact platform and scope
of any manual verification. Never run generation, signing, or transactions as
part of an ordinary test or installation step.

## Architecture and changes

- `src/cli.ts` parses the strict CLI contract and orchestrates Effect services.
- `src/domain.ts` validates portable wallets, proposals, and signatures.
- `src/store.ts` owns exclusive persistence and device locks.
- `src/hardware.ts` and `src/piv-native.ts` isolate PIV calls in a child invocation
  of the same executable using Bun FFI.
- `src/chain.ts`, `src/aliases.ts`, and `src/sagat.ts` handle external protocols.

Preserve the [CLI contract](docs/cli-contract.md), frozen transaction bytes,
no-overwrite storage, and explicit unknown-outcome reporting. Use gRPC for Sui
queries and keep the native boundary in the single Bun executable. Avoid adding
automatic credential, generation, or submission retries.

Describe the concrete behavior changed and how you checked it in each pull
request. Add regression coverage for meaningful failure cases; never include
PINs, management keys, tokens, private keys, real device serials, or personal
transaction records in fixtures, logs, or screenshots. Use disposable software
keys and neutral examples. Contributions are under the project's Apache-2.0
license.

For source releases, include the lockfile and license. Before distributing a
compiled executable, review the bundled dependencies' licenses and include their
required notices alongside the project license. The build command alone does
not produce a release archive or bundle the system `libykpiv` library.
