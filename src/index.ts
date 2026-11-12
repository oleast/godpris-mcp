#!/usr/bin/env node
import { getConfig } from './config.js';
import { createServer } from './server.js';
import { runHttp } from './transports/http.js';
import { runStdio } from './transports/stdio.js';

function argValue(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  const config = getConfig();
  const transport = process.argv.includes('--http') ? 'http' : config.transport;

  if (transport === 'http') {
    const portArg = argValue('--port');
    const port = portArg === undefined ? undefined : Number(portArg);
    if (port !== undefined && !(Number.isInteger(port) && port >= 0 && port <= 65535)) {
      throw new Error(`Invalid --port: ${portArg}`);
    }
    await runHttp({ host: argValue('--host'), port });
    return;
  }

  await runStdio(createServer());
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
