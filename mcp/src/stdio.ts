/**
 * Local entry for Claude Code / Desktop during development. No key: whoever
 * can run this process can already read the CCR it points at.
 *
 *   claude mcp add ccr-local -e CCR_INTERNAL_URL=http://ccr-mcp.ddev.site -- npx tsx /path/to/mcp/src/stdio.ts
 */
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ccrClient } from './ccr.js';
import { config } from './config.js';
import { buildServer } from './server.js';

// stdout is the protocol channel here, so the call log goes to stderr.
const server = buildServer({
  ccr: ccrClient(config.ccrUrl),
  tester: 'local',
  log: (entry) => process.stderr.write(JSON.stringify({ event: 'tool_call', ...entry }) + '\n'),
});
await server.connect(new StdioServerTransport());
