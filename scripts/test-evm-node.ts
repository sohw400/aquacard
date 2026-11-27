import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { createInterface } from 'node:readline';
import { createTestClient, http, parseEther, publicActions } from 'viem';
import { english, generateMnemonic, mnemonicToAccount } from 'viem/accounts';
import { foundry } from 'viem/chains';

function anvilExecutable() {
  // Spawn the native child directly so termination also works during failed starts.
  const require = createRequire(import.meta.url);
  const packageRequire = createRequire(require.resolve('@foundry-rs/anvil/package.json'));
  const arch = process.arch === 'x64' ? 'amd64' : process.arch;
  const executable = process.platform === 'win32' ? 'anvil.exe' : 'anvil';
  try {
    return packageRequire.resolve(`@foundry-rs/anvil-${process.platform}-${arch}/bin/${executable}`);
  } catch {
    // The package postinstall writes the pinned binary here if npm omits optional packages.
    return packageRequire.resolve(`./${executable}`);
  }
}

export async function startTestEvmNode() {
  const child = spawn(anvilExecutable(), [
    '--host', '127.0.0.1', '--port', '0', '--chain-id', String(foundry.id),
    '--accounts', '0', '--no-cors', '--color', 'never',
  ], {
    cwd: tmpdir(),
    // The ephemeral node must not inherit fork URLs or wallet credentials.
    env: process.platform === 'win32' ? { SystemRoot: process.env.SystemRoot } : {},
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  const closed = new Promise<void>(resolve => child.once('close', () => resolve()));
  const terminate = () => { child.kill('SIGTERM'); };
  process.once('SIGINT', terminate);
  process.once('SIGTERM', terminate);
  process.once('exit', terminate);
  const close = async () => {
    terminate();
    const force = setTimeout(() => child.kill('SIGKILL'), 2000);
    force.unref();
    try { await closed; }
    finally {
      clearTimeout(force);
      process.off('SIGINT', terminate);
      process.off('SIGTERM', terminate);
      process.off('exit', terminate);
    }
  };

  try {
    // Read the ephemeral port reported by this child after bind. Never reuse a caller's RPC.
    const lines = createInterface({ input: child.stdout });
    let timeout: NodeJS.Timeout | undefined;
    let rpcUrl: string;
    try {
      rpcUrl = await new Promise<string>((resolve, reject) => {
        child.once('error', () => reject(new Error('The local Anvil executable could not start.')));
        void closed.then(() => reject(new Error('The local Anvil node stopped before listening.')));
        timeout = setTimeout(() => reject(new Error('The local Anvil node did not become ready.')), 15_000);
        lines.on('line', line => {
          const port = /^Listening on 127\.0\.0\.1:([0-9]{1,5})$/.exec(line)?.[1];
          if (port && Number(port) > 0 && Number(port) <= 65535) resolve('http://127.0.0.1:' + port);
        });
      });
    } finally {
      clearTimeout(timeout);
      lines.close();
      child.stdout.resume();
    }
    const client = createTestClient({ chain: foundry, mode: 'anvil', transport: http(rpcUrl) }).extend(publicActions);
    if (await client.getChainId() !== foundry.id || await client.getBlockNumber() !== 0n) {
      throw new Error('An empty local development chain is required.');
    }
    const mnemonic = generateMnemonic(english);
    const accounts = [0, 1, 2].map(addressIndex => mnemonicToAccount(mnemonic, { addressIndex }));
    for (const account of accounts) {
      await client.setBalance({ address: account.address, value: parseEther('10') });
    }
    return { rpcUrl, accounts, close };
  } catch (error) {
    await close();
    throw error;
  }
}
