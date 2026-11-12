import { describe, expect, it } from 'vitest';
import { createConfig } from '../src/config.js';
import { formatKr, markdownTable, truncate } from '../src/format.js';

describe('createConfig', () => {
  it('applies defaults', () => {
    const c = createConfig({});
    expect(c).toMatchObject({ baseUrl: 'https://godpris.no', rps: 1, maxPages: 10, transport: 'stdio', host: '127.0.0.1', port: 3333 });
    expect(c.allowedHosts).toBeUndefined();
  });

  it('parses overrides', () => {
    const c = createConfig({ GODPRIS_RPS: '2', GODPRIS_TRANSPORT: 'http', GODPRIS_ALLOWED_HOSTS: 'a, b', GODPRIS_VERSION: '1.2.3' });
    expect(c).toMatchObject({ rps: 2, transport: 'http', allowedHosts: ['a', 'b'], version: '1.2.3' });
  });

  it('parses allowed origins and timeout', () => {
    const c = createConfig({ GODPRIS_ALLOWED_ORIGINS: 'http://localhost:6274, https://x.test', GODPRIS_TIMEOUT_MS: '5000' });
    expect(c).toMatchObject({ allowedOrigins: ['http://localhost:6274', 'https://x.test'], timeoutMs: 5000 });
    expect(createConfig({}).timeoutMs).toBe(15000);
  });

  it('rejects invalid values', () => {
    expect(() => createConfig({ GODPRIS_TRANSPORT: 'ws' })).toThrow();
  });
});

describe('format', () => {
  it('formatKr groups thousands', () => {
    expect(formatKr(9171)).toBe('kr 9 171');
    expect(formatKr(999)).toBe('kr 999');
    expect(formatKr(1234567)).toBe('kr 1 234 567');
  });
  it('markdownTable escapes pipes', () => {
    expect(markdownTable(['a', 'b'], [['x|y', 1]])).toBe('| a | b |\n| --- | --- |\n| x\\|y | 1 |');
  });
  it('truncate', () => {
    expect(truncate('abcdef', 4)).toBe('abc…');
    expect(truncate('abc', 4)).toBe('abc');
  });
});
