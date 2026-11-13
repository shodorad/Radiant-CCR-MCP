#!/usr/bin/env node
/**
 * Give a template's shapes the names its blueprint card looks for.
 *
 *   node template/name-slots.js [card-id]        report what would change
 *   node template/name-slots.js [card-id] --write apply it
 *
 * Why this exists. The source deck names its shapes the way the tool that
 * exported it felt like naming them: three different pillars on slide 4 are all
 * called "Google Shape;185;p30". A card cannot ask for a slot by name until the
 * names are distinct, so the first time a template is brought into the library
 * its shapes are named after the slots they hold — `slot.items.3.description`
 * rather than a serial number.
 *
 * Which shape gets which name is decided by the card's own `find.else`
 * geometry, not by a second table living here. That is deliberate: slide 4's
 * measurements are written down once, in the card, and this tool and the
 * renderer's fallback read the same numbers. A table here would be a copy, and
 * a copy is a thing that goes out of date.
 *
 * The rename is idempotent — geometry does not care what a shape is called, so
 * running it twice does nothing the second time — and it is inert: a shape name
 * is what PowerPoint shows in the Selection Pane and affects no pixel.
 */
const fs = require('fs');
const path = require('path');
const JSZip = require('jszip');
const card = require('../lib/card');
const slots = require('../lib/slots');
const { spliceChildren } = require('../lib/ooxml');

const fill = (pattern, n) => pattern.replace('{n}', String(n));

/** slot name -> the shape that holds it, paired with what it should be called. */
function plan(slideXml, blueprint) {
  const found = slots.locate(slideXml, blueprint, { ignoreNames: true });
  const wanted = [];

  for (const [name, slot] of Object.entries(blueprint.contract)) {
    const layout = blueprint.layout.slots[name];

    if (slot.kind !== 'repeat') {
      const shape = found.single[name];
      if (shape && layout.find.byName) wanted.push({ shape, name: layout.find.byName });
      continue;
    }
    if (layout.table) {
      if (layout.table.find.byName) wanted.push({ shape: found.repeats[name].table, name: layout.table.find.byName });
      continue;
    }
    const { items, connectors } = found.repeats[name];
    items.forEach((position, i) => {
      for (const child of Object.keys(slot.slots)) {
        const pattern = layout.slots[child].find.byName;
        if (position[child] && pattern) wanted.push({ shape: position[child], name: fill(pattern, i + 1) });
      }
    });
    const pattern = layout.connectors?.find?.byName;
    if (pattern) {
      connectors.forEach((shape, i) => wanted.push({ shape, name: fill(pattern, i + 1) }));
    }
  }

  const clashes = wanted.map((w) => w.name).filter((n, i, all) => all.indexOf(n) !== i);
  if (clashes.length) throw new Error(`the card would give two shapes the same name: ${[...new Set(clashes)].join(', ')}`);
  return wanted;
}

/**
 * Rewrite the shape's own `<p:cNvPr name="…">`, which is always its first one.
 *
 * The rewrite is scoped to that one tag rather than done with a loose search
 * for `name="`, because another attribute can legally contain that text: a
 * single-quoted `descr='… name="x" …'` would otherwise be corrupted while the
 * real name was left alone, and the tool would report the same rename forever
 * without ever converging. `card.js` refuses a byName carrying XML-special
 * characters, so the value can be written literally.
 */
function rename(shapeXml, to) {
  const tag = /<p:cNvPr\b[^>]*>/.exec(shapeXml);
  if (!tag) throw new Error('shape has no <p:cNvPr> to name');

  const rewritten = /\bname="[^"]*"/.test(tag[0])
    ? tag[0].replace(/\bname="[^"]*"/, `name="${to}"`)
    : tag[0].replace(/^<p:cNvPr\b/, `<p:cNvPr name="${to}"`);

  return shapeXml.slice(0, tag.index) + rewritten + shapeXml.slice(tag.index + tag[0].length);
}

async function main() {
  const args = process.argv.slice(2);
  const write = args.includes('--write');
  const id = args.find((a) => !a.startsWith('--')) || 'company-overview';

  const blueprint = card.load(id);
  const zip = await JSZip.loadAsync(fs.readFileSync(blueprint.pptxPath));
  const slideXml = await zip.file(blueprint.parts.slide).async('string');

  const wanted = plan(slideXml, blueprint);
  const edits = [];
  let changed = 0;

  for (const { shape, name } of wanted) {
    const already = shape.name === name;
    if (!already && rename(shape.xml, name) === shape.xml) {
      throw new Error(`cannot name ${shape.tag} "${shape.name}" as ${name} — the rewrite made no change`);
    }
    if (!already) changed++;
    console.log(`  ${already ? '=' : '→'} ${String(shape.name).padEnd(30)} ${name}`);
    if (!already) edits.push({ start: shape.start, end: shape.end, replacement: rename(shape.xml, name) });
  }

  console.log(`\n${wanted.length} slots, ${changed} to rename`);
  if (!changed) return console.log('nothing to do — the template is already named for its card');
  if (!write) return console.log('dry run; pass --write to apply');

  zip.file(blueprint.parts.slide, spliceChildren(slideXml, edits));
  const buffer = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 9 } });
  fs.writeFileSync(blueprint.pptxPath, buffer);
  console.log(`written ${path.relative(process.cwd(), blueprint.pptxPath)}  ${(buffer.length / 1024).toFixed(0)} KB`);
}

if (require.main === module) main().catch((e) => { console.error(`\n${e.message}\n`); process.exit(1); });

module.exports = { plan, rename };
