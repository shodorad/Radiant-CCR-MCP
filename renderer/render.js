/**
 * CCR POC — a content record  ->  an on-brand Radiant PPTX.
 *
 * Strategy: template-fill (plan.md phase 1, task 1). A template is a byte-for-
 * byte copy of a real Radiant slide. Rendering replaces text runs inside it and
 * leaves everything else alone, so the background photograph, the layout, the
 * connector arrows, the icon artwork and every type spec are the originals
 * rather than a reconstruction. Nothing about the brand is expressed in this
 * file — it is all inherited from the deck.
 *
 * This file used to know one slide by heart: its seven vertical bands, its five
 * pillar slots, the 2.5665 in pitch of its icon row, the width and point size
 * of every box. All of that is a property of one piece of artwork and none of
 * it is a property of rendering, so it now lives in a blueprint card beside the
 * .pptx (`lib/card.js`). What is left here is the part that is true of any
 * template: order the repeating items, refuse a record the contract cannot
 * hold, check what will not fit, fill the shapes, re-centre the row.
 *
 * Adding a template is a .pptx and a .json. It is not a change to this file.
 *
 * Three things the fill has to get right:
 *
 *   Emphasis. Each field's runs carry their own formatting, so new runs are
 *   built by cloning the run properties already present in that shape: the
 *   plain run for ordinary text, the emphasised run for <strong>/<em>. That is
 *   how "insight" comes out bold Radiant green in a pillar description and
 *   "accelerate" comes out bold white in the positioning statement, without the
 *   renderer knowing either colour.
 *
 *   Fit. The boxes are fixed. Text that overflows a pillar name box pushes into
 *   the description below it — the collision visible in slide4.jpg. Every
 *   slide-bound field is measured against real font metrics, and if it cannot
 *   be measured at all the render is refused rather than shipped unchecked.
 *
 *   Icons. A token selects artwork already in the package by rewriting one
 *   relationship target, so the marketer never handles an image.
 */
const fs = require('fs');
const JSZip = require('jszip');
const card = require('./lib/card');
const slots = require('./lib/slots');
const row = require('./lib/row');
const select = require('./lib/select');
const { assemble } = require('./lib/assemble');
const fit = require('./lib/fit');
const richtext = require('./lib/richtext');
const fm = require('./lib/font-metrics');
const { EMU_PER_INCH, escapeXml, spliceChildren, setShapeX, setShapeFrame, shapeFrame } = require('./lib/ooxml');

const DEFAULT_TEMPLATE = card.DEFAULT_ID;

// ---------------------------------------------------------------- text filling

/**
 * Capture the formatting already in a shape so new text can inherit it.
 * `plain` and `emphasis` are whole <a:rPr> elements lifted from the slide.
 *
 * `keep` leaves the shape's first paragraphs as drawn — a heading such as
 * "The Problem" sitting in the same box as the text under it. They are carried
 * over verbatim and the formatting is taken from the paragraphs after them, so
 * the heading's 14 pt bold is never mistaken for the body's emphasis.
 *
 * A table cell's text lives in <a:txBody> rather than <p:txBody>; both are the
 * same structure inside.
 */
function captureStyle(shapeXml, { keep = 0 } = {}) {
  const body = /<([ap]):txBody>([\s\S]*?)<\/\1:txBody>/.exec(shapeXml);
  if (!body) throw new Error('shape has no text body');
  const [, ns, whole] = body;

  const paragraphs = [...whole.matchAll(/<a:p>[\s\S]*?<\/a:p>|<a:p\/>/g)];
  if (paragraphs.length <= keep) {
    throw new Error(`shape has ${paragraphs.length} paragraph(s), so there is nothing after the ${keep} it keeps to take formatting from`);
  }
  const kept = paragraphs.slice(0, keep).map((m) => m[0]).join('');
  const inner = paragraphs.slice(keep).map((m) => m[0]).join('');

  const bodyPr = (/<a:bodyPr(?:\s[^>]*)?(?:\/>|>[\s\S]*?<\/a:bodyPr>)/.exec(whole) || ['<a:bodyPr/>'])[0];
  const lstStyle = (/<a:lstStyle(?:\s[^>]*)?(?:\/>|>[\s\S]*?<\/a:lstStyle>)/.exec(whole) || [''])[0];
  const pPr = (/<a:pPr(?:\s[^>]*)?(?:\/>|>[\s\S]*?<\/a:pPr>)/.exec(inner) || [''])[0];
  const endParaRPr = (/<a:endParaRPr(?:\s[^>]*)?(?:\/>|>[\s\S]*?<\/a:endParaRPr>)/.exec(inner) || [''])[0];

  // `err="1"` is PowerPoint's note that the spell checker flagged that run —
  // "Newfold" on slide 19. It is proofing state, not formatting, and cloning it
  // would underline every word of the new text in red.
  const rPrs = [...inner.matchAll(/<a:r>\s*(<a:rPr(?:\s[^>]*)?(?:\/>|>[\s\S]*?<\/a:rPr>))/g)]
    .map((m) => m[1].replace(/\serr="1"/, ''));
  if (!rPrs.length) throw new Error('shape has no runs to take formatting from');

  // Emphasis is a delta on the shape's base formatting, not an absolute style.
  // Where a shape mixes plain and emphasised runs, both are already on the
  // slide and are taken as they are. Where every run is identical — a pillar
  // name, which is bold throughout by design — that uniform style *is* the base
  // style, and emphasis is derived from it by adding bold. Reading "all runs
  // are bold" as "there is no plain style here" is what silently un-bolds a
  // whole field.
  const isBold = (r) => /\bb="1"/.test(r);
  const bold = rPrs.filter(isBold);
  const notBold = rPrs.filter((r) => !isBold(r));
  // A run that is already bold stays as it is. Prepending b="1" to one that
  // had it produced an <a:rPr> declaring `b` twice — malformed XML, and a
  // repair dialog — the first time a shape whose only run was bold was asked
  // to carry emphasis (slide 19's third result box).
  const addBold = (r) => {
    if (isBold(r)) return r;
    return /\bb="0"/.test(r) ? r.replace(/\bb="0"/, 'b="1"') : r.replace(/^<a:rPr/, '<a:rPr b="1"');
  };

  const mixed = bold.length > 0 && notBold.length > 0;
  const plain = mixed ? notBold[0] : rPrs[0];
  const emphasis = mixed ? bold[0] : addBold(plain);

  return { ns, kept, bodyPr, lstStyle, pPr, endParaRPr, plain, emphasis, start: body.index, end: body.index + body[0].length };
}

/**
 * Rebuild a shape's text body around new content, keeping its formatting.
 *
 * `styleFrom` is another shape's XML to take the formatting from instead — for
 * a row whose positions should look alike but whose artwork drifted. The body
 * that is replaced is always this shape's own.
 */
function fillShape(shapeXml, html, { keep = 0, styleFrom } = {}) {
  const style = captureStyle(shapeXml, { keep });
  if (styleFrom) {
    const other = captureStyle(styleFrom, { keep });
    Object.assign(style, { pPr: other.pPr, endParaRPr: other.endParaRPr, plain: other.plain, emphasis: other.emphasis });
  }
  const paragraphs = richtext.parse(html);

  const xml = paragraphs
    .map((runs) => {
      const body = runs
        .map((run) => `<a:r>${run.emphasis ? style.emphasis : style.plain}<a:t>${escapeXml(run.text)}</a:t></a:r>`)
        .join('');
      return `<a:p>${style.pPr}${body}${style.endParaRPr}</a:p>`;
    })
    .join('');

  const txBody = `<${style.ns}:txBody>${style.bodyPr}${style.lstStyle}${style.kept}${xml}</${style.ns}:txBody>`;
  return shapeXml.slice(0, style.start) + txBody + shapeXml.slice(style.end);
}

/**
 * Fill one column of a table, one row per item, and remove the rows not used.
 *
 * Slide 19 lists its solutions as a table: a name in the first column and a
 * glyph in the second, one row each. The glyph column is artwork and is left as
 * drawn. Each name cell is filled the way a shape is — its own run properties
 * cloned — and rows past the last item are removed, with the frame shortened by
 * exactly their heights so the table does not keep an empty band below it.
 */
function fillTable(frameXml, table, slot, items) {
  const [, childSlot] = Object.entries(slot.slots)[0];
  const rows = [...frameXml.matchAll(/<a:tr\b[^>]*>[\s\S]*?<\/a:tr>/g)];

  let height = 0;
  const edits = rows.map((row, i) => {
    const span = { start: row.index, end: row.index + row[0].length };
    if (i >= items.length) return { ...span, replacement: '' };
    height += Number(/<a:tr\b[^>]*\bh="(\d+)"/.exec(row[0])[1]);
    const cell = [...row[0].matchAll(/<a:tc\b[^>]*>[\s\S]*?<\/a:tc>/g)][table.col];
    const filled = fillShape(cell[0], items[i][childSlot.source]);
    return { ...span, replacement: row[0].slice(0, cell.index) + filled + row[0].slice(cell.index + cell[0].length) };
  });

  const xml = spliceChildren(frameXml, edits);
  const frame = shapeFrame(frameXml);
  return setShapeFrame(xml, { ...frame, cy: height });
}

// ---------------------------------------------------------------------- icons

/** The relationship id of the SVG a `<p:pic>` shows. */
function iconRelId(picXml) {
  const m = /<asvg:svgBlip[^>]*r:embed="([^"]+)"/.exec(picXml);
  return m ? m[1] : null;
}

/**
 * Fit an icon inside the frame the designer drew for it, rather than stretching
 * it to fill one.
 *
 * A `<p:pic>` with `<a:stretch><a:fillRect/></a:stretch>` scales its image to
 * the frame, so a square brand icon dropped into a 0.78 frame comes out 22%
 * narrow. That is not a fit problem the text checks would ever catch — it is
 * simply wrong on the slide, and only visible to someone looking at the deck.
 *
 * Both numbers come from the artwork: the frame from the slide, the aspect from
 * the icon's own viewBox. The picture keeps the centre it was given and shrinks
 * on its long axis; nothing grows past what the designer allowed.
 *
 * A no-op where the frame already matches, which is every icon on slide 4 —
 * they are square and so are the icons.
 *
 * @returns {{xml: string, frame: object}}
 */
function fitIcon(picXml, frame, aspect) {
  if (!aspect || !frame?.cx || !frame?.cy) return { xml: picXml, frame };
  const current = frame.cx / frame.cy;
  if (Math.abs(current - aspect) < 0.005) return { xml: picXml, frame };

  const cx = current > aspect ? Math.round(frame.cy * aspect) : frame.cx;
  const cy = current > aspect ? frame.cy : Math.round(frame.cx / aspect);
  const fitted = {
    x: frame.x + Math.round((frame.cx - cx) / 2),
    y: frame.y + Math.round((frame.cy - cy) / 2),
    cx,
    cy,
  };
  return { xml: setShapeFrame(picXml, fitted), frame: fitted };
}

// ------------------------------------------------------------------ geometry

/**
 * The slide's own width, read out of the package rather than written down.
 * A dimension the renderer holds is a dimension that is wrong for the next
 * template.
 */
async function slideWidthOf(zip, blueprint) {
  const part = blueprint.parts.presentation;
  const file = part && zip.file(part);
  if (!file) throw new Error(`${blueprint.id}: cannot read ${part}, so the slide width is unknown`);
  const m = /<p:sldSz[^>]*\bcx="(\d+)"/.exec(await file.async('string'));
  if (!m) throw new Error(`${blueprint.id}: ${part} declares no slide size`);
  return Number(m[1]);
}

// ------------------------------------------------------------------- records

/**
 * What will not fit, without producing a file. This is what the CCR shows the
 * editor before they press Generate.
 */
function checkRecord(record, { template = DEFAULT_TEMPLATE, selection } = {}) {
  const blueprint = card.load(template);
  return fit.check(record, blueprint, select.rows(record, blueprint, selection));
}

// -------------------------------------------------------------------- render

/**
 * @param {object} record   normalised content record
 * @param {object} options  `template` — a card id, or a path to a .card.json;
 *                          `selection` — slot name -> the item keys this deck
 *                          uses, in order. Selection belongs to the deck, never
 *                          to the record: see lib/select.js.
 * @returns {Promise<{buffer: Buffer, issues: Array, counts: object, template: string}>}
 */
async function renderSlide(record, { template = DEFAULT_TEMPLATE, selection } = {}) {
  const blueprint = card.load(template);
  const rows = select.rows(record, blueprint, selection);

  // The contract is the template's answer to "what will you hold?". A record it
  // cannot hold is refused with the reason, not quietly trimmed — and the same
  // answer is available from `checkRecord` without producing a file, so the CCR
  // can say it before the marketer presses Generate rather than after.
  const issues = fit.check(record, blueprint, rows);
  // On a written template, text that does not fit its box is refused too. A
  // record-driven slide treats the limit as advice (plan.md §7 U2: the slide
  // may not tell the business what to call itself), but copy written *for*
  // this box exists only to fill it, and was approved as fitting.
  const blocked = issues.find((i) => i.blocking || (blueprint.written && i.severity === 'error'));
  if (blocked) throw new Error(blocked.label ? `${blocked.label}: ${blocked.message}` : blocked.message);

  const icons = card.icons(blueprint);
  const zip = await JSZip.loadAsync(fs.readFileSync(blueprint.pptxPath));

  let slideXml = await zip.file(blueprint.parts.slide).async('string');
  let relsXml = await zip.file(blueprint.parts.rels).async('string');
  const slideWidth = await slideWidthOf(zip, blueprint);
  const found = slots.locate(slideXml, blueprint);

  const edits = [];
  const keep = (shape, replacement) => edits.push({ start: shape.start, end: shape.end, replacement });
  const drop = (shape) => edits.push({ start: shape.start, end: shape.end, replacement: '' });

  // ---- the slots that appear once
  for (const [name, slot] of Object.entries(blueprint.contract)) {
    if (slot.kind !== 'text') continue;
    const shape = found.single[name];
    if (!shape) continue;
    const layout = blueprint.layout.slots[name];
    const value = record[slot.source];
    let xml = fillShape(shape.xml, value, { keep: layout.keepParagraphs || 0 });

    // An auto-sized pill has to be re-centred, or a shorter or longer value
    // drifts away from the middle of the slide instead of sitting under it.
    if (layout.centreOnSlide) {
      const widthPt = fm.textWidthPt(richtext.toPlain(value), {
        family: blueprint.layout.font.family,
        bold: layout.box.bold,
        weight: blueprint.layout.font.weight,
        sizePt: layout.box.sizePt,
      });
      const cx = widthPt
        ? widthPt * (EMU_PER_INCH / 72) + layout.centreOnSlide.padIn * EMU_PER_INCH
        : shape.frame.cx;
      xml = setShapeX(xml, (slideWidth - cx) / 2);
    }
    keep(shape, xml);
  }

  // ---- the repeating rows
  const counts = {};
  for (const [name, slot] of Object.entries(blueprint.contract)) {
    if (slot.kind !== 'repeat') continue;
    const items = rows[name];
    const layout = blueprint.layout.slots[name];
    counts[name] = items.length;

    if (layout.table) {
      const table = found.repeats[name].table;
      keep(table, fillTable(table.xml, layout.table, slot, items));
      continue;
    }

    const { items: positions, connectors } = found.repeats[name];

    // A row whose artwork is evenly pitched is re-centred as items are removed,
    // so three of five sit under the middle of the slide rather than clinging
    // to the left. A row that is not uniform — a hero beside three small ones —
    // says `recentre: false` and keeps the positions the designer chose.
    const recentre = row.recentres(layout.row);
    const centres = recentre ? row.centres(items.length, layout.row) : null;
    const place = (shape, xml, i) => (recentre ? row.place(xml, layout.row, centres[i], shape.frame) : xml);

    positions.forEach((position, i) => {
      // Unused positions are removed, not left holding the template's own
      // content. The row is then re-centred at the template's pitch.
      if (i >= items.length) {
        for (const shape of Object.values(position)) drop(shape);
        return;
      }
      const item = items[i];

      for (const [child, childSlot] of Object.entries(slot.slots)) {
        const shape = position[child];
        const value = item[childSlot.source];

        if (childSlot.kind === 'icon') {
          // An unresolvable token is a blocking issue from fit.check(), which
          // has already run above — so by here the token is known and this only
          // has to point the relationship at the right media.
          const rel = iconRelId(shape.xml);
          const icon = icons[value];
          if (rel && icon) {
            relsXml = relsXml.replace(
              new RegExp(`(<Relationship Id="${rel}"[^>]*Target=")[^"]*(")`),
              `$1../media/${icon.media}$2`
            );
          }
          // Fitted before it is placed, so the row centres on where the picture
          // actually ends up rather than on the frame it arrived in.
          const fit = fitIcon(shape.xml, shape.frame, icon?.aspect);
          keep(shape, place({ frame: fit.frame }, fit.xml, i));
          continue;
        }

        // A row's positions are meant to look alike, but the artwork does not
        // always agree: slide 19's third result box was typed as one bold run
        // where the other three are a bold figure and a regular label. The card
        // can name the position whose formatting the whole row should take.
        const styleFrom = layout.slots[child].styleFrom;
        const filled = fillShape(shape.xml, value, {
          styleFrom: styleFrom ? positions[styleFrom - 1][child].xml : undefined,
        });
        keep(shape, place(shape, filled, i));
      }
    });

    // One connector between each surviving pair; the rest are removed.
    connectors.forEach((connector, i) => {
      if (i >= items.length - 1) { drop(connector); return; }
      const xml = recentre
        ? row.place(connector.xml, layout.row, (centres[i] + centres[i + 1]) / 2, connector.frame)
        : connector.xml;
      keep(connector, xml);
    });
  }

  slideXml = spliceChildren(slideXml, edits);
  return { blueprint, slideXml, relsXml, issues, counts, template: blueprint.id, title: record.title };
}

/**
 * One slide, in its own package. This is the original single-template path and
 * it stays byte-identical: the filled slide goes back into a copy of the
 * template it came from, so nothing about the package changes but the text.
 */
async function render(record, options = {}) {
  const slide = await renderSlide(record, options);
  const zip = await JSZip.loadAsync(fs.readFileSync(slide.blueprint.pptxPath));
  zip.file(slide.blueprint.parts.slide, slide.slideXml);
  zip.file(slide.blueprint.parts.rels, slide.relsXml);

  const buffer = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 9 } });
  return { buffer, issues: slide.issues, counts: slide.counts, template: slide.template };
}

/**
 * A deck: an ordered list of (template, record, selection), one slide each.
 *
 * Every entry is rendered and refused on its own terms — a deck whose third
 * slide selects a pillar that no longer exists fails naming the third slide,
 * not the deck. Issues are tagged with the slide they came from for the same
 * reason: "Pillar 2 name is too long" is not useful when there are four slides.
 *
 * @param {Array<{template: string, record: object, selection?: object}>} entries
 * @returns {Promise<{buffer: Buffer, issues: Array, slides: Array}>}
 */
async function renderDeck(entries) {
  if (!Array.isArray(entries) || !entries.length) throw new Error('a deck needs at least one slide');

  const slides = [];
  const issues = [];
  for (const [i, entry] of entries.entries()) {
    const where = `slide ${i + 1}`;
    let slide;
    try {
      slide = await renderSlide(entry.record, { template: entry.template, selection: entry.selection });
    } catch (e) {
      throw new Error(`${where} (${entry.template}): ${e.message}`);
    }
    slides.push(slide);
    issues.push(...slide.issues.map((issue) => ({ ...issue, slide: i + 1, template: slide.template })));
  }

  const buffer = await assemble(slides);
  return {
    buffer,
    issues,
    slides: slides.map((s, i) => ({ slide: i + 1, template: s.template, counts: s.counts })),
  };
}

module.exports = { render, renderSlide, renderDeck, checkRecord, captureStyle, fillShape, DEFAULT_TEMPLATE };
