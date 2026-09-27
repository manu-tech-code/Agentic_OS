import { readFile, stat } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

/** The window's built files (npm run build). */
export const UI_DIR = fileURLToPath(new URL('../../../desktop/dist', import.meta.url));

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.map': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.wasm': 'application/wasm',
};

/**
 * Nova's window, served from the daemon's own address, so the Mac app needs no dev server. Only
 * for requests addressed to this Mac by name (a page elsewhere pointing its own domain at
 * 127.0.0.1 gets nothing), only files inside the build, and never inside another site's frame.
 */
export async function serveUi(req: IncomingMessage, res: ServerResponse, port: number, root = UI_DIR): Promise<boolean> {
  if (req.method !== 'GET' && req.method !== 'HEAD') return false;
  if (req.headers.host !== `127.0.0.1:${port}` && req.headers.host !== `localhost:${port}`) return false;
  let path: string;
  try {
    path = decodeURIComponent(new URL(req.url ?? '/', 'http://127.0.0.1').pathname);
  } catch {
    return false;
  }
  if (path.includes('\0')) return false;
  const base = resolve(root);
  const file = resolve(base, `.${path === '/' ? '/index.html' : path}`);
  if (!file.startsWith(base + sep)) return false; // outside the build
  let body: Buffer;
  try {
    if (!(await stat(file)).isFile()) return false;
    body = await readFile(file);
  } catch {
    return false;
  }
  const index = file === resolve(base, 'index.html');
  // The page learns it came from the daemon itself, so it talks to the daemon at this address.
  if (index) body = Buffer.from(body.toString('utf8').replace('<head>', '<head>\n    <meta name="nova-daemon" content="1" />'));
  const hashed = file.startsWith(resolve(base, 'assets') + sep); // Vite puts a hash in these names
  res.writeHead(200, {
    'content-type': TYPES[extname(file).toLowerCase()] ?? 'application/octet-stream',
    'cache-control': hashed ? 'public, max-age=31536000, immutable' : 'no-cache',
    'x-content-type-options': 'nosniff',
    'x-frame-options': 'DENY',
    'content-security-policy': "frame-ancestors 'none'",
  });
  res.end(req.method === 'HEAD' ? undefined : body);
  return true;
}
