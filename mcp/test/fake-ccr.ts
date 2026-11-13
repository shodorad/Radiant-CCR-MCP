/**
 * A stand-in for the CCR's /ccr/records and /ccr/record, served from the repo's
 * fixtures, so the MCP is testable with no Drupal running. It imitates the
 * shape, not the PHP: the real redaction is RecordNormaliser::withoutUnpublishable.
 */
import { readFileSync, readdirSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';

const FIXTURES = fileURLToPath(new URL('../../fixtures/', import.meta.url));
const read = (f: string) => JSON.parse(readFileSync(FIXTURES + f, 'utf8'));

export function fixtureRecords() {
  const files = ['company-overview.json', 'case-study.json', ...readdirSync(FIXTURES + 'placeholder-case-studies').map((f) => `placeholder-case-studies/${f}`)];
  return files.map((f, i) => ({ ...read(f), nid: i + 1, changed: 1_794_000_000 + i }));
}

export async function startFakeCcr({ leak = false } = {}) {
  const records = fixtureRecords();
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    const send = (status: number, body: unknown) => res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(body));
    if (url.pathname === '/ccr/records') {
      const type = url.searchParams.get('type');
      return send(200, {
        records: records
          .filter((r) => !type || r.type === type)
          .map((r) => ({ id: r.id, nid: r.nid, type: r.type, title: r.title, changed: r.changed, summary: r.client_name ?? 'Radiant overview', fictional: /PLACEHOLDER|FICTIONAL/.test(r.title + (r.source_material ?? '')) })),
      });
    }
    if (url.pathname === '/ccr/record') {
      const r = records.find((x) => x.nid === Number(url.searchParams.get('nid')));
      if (!r) return send(404, { error: 'no published record' });
      if (r.type !== 'case_study' || leak) return send(200, r);
      const cut = r.source_material.indexOf('NOT FOR PUBLICATION');
      return send(200, { ...r, source_material: cut < 0 ? r.source_material : r.source_material.slice(0, cut).trimEnd(), withheld: cut < 0 ? [] : ['NOT FOR PUBLICATION'], fictional: true });
    }
    send(404, { error: 'no route' });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}`, close: () => new Promise<void>((r) => server.close(() => r())) };
}
