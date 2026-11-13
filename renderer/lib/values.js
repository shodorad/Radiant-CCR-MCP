/**
 * The values that actually reach a slide, flattened into comparable lines.
 *
 * This exists so the repository can answer "what changed since you downloaded
 * this?" without learning what a template is. The CCR stores what the renderer
 * says it put on the slide, and compares two of those lists later. Nothing here
 * decides staleness — this only reports, truthfully, what was rendered.
 *
 * **Why the renderer owns this and not the CCR.** Which fields reach a slide is
 * a fact about the artwork: `section-cover` shows a title and nothing else,
 * `capability-columns` shows four items where slide 4 shows five. Recomputing
 * that in Drupal would be a second implementation of `select.rows` and the
 * contract walk, drifting from this one the first time a card gained a slot —
 * and a drift report that is itself out of date is worse than none.
 *
 * **Lines are keyed by item, never by position.** `items:<key>:name` and not
 * `items[2].name`, for the same reason select.js names items rather than
 * counting them: somebody drags a pillar and every positional comparison
 * silently reports two changes that never happened.
 *
 * The value is the stored markup, not plain text. Bolding a word is a change
 * the slide shows, so it is a change this reports.
 */
const card = require('./card');
const select = require('./select');

/** "Column 3 name" from labelPattern "Column {n} {slot}". */
function lineLabel(slot, childSlot, child, n) {
  const pattern = slot.labelPattern || `${slot.label || 'Item'} {n} {slot}`;
  return pattern.replace('{n}', String(n)).replace('{slot}', childSlot.label || child);
}

/**
 * @param {object} record     normalised record
 * @param {object} opts       { template, selection }
 * @returns {{template: string, title: string, lines: Array<{id, label, value, item?: string}>}}
 */
function valuesOf(record, { template, selection } = {}) {
  const blueprint = card.load(template);
  const rows = select.rows(record, blueprint, selection);
  const lines = [];

  for (const [name, slot] of Object.entries(blueprint.contract)) {
    if (slot.kind === 'repeat') continue;
    lines.push({
      id: name,
      label: slot.label || name,
      value: record[slot.source] ?? null,
    });
  }

  for (const [name, slot] of Object.entries(blueprint.contract)) {
    if (slot.kind !== 'repeat') continue;
    rows[name].forEach((item, i) => {
      for (const [child, childSlot] of Object.entries(slot.slots)) {
        lines.push({
          id: `${name}:${item[select.KEY]}:${child}`,
          label: lineLabel(slot, childSlot, child, i + 1),
          value: item[childSlot.source] ?? null,
          item: item[select.KEY],
        });
      }
    });
  }

  return { template: blueprint.id, title: record.title, lines };
}

module.exports = { valuesOf };
