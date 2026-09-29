import { spawn } from 'node:child_process';

/** Nova's Bonjour service type: how an iPhone on the same Wi-Fi finds its Mac, whatever address it has today. */
export const SERVICE = '_nova._tcp';

/**
 * Tell the network the door is here, for as long as it's open - with macOS's own dns-sd. It runs
 * under a shell that ends it once the daemon is gone (its stdin closes), so no stale service is left
 * when the daemon is stopped hard. Returns how to stop it.
 */
export function advertise(name: string, port: number, txt: Record<string, string>): () => void {
  const args = ['-R', name.slice(0, 63), SERVICE, 'local', String(port), ...Object.entries(txt).map(([k, v]) => `${k}=${v}`)];
  const child = spawn('/bin/sh', ['-c', 'dns-sd "$@" >/dev/null 2>&1 & pid=$!; read -r _; kill "$pid"', 'bonjour', ...args], { stdio: ['pipe', 'ignore', 'ignore'] });
  child.on('error', (e) => console.warn(`  [iphone] Bonjour: ${e.message}`));
  child.stdin.on('error', () => {});
  return () => {
    child.stdin.end(); // the shell stops dns-sd, then itself
    setTimeout(() => child.kill(), 2000).unref();
  };
}
