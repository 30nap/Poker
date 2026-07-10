/**
 * Minimal static file server for the built web client. No directory
 * traversal (paths are resolved and must stay inside the root), SPA
 * fallback to index.html for client-side routes.
 */

import { createReadStream, existsSync, statSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { extname, join, resolve } from 'node:path';

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.map': 'application/json',
};

export function serveStatic(
  req: IncomingMessage,
  res: ServerResponse,
  staticDir: string | undefined,
): void {
  if (!staticDir || !existsSync(staticDir)) {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('Poker room server is running. Connect via the web client (/ws).');
    return;
  }

  const root = resolve(staticDir);
  const urlPath = decodeURIComponent((req.url ?? '/').split('?')[0]!);
  let filePath = resolve(join(root, urlPath === '/' ? 'index.html' : urlPath));

  if (!filePath.startsWith(root)) {
    res.writeHead(403);
    res.end('forbidden');
    return;
  }
  if (!existsSync(filePath) || !statSync(filePath).isFile()) {
    filePath = join(root, 'index.html'); // SPA fallback
  }

  res.writeHead(200, {
    'content-type': MIME[extname(filePath)] ?? 'application/octet-stream',
    'cache-control': filePath.includes('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache',
  });
  createReadStream(filePath).pipe(res);
}
