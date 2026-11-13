#!/usr/bin/env node
/**
 * Structural check on a generated .pptx.
 *
 * Standing in for the `validate.py` named in plan.md phase 1: the point of that
 * acceptance criterion is "PowerPoint opens the file with no repair dialog",
 * and almost every repair dialog traces to one of four things — malformed XML,
 * a relationship pointing at a part that is not in the package, a part with no
 * content type, or a r:embed with no matching relationship. All four are
 * checkable without PowerPoint.
 *
 *   node validate.js out/company-overview.pptx
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const JSZip = require('jszip');

/** The part a .rels file describes. `_rels/.rels` describes the package root. */
const ownerOf = (relsPart) =>
  relsPart === '_rels/.rels' ? '' : relsPart.replace(/(^|\/)_rels\/([^/]+)\.rels$/, '$1$2');

/** Extension, treating a leading-dot basename such as `.rels` as its own extension. */
const extensionOf = (part) => {
  const base = path.posix.basename(part);
  const dot = base.lastIndexOf('.');
  return dot < 0 ? '' : base.slice(dot + 1).toLowerCase();
};

function resolveTarget(part, target) {
  if (/^[a-z]+:/i.test(target)) return null; // external
  const base = part === '' ? '' : path.posix.dirname(part);
  return path.posix.normalize(path.posix.join(base, target)).replace(/^\/+/, '');
}

/** Values that must be unique, reported once per repeated value. */
function duplicates(values, what) {
  const seen = new Set();
  const repeated = new Set();
  for (const v of values) {
    if (v === undefined) continue;
    if (seen.has(v)) repeated.add(v);
    seen.add(v);
  }
  return [...repeated].map((v) => `${what} "${v}" is used more than once`);
}

function xmlWellFormed(name, text) {
  try {
    execFileSync('xmllint', ['--noout', '-'], { input: text, stdio: ['pipe', 'ignore', 'pipe'] });
    return null;
  } catch (e) {
    if (e.code === 'ENOENT') return null; // xmllint unavailable — skip, not fail
    return `${name}: ${String(e.stderr || e.message).trim().split('\n')[0]}`;
  }
}

async function validate(file) {
  const errors = [];
  const zip = await JSZip.loadAsync(fs.readFileSync(file));
  const parts = Object.keys(zip.files).filter((n) => !zip.files[n].dir);
  const has = (p) => parts.includes(p);

  // 1. every XML part parses
  const xml = new Map();
  for (const p of parts) {
    if (!/\.(xml|rels)$/.test(p)) continue;
    const text = await zip.file(p).async('string');
    xml.set(p, text);
    const problem = xmlWellFormed(p, text);
    if (problem) errors.push(`malformed XML — ${problem}`);
  }

  // 2. content types cover every part
  const ct = xml.get('[Content_Types].xml');
  if (!ct) errors.push('missing [Content_Types].xml');
  else {
    const defaults = new Set([...ct.matchAll(/<Default\s+Extension="([^"]+)"/gi)].map((m) => m[1].toLowerCase()));
    const overrides = new Set([...ct.matchAll(/<Override\s+PartName="([^"]+)"/gi)].map((m) => m[1]));
    for (const p of parts) {
      if (p === '[Content_Types].xml') continue;
      const ext = extensionOf(p);
      if (overrides.has(`/${p}`) || defaults.has(ext)) continue;
      errors.push(`no content type declared for ${p}`);
    }
  }

  // 3. relationship targets exist, and 4. r:id references have a relationship
  for (const [relsPart, text] of xml) {
    if (!relsPart.endsWith('.rels')) continue;
    const owner = ownerOf(relsPart);
    const ids = new Set();
    for (const m of text.matchAll(/<Relationship\s+[^>]*>/g)) {
      const id = (/Id="([^"]+)"/.exec(m[0]) || [])[1];
      const target = (/Target="([^"]+)"/.exec(m[0]) || [])[1];
      const mode = (/TargetMode="([^"]+)"/.exec(m[0]) || [])[1];
      ids.add(id);
      if (mode === 'External') continue;
      const resolved = resolveTarget(owner, target);
      if (resolved && !has(resolved)) errors.push(`${relsPart}: ${id} points at missing part ${resolved}`);
    }
    const ownerXml = xml.get(owner);
    if (!ownerXml) continue;
    for (const m of ownerXml.matchAll(/r:(?:id|embed|link|pict|dm|lo|qs|cs)="([^"]+)"/g)) {
      if (!ids.has(m[1])) errors.push(`${owner}: references ${m[1]} but ${relsPart} does not define it`);
    }
  }

  // p:sldMasterId and p:sldLayoutId share one number space, so they are
  // collected here and checked together below. Learned the hard way: a deck
  // whose second master id equalled its first master's layout id passed every
  // check in this file and was still repaired by PowerPoint on open.
  const masterIds = [];
  const layoutIds = [];

  // 5. every declared slide is present, and no two of anything collide
  //
  // A one-slide package cannot get these wrong, so none of them existed until
  // decks were assembled from several templates. Every one of them is a way to
  // produce a file that passes checks 1-4 and still makes PowerPoint offer to
  // repair it — or, worse, opens and shows one slide twice.
  const pres = xml.get('ppt/presentation.xml');
  if (pres) {
    const sldIds = [...pres.matchAll(/<p:sldId\b[^>]*\/>/g)].map((m) => m[0]);
    const slideParts = parts.filter((p) => /^ppt\/slides\/slide\d+\.xml$/.test(p)).length;
    if (sldIds.length !== slideParts) {
      errors.push(`presentation declares ${sldIds.length} slides but the package holds ${slideParts}`);
    }
    errors.push(...duplicates(sldIds.map((x) => (/id="(\d+)"/.exec(x) || [])[1]), 'p:sldId id'));
    errors.push(...duplicates(sldIds.map((x) => (/r:id="([^"]+)"/.exec(x) || [])[1]), 'p:sldId r:id'));

    // Every slide in the running order must resolve to a part of its own. Two
    // sldIds pointing at one slide is a deck that silently shows it twice.
    const presRels = xml.get('ppt/_rels/presentation.xml.rels') || '';
    const targets = new Map();
    for (const m of presRels.matchAll(/<Relationship\s+[^>]*>/g)) {
      const id = (/Id="([^"]+)"/.exec(m[0]) || [])[1];
      const target = (/Target="([^"]+)"/.exec(m[0]) || [])[1];
      targets.set(id, resolveTarget('ppt/presentation.xml', target));
    }
    const pointedAt = [];
    for (const x of sldIds) {
      const rid = (/r:id="([^"]+)"/.exec(x) || [])[1];
      const target = targets.get(rid);
      if (!target) { errors.push(`presentation lists slide ${rid}, which its relationships do not define`); continue; }
      pointedAt.push(target);
    }
    errors.push(...duplicates(pointedAt, 'slide part in the running order'));

    masterIds.push(...[...pres.matchAll(/<p:sldMasterId\b[^>]*id="(\d+)"/g)].map((m) => m[1]));
  }

  // 6. ids that must be unique inside one part
  for (const [part, text] of xml) {
    if (part.endsWith('.rels')) {
      errors.push(...duplicates(
        [...text.matchAll(/<Relationship\s+[^>]*Id="([^"]+)"/g)].map((m) => m[1]), `relationship id in ${part}`
      ));
      continue;
    }
    if (/^ppt\/slides\/slide\d+\.xml$/.test(part) || /^ppt\/slideLayouts\//.test(part) || /^ppt\/slideMasters\//.test(part)) {
      // A shape id repeated inside one slide is what cloning a shape gets wrong.
      errors.push(...duplicates(
        [...text.matchAll(/<p:cNvPr\s+id="(\d+)"/g)].map((m) => m[1]), `shape id in ${part}`
      ));
    }
    if (/^ppt\/slideMasters\/[^/]+\.xml$/.test(part)) {
      layoutIds.push(...[...text.matchAll(/<p:sldLayoutId\b[^>]*id="(\d+)"/g)].map((m) => m[1]));
    }
  }
  errors.push(...duplicates([...masterIds, ...layoutIds], 'p:sldMasterId / p:sldLayoutId id'));

  if (ct) {
    errors.push(...duplicates(
      [...ct.matchAll(/<Override\s+PartName="([^"]+)"/gi)].map((m) => m[1]), 'content-type override'
    ));
  }

  // 6. nothing dangling in media
  const referenced = new Set();
  for (const [p, text] of xml) {
    if (!p.endsWith('.rels')) continue;
    const owner = p.replace(/_rels\/([^/]+)\.rels$/, '$1');
    for (const m of text.matchAll(/Target="([^"]+)"/g)) {
      const r = resolveTarget(owner, m[1]);
      if (r) referenced.add(r);
    }
  }
  const orphans = parts.filter((p) => p.startsWith('ppt/media/') && !referenced.has(p));

  return { errors, parts: parts.length, orphans, bytes: fs.statSync(file).size };
}

if (require.main === module) {
  const file = process.argv[2] || 'out/company-overview.pptx';
  validate(file)
    .then(({ errors, parts, orphans, bytes }) => {
      console.log(`file    ${file}  ${(bytes / 1024).toFixed(0)} KB, ${parts} parts`);
      if (orphans.length) console.log(`unused  ${orphans.join(', ')}`);
      if (errors.length) {
        console.log(`\n${errors.length} problem${errors.length === 1 ? '' : 's'}:`);
        for (const e of errors) console.log(`  ✗ ${e}`);
        process.exit(1);
      }
      console.log('result  valid — no repair dialog expected');
    })
    .catch((e) => { console.error(e.message); process.exit(1); });
}

module.exports = { validate };
