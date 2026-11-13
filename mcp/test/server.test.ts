import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ccrClient } from '../src/ccr.js';
import type { CallEntry } from '../src/log.js';
import { buildServer } from '../src/server.js';
import { startFakeCcr } from './fake-ccr.js';

async function connect(ccrUrl: string, calls: CallEntry[] = []) {
  const server = buildServer({ ccr: ccrClient(ccrUrl), tester: 'alice', log: (e) => calls.push(e) });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '0' });
  await Promise.all([server.connect(a), client.connect(b)]);
  return client;
}
const textOf = (r: any) => r.content.map((c: any) => c.text).join('\n');

describe('CCR MCP tools', () => {
  let ccr: Awaited<ReturnType<typeof startFakeCcr>>;
  let client: Client;
  const calls: CallEntry[] = [];
  beforeAll(async () => {
    ccr = await startFakeCcr();
    client = await connect(ccr.url, calls);
  });
  afterAll(() => ccr.close());

  it('offers exactly the two read-only phase 1 tools, with instructions', async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(['get_content', 'list_content']);
    expect(tools.every((t) => t.annotations?.readOnlyHint)).toBe(true);
    expect(client.getInstructions()).toMatch(/Do not add facts/);
  });

  it('lists everything the repository publishes, and flags placeholders', async () => {
    const out = textOf(await client.callTool({ name: 'list_content', arguments: {} }));
    expect(out).toMatch(/holds 5 published records/);
    expect(out).toMatch(/What We Do : Overall Approach/);
    expect(out).toMatch(/Harrowgate Valley Power.*placeholder/);
  });

  it('filters the listing by type', async () => {
    const out = textOf(await client.callTool({ name: 'list_content', arguments: { type: 'case_study' } }));
    expect(out).toMatch(/holds 4 published records/);
    expect(out).not.toMatch(/Overall Approach/);
  });

  it('returns the overview with emphasis as markdown, all six pillars and its source', async () => {
    const out = textOf(await client.callTool({ name: 'get_content', arguments: { nid: 1 } }));
    expect(out).toMatch(/\*\*Applied AI\*\*/);
    expect(out).not.toMatch(/<strong>/);
    expect(out).toMatch(/Capability pillars \(6\)/);
    expect(out).toMatch(/Skilled Workforce Solutions/);
    expect(out).toMatch(/Source: Radiant CCR, Company overview nid 1/);
  });

  it('returns a case study without what is not for publication, and says something was withheld', async () => {
    const out = textOf(await client.callTool({ name: 'get_content', arguments: { nid: 2 } }));
    expect(out).toMatch(/Kestrelmoor/);
    expect(out).toMatch(/47 minutes to 12 minutes/);
    expect(out).not.toMatch(/two-day outage|Contract value/);
    expect(out).toMatch(/withheld by the repository/);
    expect(out).toMatch(/PLACEHOLDER\/FICTIONAL/);
  });

  it('names list_content when a nid does not exist', async () => {
    const r: any = await client.callTool({ name: 'get_content', arguments: { nid: 999 } });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toMatch(/no published record with nid 999.*list_content/);
  });

  it('logs each call with the tester and outcome', () => {
    expect(calls.some((c) => c.tester === 'alice' && c.tool === 'get_content' && c.ok === false)).toBe(true);
    expect(calls.some((c) => c.tool === 'list_content' && c.ok)).toBe(true);
  });
});

describe('if the repository ever fails to withhold', () => {
  it('refuses the record rather than showing it', async () => {
    const ccr = await startFakeCcr({ leak: true });
    const client = await connect(ccr.url);
    const r: any = await client.callTool({ name: 'get_content', arguments: { nid: 2 } });
    expect(r.isError).toBe(true);
    expect(textOf(r)).not.toMatch(/two-day outage/);
    expect(textOf(r)).toMatch(/not for publication/);
    await ccr.close();
  });
});

describe('when the repository is down', () => {
  it('says so instead of failing silently', async () => {
    const client = await connect('http://127.0.0.1:9');
    const r: any = await client.callTool({ name: 'list_content', arguments: {} });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toMatch(/could not be reached/);
  });
});
