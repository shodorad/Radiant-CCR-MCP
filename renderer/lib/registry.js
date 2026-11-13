/**
 * The template library.
 *
 * A directory of `.pptx` files, each with a `<id>.card.json` beside it,
 * discovered by scanning. Adding a template is dropping two files in; it is not
 * an edit to a list, because a list is a second place the truth lives and the
 * second place is the one that goes stale.
 *
 * **A broken card must not take the library down.** `card.load` throws on a card
 * it cannot use, which is right — but if that throw escaped the scan, one
 * malformed file would make `/health`, `/match` and every render fail with a
 * message about a template nobody asked for. So the scan collects failures
 * instead: `all()` returns the cards that loaded, `broken()` returns the ones
 * that did not with the reason, and both are reported. A library that is partly
 * usable should say which part.
 *
 * The scan is deliberately not cached. The directory is small, the renderer is
 * a local POC service, and a cache means editing a card and not seeing it —
 * which is exactly the loop a template author is in.
 */
const fs = require('fs');
const path = require('path');
const card = require('./card');

const SUFFIX = '.card.json';

/** @returns {{ok: Array, broken: Array<{file: string, error: string}>}} */
function scan(dir = card.TEMPLATE_DIR) {
  let files;
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith(SUFFIX)).sort();
  } catch {
    throw new Error(`no template directory at ${dir}`);
  }

  const ok = [];
  const broken = [];
  for (const file of files) {
    const full = path.join(dir, file);
    const expected = file.slice(0, -SUFFIX.length);
    try {
      const loaded = card.load(full);
      if (loaded.id !== expected) {
        throw new Error(`its id is "${loaded.id}" but its filename says "${expected}"; the filename is what a person types and the id is what the renderer answers with`);
      }
      ok.push(loaded);
    } catch (e) {
      broken.push({ file, id: file.slice(0, -SUFFIX.length), error: e.message });
    }
  }
  return { ok, broken };
}

/** Every usable template, by declaration order of the directory listing. */
const all = (dir) => scan(dir).ok;

/** Cards that are present but unusable, with the reason. */
const broken = (dir) => scan(dir).broken;

/** The ids the library holds. This is what `?template=` is checked against. */
const ids = (dir) => all(dir).map((c) => c.id);

/**
 * One template by id, or a refusal naming what the library actually has.
 * A card whose `id` disagrees with its filename is refused: the filename is
 * what a person types and the id is what the renderer answers with, and two
 * names for one template is a bug waiting for someone else to find.
 */
function get(id, dir) {
  const { ok, broken: bad } = scan(dir);
  const found = ok.find((c) => c.id === id);
  if (found) return found;

  const failed = bad.find((b) => b.id === id);
  if (failed) throw new Error(`the template "${id}" is in the library but unusable: ${failed.error}`);
  throw new Error(`no template "${id}"; this renderer holds ${ok.map((c) => c.id).join(', ') || 'none'}`);
}

module.exports = { scan, all, broken, ids, get, SUFFIX };
