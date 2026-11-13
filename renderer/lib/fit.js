/**
 * Will this record fit this template?
 *
 * Two limits per text slot, and they are not the same kind of thing:
 *
 *   maxChars — the number the marketer is shown in Drupal. A form can only
 *              count characters, so this is the proxy they can act on while
 *              typing. It stops the ordinary case.
 *
 *   maxLines — the truth. The box is a fixed width at a fixed point size, and
 *              what overflows it is *advance width*, not character count:
 *              "Product Development" and "mmmmmmmmmmmmmmmmmmm" are the same
 *              length and very different widths. So the text is wrapped against
 *              real font metrics and the resulting line count is checked.
 *
 * Both now come out of the blueprint card rather than a table in the renderer,
 * because both are properties of one piece of artwork.
 *
 * When the font cannot be measured, this refuses. It used to skip — `wrap()`
 * returns null with no metrics and the caller read that as "no problem found" —
 * which meant the one check that makes "no text overflows" a verified claim
 * rather than an assertion went quiet on any machine without Raleway, and said
 * nothing about having done so. A check that silently disables itself is worse
 * than no check, because it still reports success.
 *
 * `emphasis` in the contract is recorded but not enforced here. It says whether
 * a slot's artwork carries an emphasised run at all, which is what phase 3's
 * template matching needs to know; making it a refusal today would reject
 * content that currently renders correctly.
 *
 * How many items a repeating slot holds is checked here too, and that is a
 * phase 2 move rather than a tidy-up. It used to be a cardinality of 5 on the
 * Drupal field: the repository refused to store a sixth capability pillar
 * because one slide's icon row does not extend to six. The website has six. So
 * the count is now a question asked of a *template*, at the moment a deck is
 * generated, and the answer names the template and offers a way out — rather
 * than the marketer meeting a form that will not let them type what is true.
 */
const richtext = require('./richtext');
const fm = require('./font-metrics');
const card = require('./card');

/**
 * The one issue that stops rendering rather than merely reporting on it.
 * Everything else here is advice; this is an inability to give advice at all.
 */
const FONT_ISSUE = '__font__';

const unmeasurable = (family, bold, weight) => ({
  severity: 'error',
  blocking: true,
  field: FONT_ISSUE,
  label: 'Renderer',
  message:
    `cannot measure ${family} ${bold ? 'Bold' : weight || 'Regular'}, so nothing can be checked against the ` +
    `boxes on this template. Install the ${family} family, or drop ` +
    `${fm.fontFileNames(family, bold, weight)[0]} into renderer/template/fonts/.`,
});

/**
 * What a piece of text comes to in one box: characters, and wrapped lines.
 * `lines` is null when the font cannot be measured — never zero, never a guess.
 */
function measureText({ value, box, font }) {
  const plain = richtext.toPlain(value);
  const lines = fm.wrap(plain, {
    family: font.family,
    bold: box.bold,
    weight: font.weight,
    sizePt: box.sizePt,
    widthPt: box.widthIn * 72 * font.widthSafety,
  });
  return { chars: plain.length, lines: lines ? lines.length : null };
}

function checkText({ value, slot, box, font, field, label }) {
  const { chars, lines } = measureText({ value, box, font });
  const issues = [];

  if (chars > slot.maxChars) {
    issues.push({
      severity: 'error', field, label,
      message: `${chars} characters, limit is ${slot.maxChars}`,
    });
  }

  if (lines === null) return [unmeasurable(font.family, box.bold, font.weight)];

  if (lines > slot.maxLines) {
    issues.push({
      severity: 'error', field, label,
      message: `wraps to ${lines} lines, the box holds ${slot.maxLines}`,
    });
  }
  return issues;
}

const labelFor = (pattern, n, slot) => pattern.replace('{n}', String(n)).replace('{slot}', slot);

/**
 * Can this template show the icon this item asks for?
 *
 * The vocabulary is the template's, not the repository's: each card names an
 * icon set and can resolve exactly the tokens in it. Two templates carrying the
 * same brand icons share one index; a template carrying three has its own.
 *
 * Blocking, and that is a change. An unresolvable token used to be reported by
 * render() as an ordinary issue, which meant the deck was still produced — with
 * the template's own artwork left in that position. A pillar called "Cloud
 * Transformation" showing the icon for something else is wrong *content* on a
 * finished deck, not a cosmetic overflow, and it is exactly the drift the CCR
 * exists to end. Reported from here rather than from render() so the marketer
 * meets it in the preflight banner instead of in a downloaded file.
 */
function checkIcon({ value, tokens, field, label, template }) {
  const known = Object.keys(tokens);
  if (known.includes(value)) return [];
  return [{
    severity: 'error',
    blocking: true,
    field,
    label,
    message: value
      ? `the template "${template}" has no icon for "${value}". It carries ${known.join(', ')}.`
      : `no icon chosen, and the template "${template}" cannot leave the box empty. It carries ${known.join(', ')}.`,
  }];
}

/**
 * Too many or too few items for this template.
 *
 * The wording matters more than it looks. "Cardinality 5" told a marketer their
 * content was wrong. This tells them which template cannot hold it, why, and
 * the two things they can do about it — one of which is to keep the content and
 * change the template.
 *
 * Built from sentences rather than by concatenating around an optional clause.
 * The first version glued the pieces together and read perfectly for the one
 * card that shipped, because that card's `refusal` happens to end in a full
 * stop; a card without one produced *"holds 3–5 Pick 5, or choose"*, and the
 * under-count branch offered *"a template that holds 1"*, which is not advice
 * anyone can act on. A message this file's own header calls the point of the
 * change should not depend on the punctuation of an optional field.
 */
function countIssue(name, slot, card_, n) {
  const what = `${slot.source.replace(/_/g, ' ')}`;
  const range = slot.min === slot.max ? `${slot.max}` : `${slot.min}–${slot.max}`;
  const sentences = [`You have ${n} ${what}, and the template "${card_.name}" holds ${range}.`];

  if (slot.refusal) {
    sentences.push(`${slot.refusal[0].toUpperCase()}${slot.refusal.slice(1)}`.replace(/\.?$/, '.'));
  }

  sentences.push(
    n > slot.max
      ? `Pick ${slot.max} of them, or choose a template that holds ${n}.`
      : `Add ${slot.min - n} more, or choose a template that holds ${n}.`
  );

  return {
    severity: 'error',
    blocking: true,
    field: name,
    label: slot.label || name,
    message: sentences.join(' '),
  };
}

/**
 * @param {object} record  normalised record
 * @param {object} card    blueprint card
 * @param {object} rows    repeating slot name -> its items, already ordered
 * @returns {Array} issues; any with `blocking: true` means render() must refuse
 */
/** The type a card's text is measured in. */
const fontOf = (card_) => ({
  family: card_.layout.font.family,
  weight: card_.layout.font.weight,
  widthSafety: card_.layout.font.widthSafety ?? 1,
});

function check(record, card_, rows) {
  const font = fontOf(card_);
  const tokens = card.icons(card_);
  const issues = [];

  // Counts first: they need no font, so they are still answerable on a machine
  // where the fit check cannot run, and they are the ones a marketer can act on.
  for (const [name, slot] of Object.entries(card_.contract)) {
    if (slot.kind !== 'repeat') continue;
    const n = (rows[name] || []).length;
    if (n < slot.min || n > slot.max) issues.push(countIssue(name, slot, card_, n));
  }

  // Artwork on the template that belongs to somebody else's story — slide 19's
  // screenshots are one client's product. Not blocking, because the slide is
  // still well made; said every time, because a person has to decide whether
  // it can go in front of a client like that.
  if (card_.placeholderArt) {
    issues.push({ severity: 'warning', field: 'artwork', label: 'Artwork', message: card_.placeholderArt });
  }

  if (!fm.available(font.family, font.weight)) return [...issues, unmeasurable(font.family, false, font.weight)];

  for (const [name, slot] of Object.entries(card_.contract)) {
    const layout = card_.layout.slots[name];

    if (slot.kind === 'text') {
      issues.push(...checkText({
        value: record[slot.source], slot, box: layout.box, font, field: name, label: slot.label,
      }));
      continue;
    }

    if (slot.kind === 'repeat') {
      (rows[name] || []).forEach((item, i) => {
        for (const [child, childSlot] of Object.entries(slot.slots)) {
          if (childSlot.kind === 'icon') {
            issues.push(...checkIcon({
              value: item[childSlot.source],
              tokens,
              field: childSlot.source,
              label: labelFor(slot.labelPattern, i + 1, childSlot.label),
              template: card_.name,
            }));
            continue;
          }
          if (childSlot.kind !== 'text') continue;
          issues.push(...checkText({
            value: item[childSlot.source],
            slot: childSlot,
            box: layout.slots[child].box,
            font,
            field: `${name}.${i + 1}.${child}`,
            label: labelFor(slot.labelPattern, i + 1, childSlot.label),
          }));
        }
      });
    }
  }

  // One unmeasurable font produces one issue per field; the marketer needs it
  // once. Count issues are already one apiece and are kept.
  const unreadable = issues.find((i) => i.field === FONT_ISSUE);
  return unreadable ? [...issues.filter((i) => i.field !== FONT_ISSUE && i.blocking), unreadable] : issues;
}

// Everything after `check` is exported for lib/writer.js, which has to measure
// a proposed line against one box exactly the way a deck would. A second ruler
// over there would be a second opinion about what fits.
module.exports = { check, checkText, measureText, fontOf, FONT_ISSUE };
