/**
 * Named shared keys, one per tester (POC plan, decision 1).
 *
 * MCP_KEYS="alice:<key>,bob:<key>". A key arrives either as
 * `Authorization: Bearer <key>` or as the last path segment, /mcp/<key>. The
 * path form exists because the claude.ai custom-connector form takes only a
 * URL. Keys are compared in constant time and never logged.
 */
import { createHash, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';

export interface Tester {
  name: string;
  digest: Buffer;
}

const MIN_KEY_LENGTH = 24;
const digest = (key: string) => createHash('sha256').update(key).digest();

export function parseKeys(spec: string | undefined): Tester[] {
  const testers = (spec ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((entry) => {
      const at = entry.indexOf(':');
      const name = entry.slice(0, at).trim();
      const key = entry.slice(at + 1).trim();
      if (at < 1 || !name) throw new Error(`MCP_KEYS entry "${entry.slice(0, 12)}…" is not name:key`);
      if (key.length < MIN_KEY_LENGTH) throw new Error(`the key for "${name}" is shorter than ${MIN_KEY_LENGTH} characters`);
      return { name, digest: digest(key) };
    });
  const names = testers.map((t) => t.name);
  const dup = names.find((n, i) => names.indexOf(n) !== i);
  if (dup) throw new Error(`MCP_KEYS names "${dup}" twice`);
  return testers;
}

/** The tester a key belongs to, or null. Checks every key so timing says nothing. */
export function authenticate(testers: Tester[], presented: string | undefined): string | null {
  if (!presented) return null;
  const d = digest(presented);
  let match: string | null = null;
  for (const t of testers) if (timingSafeEqual(t.digest, d)) match = t.name;
  return match;
}

/** The key a request presents, from the header or the path. */
export function presentedKey(req: IncomingMessage, pathKey: string | undefined): string | undefined {
  const header = req.headers.authorization;
  const bearer = header?.match(/^Bearer\s+(.+)$/i)?.[1]?.trim();
  return bearer || pathKey || undefined;
}
