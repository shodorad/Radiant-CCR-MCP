/**
 * Streamable HTTP entry point, stateless: one server and transport per request.
 * Routes: GET /health, POST /mcp (Bearer key) or POST /mcp/<key>.
 */
import http from 'node:http';
import { pathToFileURL } from 'node:url';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { authenticate, parseKeys, presentedKey, type Tester } from './auth.js';
import { ccrClient, type CcrClient } from './ccr.js';
import { config } from './config.js';
import { stdoutLogger, type CallLogger } from './log.js';
import { buildServer } from './server.js';

const MCP_PATH = /^\/mcp(?:\/([^/]+))?\/?$/;

function sendJson(res: http.ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json', ...headers }).end(JSON.stringify(body));
}

export function createHttpServer({ testers, ccr, log = stdoutLogger }: { testers: Tester[]; ccr: CcrClient; log?: CallLogger }) {
  return http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');

    if (url.pathname === '/health') return sendJson(res, 200, { ok: true, name: 'radiant-ccr-mcp' });

    const match = url.pathname.match(MCP_PATH);
    if (!match) return sendJson(res, 404, { error: 'not found' });

    const tester = authenticate(testers, presentedKey(req, match[1]));
    if (!tester) {
      return sendJson(res, 401, { jsonrpc: '2.0', error: { code: -32001, message: 'A valid CCR access key is required.' }, id: null });
    }

    if (req.method !== 'POST') {
      // Stateless: no server-initiated stream and no sessions to delete.
      return sendJson(res, 405, { jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed.' }, id: null }, { Allow: 'POST' });
    }

    const server = buildServer({ ccr, tester, log });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on('close', () => {
      void transport.close();
      void server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res);
    } catch (e) {
      console.error(`mcp error: ${(e as Error).message}`);
      if (!res.headersSent) sendJson(res, 500, { jsonrpc: '2.0', error: { code: -32603, message: 'Internal error' }, id: null });
    }
  });
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const testers = parseKeys(config.keys);
  if (!testers.length) {
    console.error('MCP_KEYS is empty: set at least one name:key pair (see mcp/.env.example).');
    process.exit(1);
  }
  createHttpServer({ testers, ccr: ccrClient(config.ccrUrl) }).listen(config.port, () => {
    // Never log keys or request URLs: a key can travel in the path.
    console.log(`radiant-ccr-mcp listening on :${config.port}, CCR at ${config.ccrUrl}, ${testers.length} tester key(s): ${testers.map((t) => t.name).join(', ')}`);
  });
}
