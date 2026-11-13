/**
 * Generated decks have to be tracked, or nobody can be told when one goes stale.
 *
 * A deck is a point-in-time artefact: the moment it is downloaded it stops
 * following the CCR. That drift is not a bug to be engineered away — it is the
 * thing H5 exists to surface. To surface it, the CCR needs four facts per
 * generation: which content, which version of it, who generated it, and when.
 *
 * The renderer posts those four facts back to the CCR. The CCR compares the
 * recorded version against the node's current one and flags the difference.
 * Comparison and notification live in Drupal, not here — the renderer is a
 * channel and should not be the place staleness is decided.
 *
 * Delivery is a flag on a dashboard, not an email. Stated shortcut (plan.md §4).
 */
const DISABLED = process.env.CCR_GENERATION_LOG === 'off';

/**
 * @returns {Promise<{id: string}|null>} null when logging is off or the CCR is
 * unreachable — a deck the marketer can hold is worth more than a log row.
 */
async function record({ baseUrl, record: overview, generatedBy, bytes, template }) {
  if (DISABLED) return null;

  const payload = {
    data: {
      type: 'ccr_generation_log--ccr_generation_log',
      attributes: {
        label: `${overview.title} — ${generatedBy}`,
        content_id: String(overview.id ?? ''),
        // No content_changed: the CCR reads the node's own changed time when it
        // writes the row, because the version a deck was made from is the
        // repository's fact and not the renderer's claim. Sending it invited
        // the belief that this payload decided staleness. It never did.
        generated_by: generatedBy,
        // Which template was filled. The CCR needs it to ask, later, what this
        // slide carried — a snapshot taken against a guessed template would
        // describe a slide nobody made. See renderer/lib/values.js.
        template,
        channel: 'pptx',
        bytes,
      },
    },
  };

  try {
    const res = await fetch(`${baseUrl.replace(/\/$/, '')}/ccr/generation-log`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload.data.attributes),
      signal: AbortSignal.timeout(4000),
    });
    if (!res.ok) {
      console.warn(`log     CCR refused the generation log: ${res.status}`);
      return null;
    }
    return await res.json();
  } catch (e) {
    console.warn(`log     could not reach the CCR to record this generation: ${e.message}`);
    return null;
  }
}

module.exports = { record };
