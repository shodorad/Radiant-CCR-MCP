/**
 * Minimal TrueType metrics reader.
 *
 * The renderer needs to answer one question before it writes a PPTX: will this
 * text fit the box the brand template gives it? Character counts alone cannot
 * say — "Product Development" and "mmmmmmmmmmmmmmmmmmm" are the same length and
 * very different widths. So we read real advance widths out of the Raleway
 * files the deck actually specifies, and wrap text the way PowerPoint will.
 *
 * Only the four tables needed for advance widths are parsed: head (unitsPerEm),
 * hhea (numberOfHMetrics), hmtx (advances), cmap format 4 (unicode -> glyph).
 * No shaping, no kerning, no ligatures — accurate to a percent or so, which is
 * the right precision for a fit check with a safety margin.
 */
const fs = require('fs');
const path = require('path');

const FONT_DIRS = [
  path.join(process.env.HOME || '', 'Library/Fonts'),
  '/Library/Fonts',
  '/System/Library/Fonts/Supplemental',
  path.resolve(__dirname, '../template/fonts'),
];

/**
 * `weight` is the family member the template's ordinary text is set in —
 * slide 24 is Raleway Medium, slide 4 is Raleway Regular. Measuring Medium as
 * Regular under-reads by about 1.7%, which a safety margin would hide rather
 * than fix, so a card can name its weight and get the file that matches.
 *
 * Bold wins over weight: a run marked b="1" is the family's Bold, whatever the
 * surrounding text is set in.
 */
function fontFileNames(family, bold, weight) {
  if (bold) return [`${family}-Bold.ttf`, `${family}bd.ttf`];
  return [`${family}-${weight || 'Regular'}.ttf`, ...(weight ? [] : [`${family}.ttf`])];
}

function findFontFile(family, bold, weight) {
  for (const dir of FONT_DIRS) {
    for (const name of fontFileNames(family, bold, weight)) {
      const p = path.join(dir, name);
      if (fs.existsSync(p)) return p;
    }
  }
  return null;
}

function parseTTF(buf) {
  const tables = {};
  const numTables = buf.readUInt16BE(4);
  for (let i = 0; i < numTables; i++) {
    const off = 12 + i * 16;
    tables[buf.toString('latin1', off, off + 4)] = {
      offset: buf.readUInt32BE(off + 8),
      length: buf.readUInt32BE(off + 12),
    };
  }
  if (!tables.head || !tables.hhea || !tables.hmtx || !tables.cmap) {
    throw new Error('font is missing a table required for metrics');
  }

  const unitsPerEm = buf.readUInt16BE(tables.head.offset + 18);
  const numberOfHMetrics = buf.readUInt16BE(tables.hhea.offset + 34);

  // hmtx: numberOfHMetrics longHorMetric records, then monospaced tail.
  const advance = (glyphId) => {
    const i = Math.min(glyphId, numberOfHMetrics - 1);
    return buf.readUInt16BE(tables.hmtx.offset + i * 4);
  };

  // cmap: prefer a unicode format-4 subtable.
  const cmapOff = tables.cmap.offset;
  const nSub = buf.readUInt16BE(cmapOff + 2);
  let fmt4 = null;
  for (let i = 0; i < nSub; i++) {
    const rec = cmapOff + 4 + i * 8;
    const platform = buf.readUInt16BE(rec);
    const encoding = buf.readUInt16BE(rec + 2);
    const sub = cmapOff + buf.readUInt32BE(rec + 4);
    if (buf.readUInt16BE(sub) === 4 && (platform === 3 || platform === 0) && encoding !== 5) fmt4 = sub;
  }
  if (fmt4 === null) throw new Error('font has no format-4 unicode cmap');

  const segCountX2 = buf.readUInt16BE(fmt4 + 6);
  const segCount = segCountX2 / 2;
  const endO = fmt4 + 14;
  const startO = endO + segCountX2 + 2;
  const deltaO = startO + segCountX2;
  const rangeO = deltaO + segCountX2;

  const glyphFor = (code) => {
    for (let s = 0; s < segCount; s++) {
      if (buf.readUInt16BE(endO + s * 2) < code) continue;
      const start = buf.readUInt16BE(startO + s * 2);
      if (start > code) return 0;
      const delta = buf.readInt16BE(deltaO + s * 2);
      const rangeOffset = buf.readUInt16BE(rangeO + s * 2);
      if (rangeOffset === 0) return (code + delta) & 0xffff;
      const gi = rangeO + s * 2 + rangeOffset + (code - start) * 2;
      if (gi + 1 >= buf.length) return 0;
      const g = buf.readUInt16BE(gi);
      return g === 0 ? 0 : (g + delta) & 0xffff;
    }
    return 0;
  };

  const cache = new Map();
  return {
    unitsPerEm,
    /** Advance width of one character, in em units (1.0 = one em). */
    charWidth(ch) {
      if (cache.has(ch)) return cache.get(ch);
      const w = advance(glyphFor(ch.codePointAt(0))) / unitsPerEm;
      cache.set(ch, w);
      return w;
    },
  };
}

const loaded = new Map();
function metrics(family, bold, weight) {
  const key = `${family}|${weight || 'Regular'}|${bold ? 'b' : 'r'}`;
  if (loaded.has(key)) return loaded.get(key);
  const file = findFontFile(family, bold, weight);
  let m = null;
  if (file) {
    try {
      m = parseTTF(fs.readFileSync(file));
    } catch {
      m = null;
    }
  }
  loaded.set(key, m);
  return m;
}

/** Width of `text` in points at `sizePt`. Null when the font is unavailable. */
function textWidthPt(text, { family = 'Raleway', bold = false, weight, sizePt }) {
  const m = metrics(family, bold, weight);
  if (!m) return null;
  let w = 0;
  for (const ch of text) w += m.charWidth(ch);
  return w * sizePt;
}

/**
 * Greedy line-break at word boundaries, the way a PowerPoint text box wraps.
 * Returns the resulting lines, or null when metrics are unavailable.
 */
function wrap(text, { family = 'Raleway', bold = false, weight, sizePt, widthPt }) {
  const m = metrics(family, bold, weight);
  if (!m) return null;
  const lines = [];
  for (const paragraph of String(text).split('\n')) {
    let line = '';
    for (const word of paragraph.split(/\s+/).filter(Boolean)) {
      const candidate = line ? `${line} ${word}` : word;
      if (textWidthPt(candidate, { family, bold, weight, sizePt }) <= widthPt || !line) {
        line = candidate;
      } else {
        lines.push(line);
        line = word;
      }
    }
    lines.push(line);
  }
  return lines;
}

const available = (family, weight) => Boolean(metrics(family, false, weight));

module.exports = { textWidthPt, wrap, available, fontFileNames };
