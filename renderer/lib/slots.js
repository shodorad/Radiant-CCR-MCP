/**
 * Find a card's slots inside a slide part.
 *
 * Two strategies:
 *
 *   byName — the PowerPoint shape name, the thing in the Selection Pane. This
 *            is the one to use. It is stable under re-layout, it is readable in
 *            the .pptx by a designer who has never seen this repository, and a
 *            card that locates by name says out loud what it is looking for.
 *
 *   else   — vertical-band geometry: "the shape whose top edge sits 5.032 in
 *            down the slide". This is for a template that arrives from
 *            elsewhere and cannot be renamed, and its card simply omits
 *            `byName`. It is also what `name-slots.js` reads in order to
 *            *apply* the names in the first place, which is why slide 4's
 *            geometry is written down exactly once, in the card, and never
 *            twice.
 *
 * A card that asks for a name and does not get it is an **error**, not a quiet
 * demotion to geometry. Falling back silently was the worst of both: the output
 * stayed correct, so nothing complained, and nobody could tell whether the
 * mechanism the card is built around was working at all. A typo in a card, or a
 * template re-extracted from the source deck under the exporter's own duplicate
 * names, would degrade to geometry permanently and invisibly.
 *
 * The renderer used to do only geometry, hard-coded, with slide 4's seven bands
 * as constants. Both strategies now come out of the card, and this file knows
 * nothing about any particular slide.
 */
const { EMU_PER_INCH, childElements, shapeFrame, shapeName, hasPlaceholder } = require('./ooxml');

/** Shapes that could hold a slot. The group's own properties never do. */
const CONTAINERS = new Set(['p:nvGrpSpPr', 'p:grpSpPr']);

function shapesIn(slideXml) {
  return childElements(slideXml, 'p:spTree')
    .filter((c) => !CONTAINERS.has(c.tag))
    .map((c) => ({ ...c, frame: shapeFrame(c.xml), name: shapeName(c.xml) }));
}

const byX = (a, b) => (a.frame?.x ?? 0) - (b.frame?.x ?? 0);

const RENAME_HINT = 'run "node template/name-slots.js <card> --write" to name the template for its card';

/** Shapes matching a geometry locator, left to right. */
function byGeometry(shapes, locator, toleranceEmu) {
  if (!locator) return [];
  const tagged = locator.tag ? shapes.filter((s) => s.tag === locator.tag) : shapes;

  if (locator.placeholder) return tagged.filter((s) => hasPlaceholder(s.xml));

  if (Number.isFinite(locator.bandIn)) {
    const band = locator.bandIn * EMU_PER_INCH;
    return tagged.filter((s) => s.frame && Math.abs(s.frame.y - band) < toleranceEmu).sort(byX);
  }
  return [];
}

/**
 * One shape for one slot.
 *
 * Two shapes matching is an error either way round. On the source deck three
 * different pillars shared the name "Google Shape;185;p30", and picking one of
 * them at random is exactly the kind of quiet wrongness that shows up in front
 * of a client. The same is true of an ambiguous band.
 *
 * @returns {{shape: object|null, via: string}}
 */
function findOne(shapes, find, toleranceEmu, where, ignoreNames) {
  if (find.byName && !ignoreNames) {
    const named = shapes.filter((s) => s.name === find.byName);
    if (named.length === 1) return { shape: named[0], via: 'name' };
    if (named.length > 1) {
      throw new Error(`template has changed: ${named.length} shapes are named "${find.byName}" (${where})`);
    }
    throw new Error(`template has changed: no shape is named "${find.byName}" (${where}) — ${RENAME_HINT}`);
  }
  const found = byGeometry(shapes, find.else, toleranceEmu);
  if (found.length > 1) {
    throw new Error(`template has changed: ${found.length} shapes sit in the band for ${where}`);
  }
  return { shape: found[0] || null, via: 'geometry' };
}

/**
 * The shapes of one repeating slot, in order.
 *
 * With names, order is the {n} in the name. With geometry it is left-to-right,
 * which is the only ordering the artwork itself expresses.
 *
 * @returns {{shapes: Array, via: string}}
 */
function findMany(shapes, find, count, toleranceEmu, where, ignoreNames) {
  if (find.byName && !ignoreNames) {
    const named = [];
    for (let n = 1; n <= count; n++) {
      const want = find.byName.replace('{n}', String(n));
      const matches = shapes.filter((s) => s.name === want);
      if (matches.length > 1) {
        throw new Error(`template has changed: ${matches.length} shapes are named "${want}" (${where})`);
      }
      named.push(matches[0] || null);
    }
    const present = named.filter(Boolean).length;
    if (present === count) return { shapes: named, via: 'name' };
    throw new Error(
      `template has changed: ${where} is named for ${present} of ${count} positions — ${RENAME_HINT}, ` +
      'or drop byName from the card to locate by geometry instead.'
    );
  }
  return { shapes: byGeometry(shapes, find.else, toleranceEmu), via: 'geometry' };
}

/**
 * Resolve every slot the card declares.
 *
 * `ignoreNames` forces the geometry fallback. It is how `name-slots.js` works
 * out which shape deserves which name, and how the test suite proves the two
 * strategies agree on the same template rather than merely both running.
 *
 * Repeating slots are keyed by their own name rather than flattened into one
 * list. A card with two repeating rows used to pile both into a single array
 * and then be filled twice over, which produced overlapping edits and a
 * structurally broken package that nothing complained about.
 *
 * @returns {{single: Object, repeats: Object, via: Object}}
 *          `via` records which strategy resolved each slot, so a test can prove
 *          the shipped card really is locating by name.
 */
function locate(slideXml, card, { ignoreNames = false } = {}) {
  const shapes = shapesIn(slideXml);
  const tolerance = (card.layout.bandToleranceIn ?? 0.1) * EMU_PER_INCH;

  const single = {};
  const repeats = {};
  const via = {};

  for (const [name, slot] of Object.entries(card.contract)) {
    const layout = card.layout.slots[name];

    if (slot.kind !== 'repeat') {
      // Every slot the *layout* declares must be in the .pptx. This used to
      // depend on the contract's `required`, which is a statement about the
      // record — two different questions sharing one key, and a card author who
      // read the contract half would have declared a content requirement they
      // had not. A layout entry pointing at no shape is a card bug either way.
      const found = findOne(shapes, layout.find, tolerance, `slot "${name}"`, ignoreNames);
      if (!found.shape) {
        throw new Error(`template has changed: could not find the shape for slot "${name}"`);
      }
      single[name] = found.shape;
      via[name] = found.via;
      continue;
    }

    // A repeating slot held in a table is one shape, whose rows are the items.
    if (layout.table) {
      const found = findOne(shapes, layout.table.find, tolerance, `slot "${name}"`, ignoreNames);
      if (!found.shape || found.shape.tag !== 'p:graphicFrame') {
        throw new Error(`template has changed: could not find the table for slot "${name}"`);
      }
      const rows = (found.shape.xml.match(/<a:tr\b/g) || []).length;
      if (rows !== slot.max) {
        throw new Error(`template has changed: the table for slot "${name}" has ${rows} rows, and the card says it holds ${slot.max}`);
      }
      repeats[name] = { table: found.shape, items: [], connectors: [] };
      via[name] = found.via;
      continue;
    }

    // A repeating slot is a row of groups: the icon, name and description of
    // position 1, then of position 2, and so on. Each child slot is located
    // independently and then zipped by position, because the artwork gives no
    // grouping of its own — the columns are three separate rows of shapes.
    const columns = {};
    for (const child of Object.keys(slot.slots)) {
      const found = findMany(
        shapes, layout.slots[child].find, slot.max, tolerance, `slot "${name}.${child}"`, ignoreNames
      );
      columns[child] = found.shapes;
      via[`${name}.${child}`] = found.via;
    }
    const counts = Object.values(columns).map((c) => c.length);
    if (counts.some((c) => c !== slot.max)) {
      throw new Error(
        `template has changed: slot "${name}" should have ${slot.max} positions, ` +
        `found ${counts.join('/')} for ${Object.keys(columns).join('/')}`
      );
    }

    const items = [];
    for (let i = 0; i < slot.max; i++) {
      items.push(Object.fromEntries(Object.keys(columns).map((child) => [child, columns[child][i]])));
    }

    let connectors = [];
    if (layout.connectors) {
      const found = findMany(
        shapes, layout.connectors.find, slot.max - 1, tolerance, `slot "${name}" connectors`, ignoreNames
      );
      connectors = found.shapes;
      via[`${name}.connectors`] = found.via;
    }
    repeats[name] = { items, connectors };
  }

  return { single, repeats, via };
}

module.exports = { locate, shapesIn, byGeometry, findOne, findMany };
