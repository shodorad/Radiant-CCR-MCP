/**
 * Which items of a repeating slot this deck uses, and in what order.
 *
 * The repository holds what the business has: six capability pillars, because
 * the business has six. A template holds what its artwork holds: five on slide
 * 4, four on slide 29. Until now the only way to reconcile those two facts was
 * to delete a pillar — the repository bending to a slide, which is the whole
 * problem the CCR exists to end, reappearing one layer down.
 *
 * So the choice moves to the channel. A deck entry says *these five, in this
 * order*, and that selection lives with the deck, never with the record. The
 * repository is not told, is not edited, and does not change. Two decks can
 * select differently from the same record on the same afternoon.
 *
 * **Selections name items, they do not count them.** A selection of positions —
 * "items 1, 2, 3, 5, 6" — is right until somebody drags a pillar, and then it
 * is silently wrong: the deck still renders, still reports no issues, and shows
 * the wrong five. So a selection is a list of the record's own item keys, and a
 * key that is not in the record any more is named rather than skipped. A deck
 * that cannot be rebuilt as specified should say so, not quietly rebuild itself
 * as something else.
 */

/** The key an item is selected by. */
const KEY = 'key';

const listOf = (items) => items.map((i) => i[KEY]).filter(Boolean).join(', ');

/**
 * Apply one slot's selection.
 *
 * @param {Array}  items    the slot's items, already ordered by the contract
 * @param {Array}  chosen   item keys, in the order this deck wants them
 * @param {string} where    the slot, for the refusal messages
 * @returns {Array} the chosen items, in the chosen order
 */
function apply(items, chosen, where) {
  if (chosen === undefined || chosen === null) return items;
  if (!Array.isArray(chosen)) throw new Error(`the selection for ${where} is not a list of item keys`);
  if (!chosen.length) throw new Error(`the selection for ${where} is empty; a slide with no items is not a selection`);

  const byKey = new Map();
  const unkeyed = items.filter((i) => !i[KEY]);
  if (unkeyed.length) {
    throw new Error(
      `${where} cannot be selected from: ${unkeyed.length} of ${items.length} items have no "${KEY}", ` +
      'so a deck could only name them by position and would follow the wrong ones once anybody reorders.'
    );
  }
  for (const item of items) {
    if (byKey.has(item[KEY])) {
      throw new Error(`${where} has two items with the key "${item[KEY]}", so a selection cannot tell them apart`);
    }
    byKey.set(item[KEY], item);
  }

  const seen = new Set();
  const missing = [];
  const out = [];
  for (const key of chosen) {
    if (seen.has(key)) throw new Error(`the selection for ${where} names "${key}" twice`);
    seen.add(key);
    const item = byKey.get(key);
    if (!item) { missing.push(key); continue; }
    out.push(item);
  }

  if (missing.length) {
    throw new Error(
      `this deck selects ${missing.length === 1 ? 'an item' : 'items'} that ${where} no longer has: ` +
      `${missing.join(', ')}. The record now holds ${listOf(items)}. ` +
      'Edit the deck to choose again, so it is rebuilt as something somebody decided rather than as whatever is left.'
    );
  }
  return out;
}

/**
 * Every repeating slot of a card, selected and ordered.
 *
 * @param {object} record     normalised record
 * @param {object} card       blueprint card
 * @param {object} selection  slot name -> item keys, or undefined for all of them
 */
function rows(record, card, selection = {}) {
  if (selection && typeof selection !== 'object') throw new Error('a selection must be an object of slot name to item keys');

  const known = Object.entries(card.contract).filter(([, s]) => s.kind === 'repeat').map(([n]) => n);
  for (const name of Object.keys(selection || {})) {
    if (!known.includes(name)) {
      throw new Error(
        `this deck selects items for "${name}", which the template "${card.id}" does not repeat. ` +
        `It repeats ${known.join(', ') || 'nothing'}.`
      );
    }
  }

  const out = {};
  for (const [name, slot] of Object.entries(card.contract)) {
    if (slot.kind !== 'repeat') continue;
    const key = slot.orderBy || 'weight';
    const ordered = (record[slot.source] || []).slice().sort((a, b) => (a[key] ?? 0) - (b[key] ?? 0));
    out[name] = apply(ordered, selection?.[name], `"${slot.source}"`);
  }
  return out;
}

module.exports = { apply, rows, KEY };
