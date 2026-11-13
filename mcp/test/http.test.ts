import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { authenticate, parseKeys } from '../src/auth.js';
import { ccrClient } from '../src/ccr.js';
import { createHttpServer } from '../src/http.js';
import { startFakeCcr } from './fake-ccr.js';

const ALICE = 'alice-key-0123456789abcdefghij';
const BOB = 'bob-key-0123456789abcdefghijklm';

describe('keys', () => {
  it('parses name:key pairs and refuses short or duplicate keys', () => {
    expect(parseKeys(`alice:${ALICE}, bob:${BOB}`).map((t) => t.name)).toEqual(['alice', 'bob']);
    expect(() => parseKeys('alice:short')).toThrow(/shorter than/);
    expect(() => parseKeys(`alice:${ALICE},alice:${BOB}`)).toThrow(/twice/);
    expect(() => parseKeys(ALICE)).toThrow(/name:key/);
  });
  it('maps a key to its tester and nothing else', () => {
    const testers = parseKeys(`alice:${ALICE},bob:${BOB}`);
    expect(authenticate(testers, BOB)).toBe('bob');
    expect(authenticate(testers, BOB + 'x')).toBeNull();
    expect(authenticate(testers, undefined)).toBeNull();
  });
});

describe('HTTP transport', () => {
  let ccr: Awaited<ReturnType<typeof startFakeCcr>>;
  let server: Server;
  let base: string;
  const calls: string[] = [];
  beforeAll(async () => {
    ccr = await startFakeCcr();
    server = createHttpServer({ testers: parseKeys(`alice:${ALICE},bob:${BOB}`), ccr: ccrClient(ccr.url), log: (e) => calls.push(e.tester) });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(async () => {
    await new Promise<void>((r) => server.close(() => r()));
    await ccr.close();
  });

  it('answers /health without a key', async () => {
    expect((await fetch(`${base}/health`)).status).toBe(200);
  });

  it.each([
    ['no key', '/mcp', {}],
    ['a wrong bearer key', '/mcp', { Authorization: 'Bearer nope-nope-nope-nope-nope-nope' }],
    ['a wrong path key', '/mcp/nope-nope-nope-nope-nope-nope', {}],
  ])('refuses %s with 401', async (_, path, headers) => {
    const res = await fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: '{}' });
    expect(res.status).toBe(401);
  });

  it('serves a full MCP session with the key in the path (the claude.ai connector form)', async () => {
    const client = new Client({ name: 'test', version: '0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp/${ALICE}`)));
    const r: any = await client.callTool({ name: 'list_content', arguments: {} });
    expect(r.content[0].text).toMatch(/holds 5 published records/);
    await client.close();
    expect(calls).toContain('alice');
  });

  it('serves a full MCP session with a bearer key, attributed to that tester', async () => {
    const client = new Client({ name: 'test', version: '0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${BOB}` } } }));
    const { tools } = await client.listTools();
    expect(tools).toHaveLength(2);
    await client.callTool({ name: 'get_content', arguments: { nid: 1 } });
    await client.close();
    expect(calls).toContain('bob');
  });
});
