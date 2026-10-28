// Two disposable software cosigners; hardware secrets never enter this script.
// This script intentionally refuses every network except testnet.
import { parseArgs } from 'node:util';
import { join, resolve } from 'node:path';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { SuiGrpcClient } from '@mysten/sui/grpc';
import { requestSuiFromFaucetV3, getFaucetHost } from '@mysten/sui/faucet';
import { parseKey, createWallet, parseProposal, type Signature } from '../src/domain.ts';
import { readJson, writeNew } from '../src/store.ts';

const { values, positionals } = parseArgs({
  args: Bun.argv.slice(2),
  allowPositionals: true,
  strict: true,
  options: { key: { type: 'string' }, dir: { type: 'string' } },
});
if (!values.dir)
  throw Error(
    'Usage: bun scripts/testnet-demo.ts prepare --key KEY.json --dir DIR | faucet/sign/status --dir DIR',
  );
const dir = resolve(values.dir);
const command = positionals[0];
const client = new SuiGrpcClient({
  network: 'testnet',
  baseUrl: 'https://fullnode.testnet.sui.io:443',
});
if (command === 'prepare') {
  if (!values.key) throw Error('--key is required.');
  const hardware = parseKey(await readJson(values.key));
  const one = Ed25519Keypair.generate(),
    two = Ed25519Keypair.generate();
  const wallet = createWallet(
    [
      hardware.publicKey,
      one.getPublicKey().toSuiPublicKey(),
      two.getPublicKey().toSuiPublicKey(),
    ].map((publicKey) => ({ publicKey, weight: 1 })),
    2,
    'YubiKey 2-of-3 testnet demo',
  );
  // Exclusive mode-0600 writes. Keep these until any leftover testnet funds are recovered.
  await writeNew(join(dir, 'temporary-keys.json'), {
    network: 'testnet',
    keys: [one.getSecretKey(), two.getSecretKey()],
  });
  await writeNew(join(dir, 'yubikey.json'), hardware);
  await writeNew(join(dir, 'wallet.json'), wallet);
  const publicData = {
    network: 'testnet',
    multisigAddress: wallet.address,
    yubikeyAddress: hardware.address,
    temporaryAddresses: [one.toSuiAddress(), two.toSuiAddress()],
    walletFile: join(dir, 'wallet.json'),
    keyFile: join(dir, 'yubikey.json'),
    recipient: two.toSuiAddress(),
  };
  await writeNew(join(dir, 'demo.json'), publicData);
  console.log(JSON.stringify(publicData, null, 2));
} else {
  const data = await Bun.file(join(dir, 'demo.json')).json();
  if (data.network !== 'testnet') throw Error('Demo accepts testnet only.');
  if (command === 'faucet') {
    // SDK 2.38 sees Bun's Node argon2 stub as implemented. Select its bundled
    // Noble fallback for this isolated demo operation, and restore the getter.
    const descriptor = Object.getOwnPropertyDescriptor(process, 'getBuiltinModule');
    const original = process.getBuiltinModule.bind(process);
    Object.defineProperty(process, 'getBuiltinModule', {
      configurable: true,
      value: (name: string) => {
        const module = original(name);
        return name === 'node:crypto' ? { ...module, argon2: undefined } : module;
      },
    });
    try {
      console.log(
        JSON.stringify(
          await requestSuiFromFaucetV3({
            host: getFaucetHost('testnet'),
            recipient: data.multisigAddress,
            timeout: 180_000,
          }),
          null,
          2,
        ),
      );
    } finally {
      if (descriptor) Object.defineProperty(process, 'getBuiltinModule', descriptor);
    }
  } else if (command === 'sign') {
    const p = await parseProposal(await readJson(join(dir, 'proposal.json')));
    if (p.network !== 'testnet' || p.wallet.address !== data.multisigAddress)
      throw Error('Demo proposal does not match testnet wallet.');
    const privateData = await Bun.file(join(dir, 'temporary-keys.json')).json();
    const signer = Ed25519Keypair.fromSecretKey(privateData.keys[0]);
    const { signature } = await signer.signTransaction(Buffer.from(p.transactionBytes, 'base64'));
    const artifact: Signature = {
      type: 'multisig.signature',
      version: 1,
      proposalId: p.id,
      digest: p.digest,
      publicKey: signer.getPublicKey().toSuiPublicKey(),
      signature,
    };
    await writeNew(join(dir, 'software-signature.json'), artifact);
    console.log(
      JSON.stringify({
        signatureFile: join(dir, 'software-signature.json'),
        signer: signer.toSuiAddress(),
        digest: p.digest,
      }),
    );
  } else if (command === 'status') {
    const balance = await client.getBalance({
      owner: data.multisigAddress,
      signal: AbortSignal.timeout(20_000),
    });
    const recipient = await client.getBalance({
      owner: data.recipient,
      signal: AbortSignal.timeout(20_000),
    });
    console.log(
      JSON.stringify(
        {
          network: 'testnet',
          multisigAddress: data.multisigAddress,
          balance,
          recipientAddress: data.recipient,
          recipientBalance: recipient,
        },
        null,
        2,
      ),
    );
  } else throw Error('Choose prepare, faucet, sign, or status.');
}
