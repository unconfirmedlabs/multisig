import { test, expect } from 'bun:test';
import type { SuiGrpcClient } from '@mysten/sui/grpc';
import { executeExact, simulate, checkChain } from '../src/chain.ts';
import { SagatClient, messages } from '../src/sagat.ts';
import { fixtureProposal } from './domain.test.ts';

test('simulation and execution forward identical finalized bytes, with gas selection disabled', async () => {
  const p = await fixtureProposal();
  const seen: Uint8Array[] = [];
  const client = {
    simulateTransaction: async (o: any) => {
      expect(o.doGasSelection).toBe(false);
      seen.push(o.transaction);
      return {};
    },
    executeTransaction: async (o: any) => {
      seen.push(o.transaction);
      return { $kind: 'Transaction', Transaction: { digest: p.digest } };
    },
  } as unknown as SuiGrpcClient;
  await simulate(client, p);
  await executeExact(client, p, 'combined');
  expect(Buffer.from(seen[0]!).toString('base64')).toBe(p.transactionBytes);
  expect(seen[0]).toEqual(seen[1]);
});
test('chain mismatch and absent pin fail; timeout preserves unknown outcome and digest', async () => {
  const p = await fixtureProposal();
  const client = {
    getChainIdentifier: async () => ({ chainIdentifier: 'other' }),
    executeTransaction: async () => {
      throw Error('timeout');
    },
  } as unknown as SuiGrpcClient;
  await expect(checkChain(client, p)).rejects.toThrow();
  await expect(checkChain(client, { ...p, chainIdentifier: null })).rejects.toThrow();
  try {
    await executeExact(client, p, 'signature');
    throw Error('expected failure');
  } catch (e: any) {
    expect(e.code).toBe('EXECUTION_UNKNOWN');
    expect(e.details.digest).toBe(p.digest);
  }
});
test('Sagat uses exact source-based messages and does not follow bearer-token redirects', async () => {
  expect(messages.connect('expiry')).toBe('Verifying address ownership until: expiry');
  expect(messages.accept('0x1')).toBe('Participating in multisig 0x1');
  const seen: any[] = [];
  const fetcher = async (url: any, init: any) => {
    seen.push({ url, init });
    return new Response('{}', { status: 200 });
  };
  const client = new SagatClient(
    'https://api.example.com',
    'sensitive-token',
    fetcher as typeof fetch,
  );
  await client.request('/auth/script-connect', 'POST', { signature: 'sig', expiry: 'expiry' });
  expect(seen[0].init.redirect).toBe('error');
  expect(seen[0].init.headers.Authorization).toBe('Bearer sensitive-token');
  expect(seen[0].url).toBe('https://api.example.com/auth/script-connect');
  expect(() => new SagatClient('https://user:password@api.example.com')).toThrow();
});
test('Sagat mutation 5xx and truncated responses retain unknown-outcome semantics', async () => {
  for (const response of [
    new Response('failed', { status: 503 }),
    new Response('{', { status: 200 }),
  ]) {
    const client = new SagatClient(
      'https://api.example.com',
      undefined,
      (async () => response) as unknown as typeof fetch,
    );
    try {
      await client.request('/proposals', 'POST', {});
      throw Error('expected failure');
    } catch (e: any) {
      expect(e.code).toBe('SAGAT_OUTCOME_UNKNOWN');
      expect(e.exit).toBe(5);
    }
  }
});
