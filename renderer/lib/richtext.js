/**
 * The CCR stores a deliberately tiny subset of HTML: text, <strong>, <em>, and
 * paragraph/line breaks. Nothing else survives the Drupal text format, so
 * nothing else has to survive here.
 *
 * Emphasis is stored as *meaning*, not as styling — CLAUDE.md §8 decision 1.
 * <strong> and <em> both say "this is the emphasised part"; which visual
 * treatment that earns is the channel's business. On the slide, emphasis in the
 * positioning statement is bold white and emphasis in a pillar description is
 * bold Radiant green. On the web it is a <strong>. The marketer marks emphasis
 * once and never thinks about it again, which is what H4 needs.
 */

const ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  rsquo: '’', lsquo: '‘', ldquo: '“', rdquo: '”',
  ndash: '–', mdash: '—', hellip: '…',
};

function decodeEntities(s) {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&([a-z]+);/gi, (m, name) => ENTITIES[name.toLowerCase()] ?? m);
}

const EMPHASIS = new Set(['strong', 'b', 'em', 'i']);
const BREAK = new Set(['br']);
const PARAGRAPH = new Set(['p', 'div']);

/**
 * Parse constrained HTML into paragraphs of runs.
 * @returns {Array<Array<{text: string, emphasis: boolean}>>}
 */
function parse(html) {
  if (html == null) return [[]];
  const paragraphs = [];
  let runs = [];
  let depth = 0;

  const pushText = (raw) => {
    const text = decodeEntities(raw);
    if (!text) return;
    const last = runs[runs.length - 1];
    if (last && last.emphasis === depth > 0) last.text += text;
    else runs.push({ text, emphasis: depth > 0 });
  };
  const endParagraph = () => {
    paragraphs.push(runs);
    runs = [];
  };

  const tokens = String(html).split(/(<[^>]+>)/);
  for (const token of tokens) {
    if (!token) continue;
    if (token[0] !== '<') {
      pushText(token);
      continue;
    }
    const m = /^<\s*(\/?)\s*([a-z0-9]+)/i.exec(token);
    if (!m) continue;
    const closing = m[1] === '/';
    const tag = m[2].toLowerCase();

    if (EMPHASIS.has(tag)) depth = closing ? Math.max(0, depth - 1) : depth + 1;
    else if (BREAK.has(tag)) endParagraph();
    else if (PARAGRAPH.has(tag) && closing) endParagraph();
    // every other tag is dropped, its text kept
  }
  endParagraph();

  // Collapse runs of whitespace the way HTML does, then drop empty paragraphs
  // at the ends (a trailing </p> should not add a blank line to the slide).
  const cleaned = paragraphs.map((p) => {
    const collapsed = p
      .map((r) => ({ ...r, text: r.text.replace(/\s+/g, ' ') }))
      .filter((r) => r.text !== '');
    if (collapsed.length) {
      collapsed[0].text = collapsed[0].text.replace(/^ /, '');
      collapsed[collapsed.length - 1].text = collapsed[collapsed.length - 1].text.replace(/ $/, '');
    }
    return collapsed.filter((r) => r.text !== '');
  });
  while (cleaned.length > 1 && cleaned[cleaned.length - 1].length === 0) cleaned.pop();
  while (cleaned.length > 1 && cleaned[0].length === 0) cleaned.shift();
  return cleaned.length ? cleaned : [[]];
}

/** The text with all markup removed — what a character limit counts. */
function toPlain(html) {
  return parse(html).map((p) => p.map((r) => r.text).join('')).join('\n');
}

const escapeHtml = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/**
 * Runs back into the markup the CCR stores — the inverse of `parse`, and just
 * as narrow. Text and <strong>; nothing else can come out, whatever went in.
 *
 * It exists for text this renderer did not get from the CCR: a language model's
 * suggestion is parsed and written back out through here, so the only thing it
 * can hand a marketer is what the `ccr_inline` format would have let them type.
 */
function serialise(paragraphs) {
  return paragraphs
    .map((runs) => runs.map((r) => (r.emphasis ? `<strong>${escapeHtml(r.text)}</strong>` : escapeHtml(r.text))).join(''))
    .join('<br>');
}

module.exports = { parse, toPlain, serialise, decodeEntities };
