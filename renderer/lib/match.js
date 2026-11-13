/**
 * Which templates can show this record, and why the others cannot.
 *
 * The question a marketer actually has is not "does this template render?" but
 * "what can I make from what I have?" — so the answer is given in the record's
 * own vocabulary: capability pillars, not `items`; a missing `headline`, not a
 * missing slot. The template's name appears because the marketer has to choose
 * between templates; the template's *internals* never do.
 *
 * Three answers, and the middle one is the interesting one:
 *
 *   fits            — every key present, every count in range. Generate away.
 *   needs-selection — the record has more items than the template holds. That is
 *                     not a refusal: the deck says which ones it uses, and the
 *                     repository keeps all of them. Before selection existed the
 *                     only way through this was to delete content.
 *   refused         — something no choice can fix from here: a key the record
 *                     does not publish, fewer items than the template needs, an
 *                     icon the template does not carry, a font that cannot be
 *                     measured.
 *
 * **The refusal that names the mapping gap.** A card slot's `source` is a record
 * key. A template built for a different kind of content asks for keys this
 * repository does not publish — `headline`, say — and today it cannot be fed,
 * because `/ccr/record` is assembled by hand in RecordNormaliser::toRecord() for
 * one bundle. That limit is real and it is *not* fixed here. What is fixed is
 * that it now says so, by name, listing what the record does publish, instead of
 * being an impossibility nobody could see. See plan.md §7 U3 for the trigger
 * that makes the config-driven version worth building.
 *
 * Fit problems — text too long for its box — are warnings, not refusals, and
 * they are reported for *every* item rather than only the ones a provisional
 * selection would use. That is deliberate: a marketer choosing four of six is
 * better served by knowing which two names overflow than by being told about
 * the four somebody else's default picked.
 */
const fit = require('./fit');
const select = require('./select');
const source = require('./source');
const registry = require('./registry');

/** The record's word for a slot, not the card's. */
const vocabulary = (slot) => (slot.label || slot.source || '').toString();

/**
 * @param {object} record
 * @param {object} blueprint
 * @returns {{id, name, provenance, status, holds, refusals, warnings}}
 */
function one(record, blueprint) {
  const refusals = [];
  const holds = {};

  const missing = source.missingKeys(record, blueprint);
  const topMissing = missing.filter((m) => !m.includes('['));
  if (topMissing.length) {
    refusals.push({
      field: 'record',
      label: 'Content',
      message:
        `this record has no ${topMissing.join(', ')}. ` +
        `It publishes ${source.publishes(record).join(', ')}.`,
    });
  }

  let rows;
  try {
    rows = select.rows(record, blueprint);
  } catch (e) {
    refusals.push({ field: 'record', label: 'Content', message: e.message });
    rows = {};
  }

  // Every repeating slot, whether or not it is in range — the CCR needs the
  // numbers to build a selection form, not only when something is wrong.
  for (const [name, slot] of Object.entries(blueprint.contract)) {
    if (slot.kind !== 'repeat') continue;
    holds[name] = {
      source: slot.source,
      label: vocabulary(slot),
      min: slot.min,
      max: slot.max,
      have: (rows[name] || []).length,
      refusal: slot.refusal ?? null,
    };
  }

  let issues = [];
  try {
    issues = fit.check(record, blueprint, rows);
  } catch (e) {
    refusals.push({ field: 'template', label: 'Renderer', message: e.message });
  }

  let needsSelection = false;
  const warnings = [];
  for (const issue of issues) {
    if (!issue.blocking) { warnings.push(issue); continue; }
    // An over-count is the one blocking issue a person can answer without
    // changing the content, so it is a state rather than a refusal.
    const slot = holds[issue.field];
    if (slot && slot.have > slot.max) { needsSelection = true; continue; }
    refusals.push({ field: issue.field, label: issue.label, message: issue.message });
  }

  return {
    id: blueprint.id,
    name: blueprint.name,
    provenance: blueprint.provenance ?? null,
    status: refusals.length ? 'refused' : needsSelection ? 'needs-selection' : 'fits',
    holds,
    refusals,
    warnings,
  };
}

/**
 * Every template in the library, answered for this record.
 * A card that will not load is reported as refused with the reason rather than
 * quietly left out of the list.
 */
function all(record, dir) {
  const { ok, broken } = registry.scan(dir);
  // A template for a different kind of record is not refused, it is simply not
  // one of this record's options: a case study slide is not something a company
  // overview "cannot use", any more than a letterhead is.
  const forThis = ok.filter((blueprint) => !blueprint.record || blueprint.record === record.type);
  return [
    ...forThis.map((blueprint) => one(record, blueprint)),
    ...broken.map((b) => ({
      id: b.id,
      name: b.id,
      provenance: null,
      status: 'refused',
      holds: {},
      refusals: [{ field: 'template', label: 'Template', message: b.error }],
      warnings: [],
    })),
  ];
}

module.exports = { one, all };
