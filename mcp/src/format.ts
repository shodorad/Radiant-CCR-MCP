/**
 * Records as text a person reads in chat. The record is approved content, so
 * this changes how it looks and never what it says.
 */
import type { CcrRecord, Listing } from './ccr.js';

/** The CCR's constrained rich text allows only <strong>/<em>; both mean emphasis. */
export function richToMarkdown(html: string | null | undefined): string {
  if (!html) return '';
  return html
    .replace(/<(strong|b)>(.*?)<\/\1>/gis, '**$2**')
    .replace(/<(em|i)>(.*?)<\/\1>/gis, '_$2_')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>\s*<p[^>]*>/gi, '\n\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&nbsp;/g, ' ')
    .trim();
}

export function changedDate(changed: number | string): string {
  const d = typeof changed === 'number' ? new Date(changed * 1000) : new Date(changed);
  return Number.isNaN(d.getTime()) ? String(changed) : d.toISOString().slice(0, 10);
}

const TYPE_LABEL: Record<string, string> = { company_overview: 'Company overview', case_study: 'Case study' };

const FICTIONAL_NOTE = '⚠ PLACEHOLDER/FICTIONAL — written for the POC, not a real client claim. Do not use externally.';

export function formatListing(records: Listing[]): string {
  if (!records.length) return 'The content repository has no published content of that type.';
  const lines = records.map((r) =>
    `- **${r.title}** — ${TYPE_LABEL[r.type] ?? r.type}, nid ${r.nid}, updated ${changedDate(r.changed)}${r.fictional ? ' — ⚠ placeholder' : ''}\n  ${r.summary}`
  );
  return [
    `The Radiant content repository holds ${records.length} published record${records.length === 1 ? '' : 's'}:`,
    '',
    ...lines,
    '',
    'Call get_content with a nid to read one in full. Today this server returns approved content only; on-brand decks are coming in phase 2.',
  ].join('\n');
}

/** A heading line that would mean the repository failed to withhold a section. */
export const UNPUBLISHABLE = /^\s*NOT FOR PUBLICATION\b/m;

export function formatRecord(r: CcrRecord): string {
  const out: string[] = [`# ${r.title}`, ''];
  if (r.fictional) out.push(FICTIONAL_NOTE, '');

  if (r.type === 'company_overview') {
    if (r.positioning_statement) out.push('## Positioning statement', richToMarkdown(r.positioning_statement), '');
    if (r.framework_name || r.framework_statement) {
      out.push(`## Framework: ${r.framework_name ?? ''}`.trimEnd(), richToMarkdown(r.framework_statement), '');
    }
    const pillars = [...(r.capability_pillars ?? [])].sort((a, b) => a.weight - b.weight);
    if (pillars.length) {
      out.push(`## Capability pillars (${pillars.length})`);
      for (const p of pillars) out.push(`- **${p.name ?? ''}** — ${richToMarkdown(p.description)}`);
      out.push('');
    }
  } else if (r.type === 'case_study') {
    if (r.client_name) out.push(`**Client:** ${r.client_name}`, '');
    out.push(
      'This is the case study\'s source material. Results are measured unless marked otherwise; anything under NOT YET MEASURED is a projection and must be described as anticipated, never as a result.',
      '',
      (r.source_material ?? '').trim(),
      ''
    );
    if (r.withheld?.length) {
      out.push(`_${r.withheld.length} section${r.withheld.length === 1 ? ' was' : 's were'} withheld by the repository as not for publication._`, '');
    }
  }

  out.push('---', `Source: Radiant CCR, ${TYPE_LABEL[r.type] ?? r.type} nid ${r.nid} (record ${r.id}), last updated ${changedDate(r.changed)}.`);
  return out.join('\n');
}
