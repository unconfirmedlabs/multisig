# CLI contract, version 1

`--json` emits one UTF-8 JSON value on stdout. Human mode emits indented JSON
with the same fields. Requested JSON output files use exclusive creation;
stdout then contains `{ "written": "path" }`. Diagnostics and review details
go to stderr. Errors are one JSON value on stderr:

```json
{ "error": { "code": "THRESHOLD_NOT_MET", "message": "...", "details": {} } }
```

Optional fields are omitted. There are no terminal control sequences in JSON.
Amounts and chain quantities are decimal strings. Lists of balances and owned
objects default to one page of 50, with `cursor` and `hasNextPage`; use
`--cursor` and `--limit` (1–100) explicitly. Local wallet/proposal lists include
all local records. No pager, browser, or implicit credential flow is opened in
`--non-interactive` mode. `--yes` is a confirmation, not an authentication bypass.

| Exit | Meaning |
| --- | --- |
| 0 | Operation completed; predicate details are in JSON |
| 2 | Invalid arguments |
| 3 | Validation, dependency, device, or authentication failure |
| 4 | Operational failure or transaction executed but failed on chain |
| 5 | Unknown mutation outcome, unconfirmed status, or persistence failure after a side effect |

Errors with code `GENERATION_UNKNOWN` require device inspection/recovery.
`EXECUTION_UNKNOWN` and `STATUS_UNCONFIRMED` preserve the digest for reconciliation.
`KEY_GENERATED_PERSISTENCE_FAILED` and `EXECUTED_PERSISTENCE_FAILED` explicitly
report `outcome: applied`. Never interpret a nonzero exit as proof that a
mutation did not happen. No automatic authentication or submission retries occur.

Help, version, wallet derivation, proposal inspection, and signature combination
do not initialize PIV or query the network. Signing checks the selected RPC
against the recorded chain identity. Simulation explicitly disables gas
selection. Execution submits the existing TransactionData bytes unchanged.

## Public artifacts

- `multisig.piv-key`, version 1: serial, slot, flagged base64 publicKey,
  derived address, numeric pinPolicy and touchPolicy. Never contains credentials.
- `multisig.wallet`, version 1: address, nullable name, integer threshold,
  ordered members `{publicKey, weight, order, label?}`.
- `multisig.proposal`, version 1: ID, network, nullable chainIdentifier, wallet,
  transactionBytes (canonical padded base64), digest, createdAt, nullable description.
- `multisig.signature`, version 1: proposalId, digest, flagged publicKey,
  serialized Sui signature. Weight is always derived from the wallet.

Native schemas reject excess fields. Unknown artifact versions and unsupported
signature schemes are rejected. Proposal ID is SHA-256 of the JSON array
`[network, walletAddress, transactionBytes]`; it is a local identifier distinct
from the Sui transaction digest. Member order, weights and threshold determine
the native multisig address. Proposal core files are immutable; append member
signatures as separate files instead of rewriting arrays.

Sagat v1 adapters normalize exported totals and signature weights, preserve exact
transaction bytes, and verify every imported member signature. Import never
triggers a vote, device signature, cancellation, or chain execution. API requests
use HTTPS except localhost, disallow URL credentials, and reject redirects so
bearer tokens cannot be forwarded to another origin.

## Native boundary

PIV calls run in an isolated `--internal-piv` invocation of the same executable.
This is an implementation detail, not a public command. A single bounded JSON
request travels over a private pipe; secrets are never argv or environment.
The parent imposes a 45-second deadline and serializes its own device operations
through a lock. Unknown generation outcomes are recorded before returning.

FFI supports 64-bit macOS/Linux ABI declarations, with macOS arm64 hardware
verified. Pointers and `size_t` cells are explicitly sized; C-owned public points
are copied and freed before state cleanup. Only `6a88` (missing key metadata)
plus `6a82` (missing certificate object) establishes an empty slot. Unsupported
or malformed metadata fails closed. The native library has no public atomic
check-and-generate wrapper, so unrelated PIV applications must remain closed.
