/**
 * One JSON line per tool call on stdout, which `docker compose logs mcp`
 * collects. This is the evidence for decision 6 (go ahead with phase 2?):
 * who used it, for what, and whether it answered. Arguments are logged; keys
 * and returned content are not.
 */
export interface CallEntry {
  tester: string;
  tool: string;
  args: unknown;
  ms: number;
  ok: boolean;
  error?: string;
}

export type CallLogger = (entry: CallEntry) => void;

export const stdoutLogger: CallLogger = (entry) => {
  process.stdout.write(JSON.stringify({ at: new Date().toISOString(), event: 'tool_call', ...entry }) + '\n');
};
