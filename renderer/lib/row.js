/**
 * Where the items of a repeating slot sit.
 *
 * A repeating row is a pitch, a centre and an axis. The renderer keeps the
 * template's own pitch and re-centres the row as items are added or removed, so
 * three of five sit under the middle of the slide rather than clinging to the
 * left. That is the only geometry rendering needs to know, and it is the same
 * for every template — which is why it lives here rather than in render.js,
 * where slide 4's 2.5665 in used to be a constant.
 *
 * **The axis, and why it is declared but half-implemented.**
 *
 * `row` used to carry `pitchIn` and `centreIn` with no axis at all, and the
 * mover only moved x — so a card describing a stacked row would have been
 * accepted and then silently laid out sideways. Phase 1's review recorded that;
 * it is fixed here by making the axis a thing a card has to say.
 *
 * `y` is refused by name rather than implemented. No template in this library
 * has a vertical row — the source deck's only stacked list is non-uniform — so
 * a vertical mover would be code with no caller and no test, which is the same
 * untested generality this phase declined to ship for slot cloning. The model
 * stops lying without anything unexercised being added to it. Write the mover
 * when a template needs one; the refusal below names the moment.
 */
const { EMU_PER_INCH, setShapeX } = require('./ooxml');

const AXES = new Set(['x', 'y']);

const UNIMPLEMENTED =
  'vertical rows are not implemented; no shipped template needs one. ' +
  'Add a y mover beside setShapeX in lib/ooxml.js and teach row.place() to use it.';

/** Called at card-load time, so an unusable axis is refused before rendering. */
function assertSupported(axis) {
  if (axis === 'y') throw new Error(UNIMPLEMENTED);
  if (!AXES.has(axis)) throw new Error(`unknown row axis "${axis}"; expected "x" or "y"`);
}

/** Does this row get re-centred at all, or are the drawn positions kept? */
const recentres = (row) => row.recentre !== false;

/**
 * Centres for `n` items, keeping the template's own pitch and centring.
 * Bit-identical to the columnCentres this replaced.
 */
function centres(n, row) {
  const centre = row.centreIn * EMU_PER_INCH;
  const pitch = row.pitchIn * EMU_PER_INCH;
  return Array.from({ length: n }, (_, i) => centre + (i - (n - 1) / 2) * pitch);
}

/** Move a shape so its own centre lands on `centre`, along the row's axis. */
function place(shapeXml, row, centre, frame) {
  assertSupported(row.axis || 'x');
  return setShapeX(shapeXml, centre - frame.cx / 2);
}

/**
 * How far this card's declared geometry is from where the artwork actually is.
 *
 * A card whose `pitchIn` or `centreIn` is wrong still renders — every shape is
 * simply moved to the wrong place, consistently, and the deck looks subtly off
 * rather than broken. Measuring the displacement is the only way to see it, so
 * `renderer/test.js` pins it for the shipped cards.
 *
 * @param {Array<{frame: object}>} shapes  a sub-row, in order
 * @returns {number} the largest distance any shape would move, in inches
 */
function snapDisplacementIn(shapes, row) {
  if (!recentres(row) || !shapes.length) return 0;
  const wanted = centres(shapes.length, row);
  return Math.max(
    ...shapes.map((s, i) => Math.abs((s.frame.x + s.frame.cx / 2) - wanted[i]) / EMU_PER_INCH)
  );
}

module.exports = { AXES, assertSupported, recentres, centres, place, snapDisplacementIn };
