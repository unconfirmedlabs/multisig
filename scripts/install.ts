import { mkdir, symlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';

const source = resolve(import.meta.dir, '../dist/multisig');
if (!(await Bun.file(source).exists())) throw new Error('Run bun run build first.');
const directory = join(homedir(), '.local', 'bin');
await mkdir(directory, { recursive: true, mode: 0o700 });
const destination = join(directory, 'multisig');
try {
  await symlink(source, destination);
} catch (e: any) {
  if (e.code !== 'EEXIST') throw e;
  throw new Error(`${destination} exists; inspect it before replacing it.`);
}
console.log(destination);
