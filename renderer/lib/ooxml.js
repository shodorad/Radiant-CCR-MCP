/**
 * Small helpers for working on PresentationML as text.
 *
 * The renderer edits a copy of a real PowerPoint slide rather than rebuilding
 * one, so the guiding rule is: touch as few bytes as possible. Everything not
 * explicitly replaced — theme, fills, effects, the extension lists PowerPoint
 * writes for its own use — is carried through byte for byte. A DOM round-trip
 * would rewrite all of it, and that is where brand fidelity quietly dies.
 */

const EMU_PER_INCH = 914400;
const EMU_PER_POINT = 12700;

const escapeXml = (s) =>
  String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

/**
 * Split the children of a container element, tracking depth so that nested
 * elements of the same name do not confuse the scan.
 * @returns {Array<{tag: string, start: number, end: number, xml: string}>}
 */
function childElements(xml, containerTag) {
  const open = new RegExp(`<${containerTag}(?:\\s[^>]*)?>`);
  const m = open.exec(xml);
  if (!m) throw new Error(`<${containerTag}> not found`);
  const bodyStart = m.index + m[0].length;

  const out = [];
  const tagRe = /<(\/?)([a-zA-Z0-9]+:[a-zA-Z0-9]+)(?:\s[^>]*?)?(\/?)>/g;
  tagRe.lastIndex = bodyStart;
  let depth = 0;
  let current = null;
  let t;
  while ((t = tagRe.exec(xml))) {
    const [full, closing, name, selfClosing] = t;
    if (depth === 0 && closing && name === containerTag) break;
    if (closing) {
      depth--;
      if (depth === 0 && current) {
        out.push({ tag: current.tag, start: current.start, end: tagRe.lastIndex, xml: xml.slice(current.start, tagRe.lastIndex) });
        current = null;
      }
      continue;
    }
    if (selfClosing) {
      if (depth === 0) out.push({ tag: name, start: t.index, end: tagRe.lastIndex, xml: full });
      continue;
    }
    if (depth === 0) current = { tag: name, start: t.index };
    depth++;
  }
  return out;
}

/** Replace child elements in place, back to front so earlier offsets stay valid. */
function spliceChildren(xml, edits) {
  let out = xml;
  for (const e of [...edits].sort((a, b) => b.start - a.start)) {
    out = out.slice(0, e.start) + e.replacement + out.slice(e.end);
  }
  return out;
}

/**
 * First `<a:off>`/`<a:ext>` that belong to the shape's own frame, in EMU.
 * A table's frame is `<p:xfrm>` on its graphicFrame; every other shape's is
 * `<a:xfrm>`.
 */
function shapeFrame(shapeXml) {
  const xfrm = /<([ap]):xfrm(?:\s[^>]*)?>([\s\S]*?)<\/\1:xfrm>/.exec(shapeXml);
  if (!xfrm) return null;
  const off = /<a:off\s+x="(-?\d+)"\s+y="(-?\d+)"\s*\/>/.exec(xfrm[2]);
  const ext = /<a:ext\s+cx="(\d+)"\s+cy="(\d+)"\s*\/>/.exec(xfrm[2]);
  if (!off) return null;
  return {
    x: Number(off[1]),
    y: Number(off[2]),
    cx: ext ? Number(ext[1]) : null,
    cy: ext ? Number(ext[2]) : null,
  };
}

/**
 * Set a shape's own frame — position and extent together.
 *
 * A sibling of setShapeX, for the one case that needs to change size: an icon
 * whose artwork is square dropped into a frame that is not. Stretching it is
 * the wrong answer and doing nothing is also the wrong answer, so the picture
 * is fitted inside the frame the designer drew. Every number involved comes
 * from the artwork — the frame from the slide, the aspect from the icon's own
 * viewBox — so nothing here is a dimension anybody typed.
 */
function setShapeFrame(shapeXml, { x, y, cx, cy }) {
  let done = false;
  return shapeXml.replace(
    /(<[ap]:xfrm(?:\s[^>]*)?>[\s\S]*?<a:off\s+x=")(-?\d+)("\s+y=")(-?\d+)("\s*\/>\s*<a:ext\s+cx=")(\d+)("\s+cy=")(\d+)(")/,
    (m, a, _x, b, _y, c, _cx, d, _cy, e) => {
      if (done) return m;
      done = true;
      return `${a}${Math.round(x)}${b}${Math.round(y)}${c}${Math.round(cx)}${d}${Math.round(cy)}${e}`;
    }
  );
}

/** Move a shape horizontally by rewriting the x of its own `<a:off>`. */
function setShapeX(shapeXml, x) {
  let done = false;
  return shapeXml.replace(/(<a:xfrm(?:\s[^>]*)?>[\s\S]*?<a:off\s+x=")(-?\d+)(")/, (m, a, _old, b) => {
    if (done) return m;
    done = true;
    return `${a}${Math.round(x)}${b}`;
  });
}

const shapeName = (shapeXml) => (/<p:cNvPr\s[^>]*name="([^"]*)"/.exec(shapeXml) || [, ''])[1];
const shapeText = (shapeXml) => [...shapeXml.matchAll(/<a:t>([\s\S]*?)<\/a:t>/g)].map((m) => m[1]).join('');
const hasPlaceholder = (shapeXml) => /<p:ph\b/.test(shapeXml);

module.exports = {
  EMU_PER_INCH, EMU_PER_POINT,
  escapeXml, childElements, spliceChildren,
  shapeFrame, setShapeX, setShapeFrame, shapeName, shapeText, hasPlaceholder,
};
