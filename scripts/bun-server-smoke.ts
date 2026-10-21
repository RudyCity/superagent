/**
 * Isolated Bun API-server smoke: a random localhost port and disposable config.
 * Never touches the existing port 7888 or another live SuperAgent instance.
 */
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

if (!process.versions.bun) throw new Error('Run server smoke under Bun');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const home = await fs.mkdtemp(path.join(os.tmpdir(), 'superagent-bun-server-'));
const getFreePort = async () => new Promise<number>((resolve, reject) => {
  const listener = net.createServer();
  listener.once('error', reject);
  listener.listen(0, '127.0.0.1', () => {
    const addr = listener.address();
    listener.close(() => typeof addr === 'object' && addr
      ? resolve(addr.port) : reject(new Error('Missing ephemeral port')));
  });
});
let server: ReturnType<typeof Bun.spawn> | undefined;
try {
  const port = await getFreePort();
  const env = {
    ...process.env,
    SUPERAGENT_CONFIG_DIR: path.join(home, 'config'),
    HOME: home,
    USERPROFILE: home,
    SUPERAGENT_SERVER_PORT: String(port),
  };
  const cli = path.join(root, 'dist', 'cli.js');
  server = Bun.spawn([process.execPath, cli, '--server', String(port), '--client-mode', 'tline'], {
    cwd: root, env, stdout: 'pipe', stderr: 'pipe',
  });
  let output = '';
  const drain = async (stream: ReadableStream<Uint8Array> | number | null | undefined) => {
    if (!stream || typeof stream === 'number') return;
    try {
      for await (const bytes of stream as any) {
        output = (output + new TextDecoder().decode(bytes)).slice(-2500);
      }
    } catch {}
  };
  void drain(server.stdout);
  void drain(server.stderr);
  let status: number | undefined;
  for (let i = 0; i < 50; i++) {
    if (server.exitCode !== null) break;
    try {
      const response = await fetch('http://127.0.0.1:' + port + '/api/status', {
        signal: AbortSignal.timeout(400),
      });
      status = response.status;
      break;
    } catch { await Bun.sleep(150); }
  }
  if (!status) throw new Error('Bun server did not listen on isolated port. ' + output);
  const discovery = JSON.parse(await fs.readFile(path.join(home, 'config', 'server-info-' + port + '.json'), 'utf8'));
  if (discovery.port !== port || !/^[0-9a-f]{48}$/i.test(discovery.authToken)) {
    throw new Error('Expected isolated server credentials in per-port discovery file');
  }
  const authorized = await fetch('http://127.0.0.1:' + port + '/api/ping', {
    headers: { Authorization: 'Bearer ' + discovery.authToken },
    signal: AbortSignal.timeout(2000),
  });
  if (authorized.status !== 200) throw new Error('Authenticated server ping was rejected');
  if (output.includes(discovery.authToken)) throw new Error('Server leaked its bearer credential to process output');
  console.log('BUN_SERVER_SMOKE_OK port=ephemeral unauthorized=' + status + ' authorized=200 token=redacted');
} finally {
  if (server) {
    try { server.kill(); } catch {}
    await Promise.race([server.exited, Bun.sleep(1000)]);
  }
  await fs.rm(home, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
}
