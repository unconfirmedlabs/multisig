# multisig

A single Effect/Bun CLI for native Sui multisigs, with YubiKey PIV signing.
Create ordered weighted wallets, build and review transactions, exchange member
signatures, combine a quorum, and execute directly on Sui. Sagat is optional:
its version-1 exports and source-confirmed coordination APIs are supported.

The hardware account is an ordinary **Secp256r1 Sui address**. Its P-256 private
key is generated on the YubiKey and stays there. PIV signing has no WebAuthn
domain binding.

## Install

Requires Bun >=1.3. Tested on macOS arm64 with Bun 1.4 and YubiKey firmware 5.8.
Linux arm64/x64 library paths are provided; Linux hardware behavior is unverified.

```sh
brew install oven-sh/bun/bun yubico-piv-tool
git clone https://github.com/unconfirmedlabs/multisig.git
cd multisig
bun install --frozen-lockfile
bun run check
bun run build
bun run install:local
multisig --help
```

Add `~/.local/bin` to your `PATH` if needed. Local installation creates a
symlink into this checkout; keep the checkout in place and rebuild it to update
the installed command. Re-running installation accepts the same symlink and
refuses to replace an unrelated file. Builds target the current OS and CPU.

The result is one `dist/multisig` executable, including its internal PIV worker.
It dynamically loads Yubico's official `libykpiv`; no Rust or Python runtime is
required. Set `--library /absolute/path/to/libykpiv.dylib` for a custom install.
On Linux install `libykpiv-dev` and enable PC/SC before using hardware commands.

Effect manages the program and services. Bun supplies files, streams, processes,
globs, compilation, tests, and FFI. Node compatibility APIs are used for path
handling, strict argument parsing, terminal input, and atomic filesystem
operations that Bun does not expose.

## Generate a YubiKey address

Run `multisig` or `multisig key address` in a terminal to choose a connected
YubiKey and see all 24 usable PIV slots. The table distinguishes occupied,
empty, and unreadable slots, and shows addresses for readable P-256 keys.
Choose an existing key to save its public reference and display its full Sui
address and public key. Browsing slots requires no PIN or touch.

For scripts, select the device and slot explicitly:

```sh
multisig device list --json
multisig device slots --device SERIAL --json --non-interactive
multisig key address --device SERIAL --slot 9c --json --non-interactive
```

The saved key ID is `SERIAL_SLOT`, for example `12345678_9c`. Read it again
without accessing hardware using `multisig key address --key SERIAL_SLOT`.
To create a new key, inspect an empty slot and explicitly request generation:

```sh
multisig device inspect --device SERIAL --slot 9c --json
multisig key generate --device SERIAL --slot 9c --output yubikey.json
multisig key address --key yubikey.json
```

Enter the management key at the hidden terminal prompt. For a device known to
still use its factory management key, explicitly add `--factory-management-key`.
Generation uses P-256, PIN policy **always**, and touch policy **always**. It
requires metadata-confirmed emptiness and no certificate. Existing keys are
never intentionally replaced; unknown slot state fails closed. Keep other PIV
applications closed during generation: the library exposes no transaction that
atomically covers inspection and generation across unrelated applications.

Generation leaves the PIV PIN, PUK, management key and other slots unchanged.
Keep your device's credential configuration appropriate for its use. The CLI
does not reset the device or change retry counters. After interrupted generation,
inspect and recover with `key export`; do not generate again:

```sh
multisig key export --device SERIAL --slot 9c --output recovered-yubikey.json
```

The exported file contains public information only. Modern slot metadata lets
the CLI recover it without a certificate. On-device generation creates no seed
phrase or private-key backup; choose the multisig composition so losing one
device can be handled by the remaining members.

## Authorize a second YubiKey with address aliases

Generate a separate key on the second device, then enable aliases on the
original individual address and add the second address. Each alias can
independently act as the original address, including modifying its aliases.
This is an on-chain authorization on the selected network, not a copy of the
original private key. The original address needs SUI for gas.

```sh
multisig device slots --device BACKUP_SERIAL
multisig key generate --device BACKUP_SERIAL --slot 9c --output backup.json
multisig alias show --address ORIGINAL_ADDRESS --network testnet
multisig alias enable --key ORIGINAL_SERIAL_9c --network testnet
multisig alias add --key ORIGINAL_SERIAL_9c --alias BACKUP_ADDRESS --network testnet
multisig alias transfer-sui --key backup.json --address ORIGINAL_ADDRESS --recipient ORIGINAL_ADDRESS --amount 1 --network testnet
multisig alias show --address ORIGINAL_ADDRESS --network testnet
```

Enable and add are separate transactions and touches. Commands default to
testnet; select `--network mainnet` explicitly for mainnet. The CLI retains the
original address in the allowed set. Remove a backup with `alias remove --key
ORIGINAL_SERIAL_9c --alias BACKUP_ADDRESS --network testnet`.

Aliases authorize the transaction sender. An alias of an individual member does
not substitute for that member's signature inside an existing native multisig.
Granting a single backup key authority over the entire multisig address gives
that key independent control of the multisig's assets.

`alias transfer-sui` also works before aliases are enabled, using the original
key. A small self-transfer signed by that key makes its public key discoverable
from its transaction signature.

## Create a 2-of-3 wallet

Create `members.json` with the **flagged base64 Sui public keys**, not addresses:

```json
[
  { "publicKey": "YUBIKEY_FLAGGED_BASE64_PUBLIC_KEY", "weight": 1 },
  { "publicKey": "SECOND_FLAGGED_BASE64_PUBLIC_KEY", "weight": 1 },
  { "publicKey": "THIRD_FLAGGED_BASE64_PUBLIC_KEY", "weight": 1 }
]
```

```sh
multisig wallet create --members members.json --threshold 2 --name treasury --output wallet.json
multisig wallet show --wallet wallet.json
multisig wallet export --wallet wallet.json --sagat --output sagat-wallet.json
```

Member order is part of the address. The CLI derives and checks it with the Sui
SDK. Members may use Ed25519, Secp256k1, or Secp256r1. PIV signing supports P-256;
other members can sign elsewhere and import their signatures.

## Build, sign and execute

Construction defaults to **testnet**. Amounts are decimal integer base units;
`1000000` MIST is 0.001 SUI.

```sh
multisig balance --wallet wallet.json --network testnet
multisig tx build-sui --wallet wallet.json --recipient 0xRECIPIENT --amount 1000000 --network testnet --output proposal.json
multisig tx inspect --proposal proposal.json
multisig tx simulate --proposal proposal.json
multisig proposal sign --proposal proposal.json --key yubikey.json --output hardware-signature.json
multisig proposal signature-import --proposal proposal.json --input cosigner-signature.json
multisig proposal combine --proposal proposal.json --output combined.json
multisig proposal execute --proposal proposal.json
multisig proposal status --proposal proposal.json
```

The PIN prompt is hidden. Touch the YubiKey when it flashes. Every produced
signature is verified locally before storage. The YubiKey has no transaction
display; review the decoded transaction in the CLI before touching it.

`tx build-coin --coin-type TYPE`, `tx build-object --object ID` (repeatable), and
`tx build-json --input sdk-transaction.json` cover coin/object transfers and
arbitrary declarative SDK transactions. Fully serialized TransactionData can
also be imported as a JSON base64 string:

```sh
multisig tx import --wallet wallet.json --input tx-bytes.json --network testnet --pin-chain --output proposal.json
```

The CLI freezes the complete transaction after object/gas resolution. Signing,
simulation and submission use those exact bytes. A separate gas owner is
rejected in v1 because sponsorship requires additional signatures.

Online construction pins the RPC chain identifier. Offline/Sagat imports have
no chain identity unless imported with `--pin-chain`. They require the explicit
`--allow-unverified-network` option to sign or execute otherwise. Network labels
and pinned identity are local checks, not additional cryptographic domain
separation in Sui signatures. A submission timeout has an **unknown** outcome;
use `proposal status` with the existing digest, preserving the same bytes.

## Files and coordination

The default store is `~/.local/share/multisig`; change it with `--data-dir DIR`.
Wallets and proposal cores are immutable JSON files. Each member signature has
its own file, with exclusive creation to avoid concurrent lost updates. Records
and explicit output files use mode 0600 and are never overwritten. Key-operation
and submission records permit recovery after an interrupted mutation. Device
lock files contain a process ID; remove a stale lock only after checking that
the operation has stopped and inspecting the device if generation was pending.

`proposal cancel` marks a proposal cancelled **locally**; previously issued
signatures remain valid on chain. It is coordination state, not revocation.

```sh
multisig proposal import --input sagat-proposal.json --pin-chain
multisig proposal export --proposal PROPOSAL_ID --sagat --output shared-proposal.json
multisig proposal list
```

Sagat exports include collected signatures; native proposal export contains the
immutable core. Individual signature artifacts can be exchanged independently.
Import recomputes addresses, digests, membership and weights instead of trusting
exported totals. File compatibility is pinned to Sagat commit
`a4abb0aefc577dd28822afe98a3bd2a8211596fd`. Locally exported Sagat proposals use
placeholder database IDs; these are portable files, not a claim of registration
on the hosted service.

## Sagat API

The default endpoint is `https://api.sagat.mystenlabs.com`; override with
`--api-url`. Login produces a one-hour bearer token. Explicit output files are
owner-only. Use a dedicated file descriptor for the token, never an argv value:

```sh
multisig sagat login --key yubikey.json --output auth.json
# Extract .token into an owner-only file using your preferred local tooling.
multisig sagat wallets --token-fd 3 3<token.txt
multisig sagat wallet-create --wallet wallet.json --token-fd 3 3<token.txt
multisig sagat invitations --key yubikey.json --token-fd 3 3<token.txt
multisig sagat accept --wallet wallet.json --key yubikey.json --token-fd 3 3<token.txt
multisig sagat proposals --wallet wallet.json --token-fd 3 3<token.txt
multisig sagat proposal-get --digest DIGEST --pin-chain
multisig sagat propose --proposal proposal.json --key yubikey.json
multisig sagat vote --id ID --proposal proposal.json --signature hardware-signature.json
multisig sagat verify --digest DIGEST
```

Invitation rejection, proposal cancellation, and proposer add/remove operations
are also available. `--help` lists their flags. API routes/authentication strings
are checked against Sagat source and tested with a mock; deployment differences
can still require adapting the API client. The independent workflow never needs
a Sagat login or backend.

Sagat accepts flagged base64 public keys directly when composing a wallet. Its
address lookup checks its registered-address table and outgoing transactions
across mainnet, testnet, and devnet. A newly generated address may therefore be
absent from address lookup until it is registered with Sagat or sends a direct
transaction. A transaction sent by a multisig does not give the individual
member address its own outgoing transaction. See Sagat's
[lookup implementation](https://github.com/MystenLabs/sagat/blob/a4abb0aefc577dd28822afe98a3bd2a8211596fd/app/src/lib/onChainLookup.ts).

## Noninteractive use

Use `--json --non-interactive`; explicitly authorize mutations/signing with
`--yes`. PIN and management keys can be supplied via dedicated FDs >=3. A FD
contains one UTF-8 line; the management key line is hexadecimal. The CLI never
guesses a PIN, retries authentication automatically, or logs credentials.

```sh
multisig proposal sign --proposal proposal.json --key yubikey.json --pin-fd 3 --yes --json --non-interactive 3<private-pin-file
```

Physical touch is still required. Do not store PIN files in the repository.
See [CLI contract](docs/cli-contract.md) for schemas, outputs and failure states.

## Reproduce the hardware demo

`scripts/testnet-demo.ts` creates two temporary Ed25519 addresses, writes their
private keys to an owner-only local file, and creates a 2-of-3 wallet alongside
your YubiKey address. It accepts testnet only:

```sh
bun scripts/testnet-demo.ts prepare --key yubikey.json --dir /tmp/multisig-demo
bun scripts/testnet-demo.ts faucet --dir /tmp/multisig-demo
multisig tx build-sui --wallet /tmp/multisig-demo/wallet.json --recipient TEMPORARY_RECIPIENT --amount 1 --network testnet --output /tmp/multisig-demo/proposal.json
bun scripts/testnet-demo.ts sign --dir /tmp/multisig-demo
multisig proposal signature-import --proposal /tmp/multisig-demo/proposal.json --input /tmp/multisig-demo/software-signature.json
# combine fails at 1/3
multisig proposal sign --proposal /tmp/multisig-demo/proposal.json --key /tmp/multisig-demo/yubikey.json
# combine and execute now succeed at 2/3
multisig proposal execute --proposal /tmp/multisig-demo/proposal.json
```

If the faucet is unavailable, fund the displayed multisig address with testnet
SUI. Temporary private keys stay in the demo directory so any leftover testnet
funds remain recoverable. They are never printed or committed.

## Development and support

See [CONTRIBUTING.md](CONTRIBUTING.md) for local checks and architecture,
[SECURITY.md](SECURITY.md) for private vulnerability reports, and
[verification.md](docs/verification.md) for the scope of hardware validation.
This project is licensed under [Apache-2.0](LICENSE).
