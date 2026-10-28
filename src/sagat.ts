import type { Proposal, Signature, Wallet, Network } from './domain.ts';
import {
  record,
  createWallet,
  createProposal,
  parseProposal,
  verifyMemberSignature,
  tally,
  parseWallet,
} from './domain.ts';
import { assert, CliError } from './errors.ts';
import { validateEndpoint } from './chain.ts';

// Pinned wire contracts: MystenLabs/sagat a4abb0aefc577dd28822afe98a3bd2a8211596fd.
export function exportWallet(wallet: Wallet) {
  return {
    type: 'sagat.multisig-composition',
    version: 1,
    multisig: {
      address: wallet.address,
      name: wallet.name,
      threshold: wallet.threshold,
      totalMembers: wallet.members.length,
      totalWeight: wallet.members.reduce((s, m) => s + m.weight, 0),
      members: wallet.members.map(({ publicKey, weight, order }) => ({ publicKey, weight, order })),
    },
  };
}
export async function importProposal(
  input: unknown,
): Promise<{ proposal: Proposal; signatures: Signature[] }> {
  const data = record(input);
  if (data.type === 'multisig.proposal')
    return { proposal: await parseProposal(data), signatures: [] };
  assert(
    data.type === 'sagat.proposal' && data.version === 1,
    'INVALID_FORMAT',
    'Expected a native proposal or Sagat version-1 proposal export.',
  );
  const raw = record(data.proposal);
  const composition = record(data.multisig);
  assert(Array.isArray(composition.members), 'INVALID_MEMBERS', 'Sagat export has no composition.');
  // Sagat exports explicitly order members. Reject duplicate/gapped order positions.
  const ordered = [...composition.members].sort((a, b) => a.order - b.order);
  const wallet = createWallet(ordered, composition.threshold, composition.name ?? null);
  assert(
    wallet.address === composition.address && raw.multisigAddress === wallet.address,
    'WALLET_ADDRESS_MISMATCH',
    'Sagat composition or proposal address mismatch.',
  );
  const p = await createProposal(
    wallet,
    raw.transactionBytes,
    raw.network as Network,
    null,
    raw.description ?? null,
  );
  assert(
    p.digest === raw.digest,
    'PROPOSAL_MISMATCH',
    'Sagat digest does not match transaction bytes.',
  );
  assert(
    Array.isArray(raw.signatures) && raw.signatures.length <= 10,
    'INVALID_SIGNATURES',
    'Sagat signatures must be an array of at most ten items.',
  );
  const signatures = [];
  for (const s of raw.signatures)
    signatures.push(
      await verifyMemberSignature(p, {
        type: 'multisig.signature',
        version: 1,
        proposalId: p.id,
        digest: p.digest,
        publicKey: s.publicKey,
        signature: s.signature,
      }),
    );
  await tally(p, signatures);
  return { proposal: p, signatures };
}
export async function exportProposal(p: Proposal, signatures: Signature[]) {
  const t = await tally(p, signatures);
  return {
    type: 'sagat.proposal',
    version: 1,
    exportedAt: new Date().toISOString(),
    proposal: {
      id: 0,
      digest: p.digest,
      network: p.network,
      multisigAddress: p.wallet.address,
      status: 0,
      statusLabel: 'PENDING',
      transactionBytes: p.transactionBytes,
      proposerAddress: p.wallet.address,
      description: p.description,
      currentWeight: t.currentWeight,
      threshold: p.wallet.threshold,
      signatures: t.signatures.map((s) => {
        const m = p.wallet.members.find((m) => m.publicKey === s.publicKey)!;
        return {
          proposalId: 0,
          publicKey: s.publicKey,
          signature: s.signature,
          weight: m.weight,
          order: m.order,
        };
      }),
    },
    multisig: exportWallet(p.wallet).multisig,
  };
}
export const messages = {
  connect: (expiry: string) => `Verifying address ownership until: ${expiry}`,
  accept: (wallet: string) => `Participating in multisig ${wallet}`,
  reject: (wallet: string) => `Rejecting multisig invitation ${wallet}`,
  cancel: (id: number) => `Cancel proposal ${id}`,
  addProposer: (proposer: string, wallet: string, expiry: string) =>
    `Adding proposer ${proposer} to multisig ${wallet}. Valid until: ${expiry}`,
  removeProposer: (proposer: string, wallet: string, expiry: string) =>
    `Removing proposer ${proposer} from multisig ${wallet}. Valid until: ${expiry}`,
};
export class SagatClient {
  readonly endpoint: string;
  constructor(
    endpoint: string,
    readonly token?: string,
    readonly fetcher: typeof fetch = fetch,
  ) {
    this.endpoint = validateEndpoint(endpoint);
  }
  async request(path: string, method = 'GET', body?: unknown): Promise<any> {
    assert(
      path.startsWith('/') && !path.startsWith('//'),
      'INVALID_API_PATH',
      'API paths must be relative.',
    );
    let response;
    try {
      response = await this.fetcher(this.endpoint + path, {
        method,
        redirect: 'error',
        signal: AbortSignal.timeout(25_000),
        headers: {
          'Content-Type': 'application/json',
          ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}),
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
    } catch {
      throw new CliError({
        code: method === 'GET' ? 'SAGAT_UNAVAILABLE' : 'SAGAT_OUTCOME_UNKNOWN',
        message:
          method === 'GET'
            ? 'Sagat request failed.'
            : 'Sagat mutation outcome is unknown. Inspect the remote state before retrying.',
        exit: method === 'GET' ? 4 : 5,
      });
    }
    if (!response.ok) {
      const uncertain = method !== 'GET' && response.status >= 500;
      throw new CliError({
        code: uncertain ? 'SAGAT_OUTCOME_UNKNOWN' : 'SAGAT_HTTP_ERROR',
        message: `Sagat returned HTTP ${response.status}.`,
        exit: uncertain ? 5 : 4,
        details: { endpoint: this.endpoint, path, method },
      });
    }
    // Never include response bodies or Authorization headers in errors.
    try {
      const chunks: Uint8Array[] = [];
      let size = 0;
      if (response.body)
        for await (const chunk of response.body) {
          size += chunk.byteLength;
          assert(size <= 4 * 1024 * 1024, 'INPUT_TOO_LARGE', 'Sagat response exceeds 4 MiB.');
          chunks.push(chunk);
        }
      return JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
      throw new CliError({
        code: method === 'GET' ? 'SAGAT_INVALID_RESPONSE' : 'SAGAT_OUTCOME_UNKNOWN',
        message: 'Sagat returned an incomplete or invalid response.',
        exit: method === 'GET' ? 4 : 5,
        details: { endpoint: this.endpoint, path, method },
      });
    }
  }
}
