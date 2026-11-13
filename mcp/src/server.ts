/**
 * The CCR MCP server: what the repository holds, and the content itself.
 * Phase 1 is read-only. Phase 2 adds get_brand_rules and build_presentation.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { CcrError, RECORD_TYPES, type CcrClient } from './ccr.js';
import { formatListing, formatRecord, UNPUBLISHABLE } from './format.js';
import type { CallLogger } from './log.js';

export const SERVER_NAME = 'radiant-ccr';
export const SERVER_VERSION = '0.1.0';

export const INSTRUCTIONS = `This server is Radiant's Central Content Repository (CCR): the approved source for how Radiant describes itself — the company overview, its capability pillars, and client case studies.

- Start with list_content to see what exists, then get_content for the records you need.
- Treat the content as approved wording. Quote it or stay close to it. Do not add facts, numbers, clients or claims it does not state.
- In case studies, anything under NOT YET MEASURED is a projection: call it anticipated, never a result.
- Records marked PLACEHOLDER or FICTIONAL are test content for this pilot. Say so whenever you use them.
- Cite the record you used (its title and last-updated date).`;

export interface ServerDeps {
  ccr: CcrClient;
  tester: string;
  log: CallLogger;
}

const text = (t: string, isError = false): CallToolResult => ({ content: [{ type: 'text', text: t }], ...(isError ? { isError } : {}) });

export function buildServer({ ccr, tester, log }: ServerDeps): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION }, { instructions: INSTRUCTIONS });

  async function logged(tool: string, args: unknown, run: () => Promise<string>): Promise<CallToolResult> {
    const started = Date.now();
    try {
      const out = await run();
      log({ tester, tool, args, ms: Date.now() - started, ok: true });
      return text(out);
    } catch (e) {
      const message = e instanceof CcrError || e instanceof RefusedError ? e.message : 'unexpected error reading the content repository';
      log({ tester, tool, args, ms: Date.now() - started, ok: false, error: (e as Error).message });
      return text(message, true);
    }
  }

  server.registerTool(
    'list_content',
    {
      title: 'List Radiant content',
      description:
        'List the approved content in Radiant\'s content repository: the company overview and client case studies, each with a one-line summary, its nid and when it was last updated. Use this first to choose what to read.',
      inputSchema: { type: z.enum(RECORD_TYPES).optional().describe('Only list this kind of content.') },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    (args) => logged('list_content', args, async () => formatListing(await ccr.listRecords(args.type)))
  );

  server.registerTool(
    'get_content',
    {
      title: 'Get Radiant content',
      description:
        'Read one record from Radiant\'s content repository in full, by the nid list_content gives. Returns the approved wording with its source and last-updated date.',
      inputSchema: { nid: z.number().int().positive().describe('The record\'s nid, from list_content.') },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    (args) =>
      logged('get_content', args, async () => {
        let record;
        try {
          record = await ccr.getRecord(args.nid);
        } catch (e) {
          if (e instanceof CcrError && e.status === 404) {
            throw new CcrError(`There is no published record with nid ${args.nid}. Call list_content to see which nids exist.`, 404);
          }
          throw e;
        }
        // Belt and braces: the repository withholds these sections in its
        // public view. If one ever arrives anyway, refuse rather than show it.
        if (UNPUBLISHABLE.test(record.source_material ?? '')) {
          throw new RefusedError(`Record ${args.nid} could not be shown: it still contains material marked not for publication. Please report this to the CCR team.`);
        }
        return formatRecord(record);
      })
  );

  return server;
}

export class RefusedError extends Error {}
