# Build and adversarial review

The CLI uses Effect services and Bun FFI. Native PIV calls run in an isolated
internal invocation of the same compiled executable, keeping crashes and
timeouts separate from the process that records operation outcomes. Yubico's
`libykpiv` is loaded dynamically; no separate helper runtime is required.

The review's concrete corrections are implemented:

- C-owned public points are copied, then freed before native session cleanup.
- Exact missing-key and missing-certificate statuses establish slot emptiness;
  malformed metadata fails closed. Generation is opt-in and never intentionally
  overwrites an occupied slot. Separate PIV applications must remain closed.
- An operation record precedes generation. A native crash/timeout is reported
  as an unknown outcome; recovery exports the existing key instead of regenerating.
- Persistence failures following generation/execution preserve the known applied
  outcome and the key reference or transaction digest.
- Import cannot replace a non-null chain pin. Status reconciliation checks the
  selected RPC's identity too.
- Finalized bytes are frozen. Signing, simulation and execution do not rebuild
  transactions or change gas; simulation disables gas selection.
- Immutable per-member signature files prevent concurrent lost updates.
- HTTP redirects are rejected. Failed or truncated Sagat mutation responses
  retain unknown-outcome semantics.
- Native SDK hashing and low-S signature conversion are tested against independent
  Sui SDK verification for transactions and personal messages.

During the supervised hardware test, firmware 5.8 returned a nested `86` ECC
public-key template inside metadata tag `04`. The first generation call correctly
stopped at its post-generation check rather than retrying. The parser was fixed,
a regression test added, and the existing key recovered and inspected with both
PIN-always and touch-always policies intact.

Hardware validation and live transaction results are recorded separately in
[verification.md](verification.md). Mock and software-key tests are not treated
as evidence of a physical-touch signature.
