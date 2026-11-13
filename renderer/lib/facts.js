/**
 * Does a line say anything the source material does not?
 *
 * A written channel's copy is derived from the record's source material, and a
 * person approves it. This is the part of "derived" a machine can check without
 * understanding anything: **every number in the copy has to be a number the
 * source states.** A model asked for a result box will happily round 74% to
 * 75%, turn "about 1,400" into "1,500", or compute a percentage the source never
 * claimed — and each of those reads as perfectly good copy to the person
 * approving it. So a number that is not in the source is a problem, the draft
 * is sent back, and an edit that introduces one cannot be approved: the fix is
 * to put the fact in the source first, where the next draft of every channel
 * will find it.
 *
 * Names are softer. A capitalised word the source does not contain is often a
 * name the model made up and sometimes just a heading word ("Dispatch"), so it
 * is a warning a person reads rather than a refusal.
 *
 * What this cannot check, and does not pretend to: whether the copy *means* what
 * the source means, whether a projection kept its qualifier, whether something
 * marked "not for publication" was paraphrased without its numbers. Those stay
 * with the person approving — see plan.md §8 A2.
 */
const richtext = require('./richtext');

const NUMBER_WORDS = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16,
  seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20, thirty: 30, forty: 40,
  fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90, hundred: 100,
};
const WORD_RE = new RegExp(`\\b(${Object.keys(NUMBER_WORDS).join('|')})\\b`, 'gi');

/** Every number a text states, as digits: "nine states" and "9 states" agree. */
function numbersIn(text) {
  const plain = richtext.toPlain(text).replace(WORD_RE, (w) => String(NUMBER_WORDS[w.toLowerCase()]));
  const found = new Set();
  for (const m of plain.matchAll(/\d[\d,]*(?:\.\d+)?/g)) {
    found.add(m[0].replace(/,/g, '').replace(/\.0+$/, ''));
  }
  return found;
}

/** Words that are capitalised because of what they are, not because a model invented them. */
const ALWAYS = new Set(['radiant', 'digital', 'ai', 'us', 'uk', 'ceo', 'coo', 'cto', 'cio']);

/** Capitalised words that do not start a sentence, a line or a heading segment. */
function namesIn(text) {
  const plain = richtext.toPlain(text);
  const names = new Set();
  for (const m of plain.matchAll(/(^|[\s(“"'])([A-Z][A-Za-z’'-]*[A-Za-z])/gm)) {
    const before = plain.slice(0, m.index + m[1].length).trimEnd();
    if (!before || /[.!?:|—–\n]$/.test(before)) continue;
    names.add(m[2]);
  }
  return names;
}

/**
 * @param {string} text       the copy, as stored (markup allowed)
 * @param {string} source     everything the record holds, as one text
 * @param {string} [allowed]  other text whose words are fine to use — the
 *                            channel's own brief, which may ask for "Case Study"
 * @returns {{problems: string[], warnings: string[]}}
 */
function check(text, source, allowed = '') {
  const known = numbersIn(source);
  const invented = [...numbersIn(text)].filter((n) => !known.has(n));

  const vocabulary = `${richtext.toPlain(source)} ${allowed}`.toLowerCase();
  const unknownNames = [...namesIn(text)].filter((name) => {
    const bare = name.toLowerCase().replace(/[’']s$/, '');
    return !ALWAYS.has(bare) && !new RegExp(`\\b${bare.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`).test(vocabulary);
  });

  return {
    problems: invented.length
      ? [`${invented.length === 1 ? 'the number' : 'the numbers'} ${invented.join(', ')} ${invented.length === 1 ? 'is' : 'are'} not in the source material`]
      : [],
    warnings: unknownNames.length
      ? [`${unknownNames.join(', ')} ${unknownNames.length === 1 ? 'does' : 'do'} not appear in the source material — check ${unknownNames.length === 1 ? 'it is' : 'they are'} right`]
      : [],
  };
}

/** Is `text` a word-for-word passage of `source`, ignoring quotation marks, case and spacing? */
function quotes(text, source) {
  const norm = (t) => richtext.toPlain(t).toLowerCase().replace(/[“”"‘’']/g, '').replace(/[—–]/g, '-').replace(/\s+/g, ' ').trim();
  const q = norm(text);
  return q.length > 0 && norm(source).includes(q);
}

module.exports = { check, quotes, numbersIn, namesIn };
