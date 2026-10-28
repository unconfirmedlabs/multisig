# Security

Report suspected vulnerabilities privately through
[GitHub security advisories](https://github.com/unconfirmedlabs/multisig/security/advisories/new).
Do not open a public issue with exploit details or credentials. Include the
affected commit/version, platform, expected behavior, and a minimal reproduction
using disposable keys or mocked hardware. Never send PINs, PUKs, management keys,
private keys, bearer tokens, or your local data directory.

Security fixes target the current main branch; older versions do not have a
separate maintenance commitment. This project has not undergone an independent
security audit. The [verification record](docs/verification.md) describes the
scope of testing, not a security certification.

The YubiKey protects key material but cannot display transaction contents.
Signing relies on the host, CLI, dependencies, and native library to present
and sign the intended bytes. Review transactions before touch approval. Anyone
authorized as an address alias can independently control that address; aliases
do not provide a multisig quorum.

Keep the data directory and credential files private. Exported public keys,
wallets, and proposals can still identify devices, accounts, and transactions.
After an unknown generation or submission outcome, follow the recovery guidance
in the [CLI contract](docs/cli-contract.md) before retrying.
