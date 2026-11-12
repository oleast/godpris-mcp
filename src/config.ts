import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';

const envSchema = z.object({
  GODPRIS_BASE_URL: z.string().url().default('https://godpris.no'),
  GODPRIS_RPS: z.coerce.number().positive().default(1),
  GODPRIS_DATA_DIR: z.string().min(1).default(join(homedir(), '.godpris-mcp')),
  GODPRIS_MAX_PAGES: z.coerce.number().int().positive().default(10),
  GODPRIS_TRANSPORT: z.enum(['stdio', 'http']).default('stdio'),
  GODPRIS_HOST: z.string().min(1).default('127.0.0.1'),
  GODPRIS_PORT: z.coerce.number().int().min(0).max(65535).default(3333),
  GODPRIS_ALLOWED_HOSTS: z.string().optional(),
  GODPRIS_ALLOWED_ORIGINS: z.string().optional(),
  GODPRIS_TIMEOUT_MS: z.coerce.number().int().positive().default(15000),
  GODPRIS_VERSION: z.string().optional(),
});

export interface Config {
  baseUrl: string;
  rps: number;
  dataDir: string;
  maxPages: number;
  transport: 'stdio' | 'http';
  host: string;
  port: number;
  allowedHosts?: string[];
  allowedOrigins?: string[];
  timeoutMs: number;
  version: string;
}

function packageVersion(): string {
  try {
    const url = new URL('../package.json', import.meta.url);
    return (JSON.parse(readFileSync(url, 'utf8')) as { version?: string }).version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

/** Build a validated config from an env-like object (empty strings count as unset). */
export function createConfig(env: Record<string, string | undefined> = process.env): Config {
  const clean = Object.fromEntries(Object.entries(env).filter(([, v]) => v !== undefined && v !== ''));
  const e = envSchema.parse(clean);
  const allowedHosts = e.GODPRIS_ALLOWED_HOSTS?.split(',')
    .map((h) => h.trim())
    .filter(Boolean);
  const allowedOrigins = e.GODPRIS_ALLOWED_ORIGINS?.split(',')
    .map((o) => o.trim())
    .filter(Boolean);
  return {
    baseUrl: e.GODPRIS_BASE_URL.replace(/\/+$/, ''),
    rps: e.GODPRIS_RPS,
    dataDir: e.GODPRIS_DATA_DIR,
    maxPages: e.GODPRIS_MAX_PAGES,
    transport: e.GODPRIS_TRANSPORT,
    host: e.GODPRIS_HOST,
    port: e.GODPRIS_PORT,
    allowedHosts: allowedHosts?.length ? allowedHosts : undefined,
    allowedOrigins: allowedOrigins?.length ? allowedOrigins : undefined,
    timeoutMs: e.GODPRIS_TIMEOUT_MS,
    version: e.GODPRIS_VERSION ?? packageVersion(),
  };
}

let current: Config | undefined;

/** Process-wide config, read once from process.env. */
export function getConfig(): Config {
  return (current ??= createConfig());
}
