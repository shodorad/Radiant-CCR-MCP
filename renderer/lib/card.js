/**
 * A blueprint card is what a template knows about itself.
 *
 * Before this existed, `render.js` knew slide 4 by heart: which vertical band
 * each field sat in, how wide its box was, that there were exactly five pillar
 * slots, that the icon row's pitch was 2.5665 in. All of that is a property of
 * one piece of artwork, and none of it is a property of rendering. A second
 * template could not be added without editing the renderer, which is the same
 * failure the CCR exists to fix one level up: the channel's shape leaking into
 * something that is supposed to be channel-neutral.
 *
 * So each `.pptx` now ships beside a `<id>.card.json` with two halves:
 *
 *   contract — what content this template will accept. Named slots, their kind,
 *              how many of a repeating slot, the character and line limits, and
 *              whether emphasis is carried. This is the half a *record* is
 *              matched against, and the half phase 3's template library reads.
 *
 *   layout   — how to find each slot inside the .pptx, and the geometry needed
 *              to place it. This is the half only the renderer reads.
 *
 * The split matters: a marketer's "will this fit?" is a contract question and
 * needs no PowerPoint knowledge, while "where is the shape?" is a layout
 * question and needs nothing about content.
 *
 * Nothing here is brand-specific *source*. The colours, fonts and dimensions
 * are data that ships with the artwork it describes, which is the same reason
 * the renderer copies run properties out of the slide rather than writing them.
 */
const fs = require('fs');
const path = require('path');
const row = require('./row');

const TEMPLATE_DIR = path.resolve(__dirname, '../template');

/**
 * The template the POC ships. Phase 3 turns the directory into a library and
 * this becomes "the one a record is offered first", not "the only one".
 */
const DEFAULT_ID = 'company-overview';

/** Slot kinds a card may declare. `repeat` is a group of slots, n times over. */
const KINDS = new Set(['text', 'icon', 'repeat']);

/** Names that end up as XML attribute values must survive the round trip. */
const XML_UNSAFE = /[<>&"']/;

const fail = (id, message) => {
  throw new Error(`blueprint card "${id}" is not usable: ${message}`);
};

const number = (id, where, what, v) => {
  if (!Number.isFinite(v) || v <= 0) fail(id, `${where} has a nonsensical ${what}`);
};

/**
 * A locator must be usable. `byName` becomes an XML attribute value, and
 * `shapeName()` reads that attribute raw — so a name carrying `&` would be
 * written escaped and never match itself again, which shows up as a permanent,
 * silent demotion to the geometry fallback.
 */
function validateFind(id, where, find) {
  if (!find || typeof find !== 'object') fail(id, `${where} has no find rule`);
  if (find.byName !== undefined) {
    if (typeof find.byName !== 'string' || !find.byName) fail(id, `${where} has an empty byName`);
    if (XML_UNSAFE.test(find.byName)) fail(id, `${where} byName "${find.byName}" contains a character XML cannot carry in a name`);
  }
  if (!find.byName && !find.else) fail(id, `${where} has neither a byName nor a geometry fallback`);
  if (find.else && !find.else.placeholder && !Number.isFinite(find.else.bandIn)) {
    fail(id, `${where} has a geometry fallback that is neither a placeholder nor a band`);
  }
}

function validateBox(id, where, box) {
  if (!box) fail(id, `${where} is text but the layout gives it no box to fit in`);
  number(id, where, 'box widthIn', box.widthIn);
  number(id, where, 'box sizePt', box.sizePt);
  if (typeof box.bold !== 'boolean') fail(id, `${where} box must say whether its type is bold`);
}

function validateTextSlot(id, where, slot) {
  if (typeof slot.source !== 'string' || !slot.source) fail(id, `${where} has no source field`);
  if (typeof slot.label !== 'string' || !slot.label) fail(id, `${where} has no label`);
  number(id, where, 'maxChars', slot.maxChars);
  number(id, where, 'maxLines', slot.maxLines);
  if (typeof slot.emphasis !== 'boolean') fail(id, `${where} must say whether it carries emphasis`);
  // How many paragraphs the box takes. Absent means one: every slot before
  // slide 19 was a single line or sentence.
  if (slot.paragraphs !== undefined && !(Number.isInteger(slot.paragraphs) && slot.paragraphs >= 1)) {
    fail(id, `${where} paragraphs must be a whole number of at least 1`);
  }
}

/**
 * A written template's text slots are filled from copy a model drafts and a
 * person approves, not from the record directly — so each one has to say what
 * belongs in it. The brief is contract data, like the limits beside it: it is
 * what this piece of artwork asks for, and it travels with the artwork.
 */
function validateBrief(card, where, slot) {
  if (!card.written) return;
  if (typeof slot.brief !== 'string' || !slot.brief.trim()) {
    fail(card.id || '(unnamed)', `${where} is on a written template but has no brief saying what to write`);
  }
}

/**
 * Check a card says enough to render from, and that its two halves agree.
 *
 * The checks that earn their place are the ones whose failure mode is silence
 * rather than a crash. A slot named in `contract` with no entry in `layout`
 * renders as nothing at all — the field simply never appears on the slide and
 * nothing complains. So does a slot the layout cannot find that never said it
 * was required, which is why `required` defaults to true here rather than to
 * false: a card author who forgets the key gets an error, not a blank box.
 */
function validate(card) {
  const id = card.id || '(unnamed)';
  // The count refusal quotes card.name back to the marketer; a card without one
  // tells them the template "undefined" cannot hold their content.
  if (typeof card.name !== 'string' || !card.name) fail(id, 'no human-readable name');
  if (!card.pptx) fail(id, 'no pptx named');
  if (!card.parts?.slide) fail(id, 'no slide part named');
  if (!card.parts?.rels) fail(id, 'no slide relationships part named');
  if (!card.parts?.presentation) fail(id, 'no presentation part named, so the slide width cannot be read');
  if (!card.contract || !card.layout?.slots) fail(id, 'a card needs both a contract and a layout');
  // Which kind of record this template draws on. Optional: a card that does not
  // say is offered to any record, which is how every card behaved before a
  // second content type existed.
  if (card.record !== undefined && (typeof card.record !== 'string' || !card.record)) fail(id, 'record must name a content type');
  if (card.written !== undefined && typeof card.written !== 'boolean') fail(id, 'written must be true or false');
  if (card.written && !card.record) fail(id, 'a written template must say which kind of record its copy is written from');
  if (card.placeholderArt !== undefined && (typeof card.placeholderArt !== 'string' || !card.placeholderArt)) {
    fail(id, 'placeholderArt must be a sentence saying which artwork is standing in');
  }
  if (!card.layout.font?.family) fail(id, 'the layout must name the font its boxes are measured in');
  if (card.layout.font.widthSafety !== undefined) number(id, 'the layout font', 'widthSafety', card.layout.font.widthSafety);
  // The family member the template's ordinary text is set in. Optional, because
  // most templates are Regular; named when they are not, so the fit check reads
  // the file the artwork actually uses rather than one about 2% narrower.
  if (card.layout.font.weight !== undefined && (typeof card.layout.font.weight !== 'string' || !card.layout.font.weight)) {
    fail(id, 'the layout font has an empty weight');
  }

  for (const [name, slot] of Object.entries(card.contract)) {
    const where = `slot "${name}"`;
    if (!KINDS.has(slot.kind)) fail(id, `${where} has an unknown kind "${slot.kind}"`);
    const layout = card.layout.slots[name];
    if (!layout) fail(id, `${where} is in the contract but the layout cannot find it`);

    if (slot.kind === 'repeat') {
      if (typeof slot.source !== 'string' || !slot.source) fail(id, `${where} has no source field`);
      if (typeof slot.labelPattern !== 'string' || !slot.labelPattern) fail(id, `${where} has no labelPattern`);
      if (!(slot.min >= 1) || !(slot.max >= slot.min)) fail(id, `${where} has a nonsensical min/max`);
      if (!slot.slots || !Object.keys(slot.slots).length) fail(id, `${where} is repeating but has no slots`);

      // A table: one shape whose rows are the items, one column filled per row.
      if (layout.table) {
        validateFind(id, `${where} table`, layout.table.find);
        if (!Number.isInteger(layout.table.col) || layout.table.col < 0) fail(id, `${where} table has a nonsensical col`);
        const children = Object.entries(slot.slots);
        if (children.length !== 1 || children[0][1].kind !== 'text') {
          fail(id, `${where} is a table, which fills exactly one text column`);
        }
        const [child, childSlot] = children[0];
        validateTextSlot(id, `slot "${name}.${child}"`, childSlot);
        validateBox(id, `slot "${name}.${child}"`, layout.slots?.[child]?.box);
        validateBrief(card, `slot "${name}.${child}"`, childSlot);
        continue;
      }

      if (!layout.row) fail(id, `${where} has no row geometry`);
      // A row without an axis was a row that only ever moved sideways, so a
      // card describing a stacked row was accepted and then laid out
      // horizontally. Refused here, at load time, rather than at render time.
      try { row.assertSupported(layout.row.axis || 'x'); }
      catch (e) { fail(id, `${where} row: ${e.message}`); }
      if (layout.row.recentre !== false) {
        number(id, where, 'row pitchIn', layout.row.pitchIn);
        if (!Number.isFinite(layout.row.centreIn)) fail(id, `${where} has a nonsensical row centreIn`);
      }
      if (layout.connectors) validateFind(id, `${where} connectors`, layout.connectors.find);

      for (const [child, childSlot] of Object.entries(slot.slots)) {
        const childWhere = `slot "${name}.${child}"`;
        if (!KINDS.has(childSlot.kind) || childSlot.kind === 'repeat') {
          fail(id, `${childWhere} has an unusable kind "${childSlot.kind}"`);
        }
        const childLayout = layout.slots?.[child];
        if (!childLayout) fail(id, `${childWhere} is in the contract but the layout cannot find it`);
        validateFind(id, childWhere, childLayout.find);
        if (childLayout.styleFrom !== undefined
          && !(Number.isInteger(childLayout.styleFrom) && childLayout.styleFrom >= 1 && childLayout.styleFrom <= slot.max)) {
          fail(id, `${childWhere} styleFrom must name a position between 1 and ${slot.max}`);
        }
        if (childSlot.kind === 'text') {
          validateTextSlot(id, childWhere, childSlot);
          validateBox(id, childWhere, childLayout.box);
          validateBrief(card, childWhere, childSlot);
        }
        if (childSlot.kind === 'icon') {
          if (typeof childSlot.source !== 'string' || !childSlot.source) fail(id, `${childWhere} has no source field`);
          // A template with an icon slot and no icon set can resolve no token at
          // all, so every record would be refused at generation time for a
          // reason that is really a hole in the card.
          if (!card.icons) fail(id, `${childWhere} resolves a token but the card names no icon set`);
        }
      }
      continue;
    }

    // An icon outside a repeating row would be located and then never filled:
    // render() only handles text among the slots that appear once. Refuse it
    // rather than accept a card whose icon silently does nothing.
    if (slot.kind === 'icon') fail(id, `${where} is an icon, which is only supported inside a repeating slot`);

    if (slot.required !== undefined && typeof slot.required !== 'boolean') {
      fail(id, `${where} has a non-boolean required`);
    }
    if (slot.required === undefined) slot.required = true;

    validateFind(id, where, layout.find);
    if (slot.kind === 'text') {
      validateTextSlot(id, where, slot);
      validateBox(id, where, layout.box);
      validateBrief(card, where, slot);
    }
    if (layout.keepParagraphs !== undefined && !(Number.isInteger(layout.keepParagraphs) && layout.keepParagraphs >= 0)) {
      fail(id, `${where} keepParagraphs must be a whole number`);
    }
    if (layout.centreOnSlide && !Number.isFinite(layout.centreOnSlide.padIn)) {
      fail(id, `${where} centreOnSlide has a nonsensical padIn`);
    }
  }

  for (const name of Object.keys(card.layout.slots)) {
    if (!card.contract[name]) fail(id, `the layout places "${name}" but the contract never declares it`);
  }
  return card;
}

/**
 * The token vocabulary this template can resolve.
 *
 * Per template, not global. Two templates carrying the same five brand icons
 * point at the same index; a template carrying three has its own, and a record
 * asking for a fourth is refused by name rather than rendered with whatever
 * artwork happened to be in that position.
 */
const iconSets = new Map();
function icons(card) {
  if (!card.iconsPath) return {};
  if (!iconSets.has(card.iconsPath)) {
    let set;
    try {
      set = JSON.parse(fs.readFileSync(card.iconsPath, 'utf8'));
    } catch (e) {
      throw new Error(`blueprint card "${card.id}" names an icon set at ${card.iconsPath} that cannot be read: ${e.message}`);
    }

    // Each icon's own shape, read out of its viewBox. The brand set is square;
    // the frames a designer drew for it are not always, and a square icon
    // stretched into a 0.78 frame is visibly wrong on a client deck. The
    // renderer fits rather than stretches, and this is where it learns the
    // number — from the icon file, not from anybody's estimate.
    const dir = path.dirname(card.iconsPath);
    for (const icon of Object.values(set)) {
      if (!icon.file) continue;
      try {
        const svg = fs.readFileSync(path.join(dir, icon.file), 'utf8').slice(0, 2000);
        const box = /viewBox="\s*[\d.-]+\s+[\d.-]+\s+([\d.]+)\s+([\d.]+)/.exec(svg);
        if (box) icon.aspect = Number(box[1]) / Number(box[2]);
      } catch {
        // No file beside the index is not fatal: the media in the package is
        // what gets drawn. Without an aspect the frame is simply left alone.
      }
    }
    iconSets.set(card.iconsPath, set);
  }
  return iconSets.get(card.iconsPath);
}

/**
 * Load a card by id (`company-overview`) or by path to the .json.
 * Paths inside the card resolve against the card's own directory, so a template
 * and its card travel together.
 */
function load(idOrPath) {
  const file = /[\\/]|\.json$/.test(idOrPath)
    ? path.resolve(idOrPath)
    : path.join(TEMPLATE_DIR, `${idOrPath}.card.json`);

  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    throw new Error(`no blueprint card at ${file}`);
  }

  let card;
  try {
    card = JSON.parse(raw);
  } catch (e) {
    throw new Error(`blueprint card ${file} is not valid JSON: ${e.message}`);
  }

  // Validate before resolving paths. `path.resolve(dir, undefined)` throws a
  // raw TypeError about "paths[1]", which is what a card with no `pptx` used to
  // report instead of the sentence validate() has ready for it.
  validate(card);

  const dir = path.dirname(file);
  card.file = file;
  card.dir = dir;
  card.pptxPath = path.resolve(dir, card.pptx);
  card.iconsPath = card.icons ? path.resolve(dir, card.icons) : null;
  return card;
}

/**
 * Scanning the directory is `lib/registry.js`'s job, not this file's. It used to
 * be a `list()` here that mapped `load` over the directory, which meant one
 * unusable card threw out of the listing and took `/health` with it.
 */
module.exports = { load, validate, icons, TEMPLATE_DIR, DEFAULT_ID };
