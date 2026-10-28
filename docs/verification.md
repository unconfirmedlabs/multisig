# Verification

These results describe the tested environment and workflows. They are not an
independent security audit or a claim of hardware support on every platform.

## Automated

Run `bun run check` for strict TypeScript checking and the current test suite.
Coverage includes:

- Mixed-scheme native 2-of-3 composition, quorum checks, and Sui SDK verification.
- Transaction and personal-message PIV hashing, high-S normalization, malformed
  DER/TLV, and firmware 5.8 public-key metadata.
- Composition and transaction tampering, concurrent signature imports, CLI pipe
  behavior, chain-pin preservation, and byte-for-byte submission.
- Post-generation persistence recovery and Sagat HTTP contracts, including
  uncertain mutation outcomes.
- Slot status rendering and noninteractive behavior, alias BCS validation,
  distinct alias signing, saved-signature reuse, chain checks, and confirmed
  on-chain failure journaling.

Frozen dependency installation, native compilation, local installation, and
compiled internal-worker dispatch have also been exercised. CI runs the checks
specified in [check.yml](../.github/workflows/check.yml); its software tests do
not require a connected YubiKey or access to a live Sui network.

## Physical YubiKey

Hardware validation used a YubiKey 5C NFC with firmware 5.8.0 on macOS arm64.

- A P-256 key was generated on-device in slot `9c`.
- Public reference recovery from slot metadata succeeded without a certificate.
- PIN policy `always`, touch policy `always`, and origin `generated` were verified.
- PIN retry count remained 3/3 after the first signing request.
- Physical-touch transaction signing succeeded through the compiled CLI and
  passed independent P-256 and Sui SDK verification.
- The read-only interactive picker scanned all 24 usable slots, distinguished
  occupied and empty slots, selected the existing key, and returned its full
  public reference without a PIN or touch.

Linux hardware behavior and other YubiKey firmware versions remain unverified.
A successful software test or compiled build does not establish hardware support.

## Testnet multisig

A supervised end-to-end test used the YubiKey and two temporary Ed25519 keys:

1. Create a native 2-of-3 wallet and fund it through the testnet faucet.
2. Build a 1-MIST transfer with pinned chain identity and simulate its exact bytes
   with `gasPaymentMocked: false`.
3. Import one software signature and confirm aggregation fails below threshold.
4. Obtain a physical-touch YubiKey signature, combine the two signatures, and
   submit the native multisig transaction.
5. Independently look up the digest and confirm successful execution and receipt
   of 1 MIST by the recipient.

Gas spent in this test was 1,988,000 MIST (0.001988 SUI). Reproduction instructions
are in the [README](../README.md#reproduce-the-hardware-demo). Demo private keys
and run-specific artifacts belong outside the repository and were not committed.

## Mainnet public-key discovery

The compiled CLI simulated and submitted a 1-MIST self-transfer signed directly
by the individual YubiKey address after a physical touch. Independent mainnet
gRPC lookup confirmed success. Gas spent was 1,088,000 MIST (0.001088 SUI).

Sagat's exact GraphQL sender/signature query recovered the expected flagged
Secp256r1 public key. Server registration was unnecessary for this lookup path.
The transfer did not authorize another key or modify alias configuration.

## Remaining verification limits

- Alias-state lookup has been checked against testnet and mainnet. Physical
  provisioning of a second YubiKey and live alias enable/add/backup-signing have
  not been completed. Automated alias-signing tests use software keys.
- Hosted Sagat API behavior is source/mocked contract tested. Live authenticated
  hosted coordination remains unverified.
- No independent security audit has been performed.
