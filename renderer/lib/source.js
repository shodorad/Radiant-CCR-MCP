/**
 * Where a content record comes from.
 *
 * Two sources, one shape. The fixture is the hand-written stand-in from plan.md
 * phase 0; the CCR is the live repository. Both normalise to the same record so
 * the renderer never learns which one it got, and so the renderer stays runnable
 * with no CCR available — a plan.md phase 3 acceptance criterion that
 * `renderer/test.js` exists to keep true.
 *
 * **What changed in unwelding phase 2, and why it is not a shortcut.**
 *
 * This file used to fetch the node over JSON:API and flatten it with two
 * hard-coded tables — `field_positioning_statement` means `positioning_statement`,
 * `field_pillar_name` means `name`, and so on. That put Drupal's field structure
 * inside the renderer, which is precisely the coupling H2 says should not exist:
 * a channel knowing the repository's internals. It also duplicated a mapping the
 * repository already owns, in `RecordNormaliser.php`, in a second language —
 * so renaming one field meant editing both, and forgetting one meant a field
 * silently arriving empty.
 *
 * The CCR now publishes the channel-neutral record itself, at `/ccr/record`, and
 * this file reads it. That is the same move phase 4 made in the other direction:
 * the CCR posts a neutral record to the website's `/ccr/receive` rather than
 * writing the site's fields over JSON:API, because *the translation belongs to
 * whoever owns the storage*. Here the repository owns its own export.
 *
 * JSON:API stays enabled and is still the CCR's general-purpose read API — the
 * demo asserts it — but the deck channel no longer depends on the shape of
 * Drupal's field names.
 *
 * What the *card* does now is say which keys a record must carry. A slot's
 * `source` names the record key it reads, so the template declares its own
 * requirements and a record that cannot satisfy them is named as such rather
 * than rendering with a blank box.
 */
const fs = require('fs');
const card = require('./card');

// http, not https: DDEV signs its certificates with a local mkcert authority
// that Node does not trust by default. Both schemes are served. To use https,
// start the renderer with
//   NODE_EXTRA_CA_CERTS="$(mkcert -CAROOT)/rootCA.pem"
const DEFAULT_CCR = process.env.CCR_BASE_URL || 'http://ccr-mcp.ddev.site';

/**
 * Every record key a card reads, top level and inside its repeating slots.
 * @returns {{top: Array<{key: string, required: boolean}>,
 *            repeats: Object<string, Array<{key: string, required: boolean}>>}}
 */
function requiredKeys(blueprint) {
  const top = [];
  const repeats = {};
  const entry = (slot) => ({ key: slot.source, required: slot.required !== false });

  for (const [, slot] of Object.entries(blueprint.contract)) {
    if (slot.kind === 'repeat') {
      repeats[slot.source] = Object.values(slot.slots).map(entry);
      continue;
    }
    top.push(entry(slot));
  }
  return { top, repeats };
}

/**
 * Nothing to put in the box.
 *
 * `undefined` because the key is absent, `null` because Drupal's `->value`
 * returns null for an empty field, or `''` because someone cleared it — all
 * three end up as the same thing on a slide, which is a blank box. Testing only
 * for `undefined` was a real hole: the CCR emits `null` for an empty field as a
 * matter of course, so the check passed on exactly the records it existed to
 * catch. Whitespace counts as empty for the same reason.
 */
const absent = (v) => v === undefined || v === null || (typeof v === 'string' && v.trim() === '');

/**
 * Check a record can feed a card, and say exactly what is missing if not.
 *
 * A missing value is not a crash — it flows into `richtext.parse` and comes out
 * as an empty box on the slide. That is the failure this catches: silence, on a
 * deck somebody is about to put in front of a client.
 *
 * Only slots the contract marks `required` are checked, which is every slot on
 * the template shipped today. `required` is a statement about the *record*: the
 * template will not accept one without this. Where the shape has to be in the
 * .pptx is `layout`'s business, and `lib/slots.js` refuses that separately.
 */
function missingKeys(record, blueprint, rows) {
  const { top, repeats } = requiredKeys(blueprint);
  const missing = top.filter(({ key, required }) => required && absent(record[key])).map((m) => m.key);

  for (const [name, slot] of Object.entries(blueprint.contract)) {
    if (slot.kind !== 'repeat') continue;
    const childKeys = repeats[slot.source];
    // Only the items this deck actually uses. A pillar with an empty
    // description that no slide selects is not a reason to refuse a deck.
    const items = rows?.[name] ?? record[slot.source];
    if (!Array.isArray(items)) { missing.push(slot.source); continue; }
    items.forEach((item, i) => {
      for (const { key, required } of childKeys) {
        if (required && absent(item[key])) missing.push(`${slot.source}[${i + 1}].${key}`);
      }
    });
  }
  return missing;
}

/** What this record publishes, for a refusal that can name the alternatives. */
const publishes = (record) =>
  Object.keys(record).filter((k) => !k.startsWith('_') && !['source', 'id', 'nid', 'type', 'changed'].includes(k));

function checkAgainstCard(record, blueprint, where, rows) {
  const missing = missingKeys(record, blueprint, rows);
  if (missing.length) {
    throw new Error(
      `the record from ${where} has nothing in ${missing.join(', ')}, which the ` +
      `template "${blueprint.id}" needs. A slide would show these as empty boxes. ` +
      `This record publishes ${publishes(record).join(', ')}.`
    );
  }
  return record;
}

function fromFixture(file, { template = card.DEFAULT_ID } = {}) {
  const record = JSON.parse(fs.readFileSync(file, 'utf8'));
  return checkAgainstCard({ ...record, source: { kind: 'fixture', file } }, card.load(template), file);
}

/**
 * Fetch the channel-neutral record the CCR publishes about itself.
 */
async function fromCCR({ baseUrl = DEFAULT_CCR, nid, template = card.DEFAULT_ID } = {}) {
  const base = baseUrl.replace(/\/$/, '');
  const url = `${base}/ccr/record${nid ? `?nid=${encodeURIComponent(nid)}` : ''}`;

  const res = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`CCR returned ${res.status} ${res.statusText} for ${url}${detail ? ` — ${detail}` : ''}`);
  }

  const record = await res.json();
  record.source = { kind: 'ccr', url, nid: record.nid };
  return checkAgainstCard(record, card.load(template), url);
}

module.exports = { fromFixture, fromCCR, requiredKeys, missingKeys, publishes, checkAgainstCard, DEFAULT_CCR };
