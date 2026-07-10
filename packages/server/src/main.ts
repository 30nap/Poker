import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createPokerServer } from './server.js';

const here = dirname(fileURLToPath(import.meta.url));
const webDist = join(here, '..', '..', 'web', 'dist');

const server = await createPokerServer({
  port: Number(process.env.PORT ?? 8080),
  staticDir: webDist,
});

console.log(`Poker server listening on http://localhost:${server.port} (ws at /ws)`);

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    void server.close().then(() => process.exit(0));
  });
}
