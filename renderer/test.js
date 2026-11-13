#!/usr/bin/env node
/**
 * Renderer regression suite. Runs against the fixture, so it needs no Drupal —
 * that independence is a plan.md phase 3 acceptance criterion, and this file is
 * what keeps it true.
 *
 *   node test.js
 */
const fs = require('fs');
const path = require('path');
const { render, renderDeck, checkRecord } = require('./render');
const { validate } = require('./validate');
const card = require('./lib/card');
const slots = require('./lib/slots');
const row = require('./lib/row');
const registry = require('./lib/registry');
const match = require('./lib/match');
const source = require('./lib/source');
const richtext = require('./lib/richtext');
const fm = require('./lib/font-metrics');
const writer = require('./lib/writer');
const llm = require('./lib/llm');
const { childElements, shapeFrame, shapeName, shapeText } = require('./lib/ooxml');

const FIXTURE = path.resolve(__dirname, '../fixtures/company-overview.json');
const base = () => JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));

/**
 * The fixture holds six capability pillars, because the business has six. No
 * shipped template holds six, so every render of the whole record goes through
 * a selection — which is the point: the repository keeps what is true and the
 * deck says which of it this slide uses.
 *
 * `firstFive` is the selection that reproduces the deck this project shipped
 * before selection existed, which is what the golden-hash test leans on.
 */
const firstFive = (record = base()) => ({ items: record.capability_pillars.slice(0, 5).map((p) => p.key) });
const FIVE = firstFive();

let failures = 0;
const results = [];
function check(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => results.push(['pass', name]))
    .catch((e) => { failures++; results.push(['FAIL', `${name} — ${e.message}`]); });
}
const assert = (cond, msg) => { if (!cond) throw new Error(msg); };

/** The fixture rendered through the shipped card. See the golden-hash check. */
const GOLDEN_SLIDE_SHA256 = 'e5e8cb575fd059870ad4426bc8b6adbed7ac99eef75a9d1b5c9e1f61ed453e61';

/** A one-off card in tmp, pointed at the shipped template and icons. */
function writeCard(label, data, blueprint) {
  data.pptx = blueprint.pptxPath;
  data.icons = blueprint.iconsPath;
  const file = path.join(require('os').tmpdir(), `ccr-${label}-${process.pid}.card.json`);
  fs.writeFileSync(file, JSON.stringify(data));
  return file;
}

const tmp = path.join(require('os').tmpdir(), `ccr-test-${process.pid}.pptx`);
async function renderAndValidate(record, options) {
  const out = await render(record, options);
  fs.writeFileSync(tmp, out.buffer);
  const v = await validate(tmp);
  assert(v.errors.length === 0, `package invalid: ${v.errors.join('; ')}`);
  return out;
}

const slideText = async (buffer) => {
  const zip = await require('jszip').loadAsync(buffer);
  const xml = await zip.file('ppt/slides/slide1.xml').async('string');
  return { xml, text: [...xml.matchAll(/<a:t>([\s\S]*?)<\/a:t>/g)].map((m) => m[1]).join('|') };
};

async function main() {
  await check('renders five of the record\'s six pillars, with no fit issues', async () => {
    const record = base();
    assert(record.capability_pillars.length === 6, 'the fixture should hold the six pillars the business has');
    const { issues, counts } = await renderAndValidate(record, { selection: FIVE });
    assert(counts.items === 5, `expected 5 pillars on the slide, got ${counts.items}`);
    assert(issues.length === 0, `unexpected fit issues: ${JSON.stringify(issues)}`);
  });

  await check('emphasis becomes a formatted run, never literal markup', async () => {
    const { buffer } = await render(base(), { selection: FIVE });
    const { xml, text } = await slideText(buffer);
    assert(!text.includes('<strong>') && !text.includes('&lt;strong&gt;'), 'markup leaked into the slide text');
    assert(text.includes('accelerate'), 'emphasised text is missing');
    assert(/92D050/.test(xml), 'the pillar keyword lost its Radiant green');
  });

  await check('a field that is bold throughout stays bold', async () => {
    const { buffer } = await render(base(), { selection: FIVE });
    const { xml } = await slideText(buffer);
    const name = /<a:t>Digital Strategy and Experience<\/a:t>/.exec(xml);
    assert(name, 'pillar name not found on the slide');
    const run = xml.slice(Math.max(0, name.index - 900), name.index);
    assert(/\bb="1"/.test(run.slice(run.lastIndexOf('<a:rPr'))), 'the pillar name came out unbolded');
  });

  for (const n of [3, 4, 5]) {
    await check(`renders ${n} pillars, re-centred`, async () => {
      const record = base();
      record.capability_pillars = record.capability_pillars.slice(0, n);
      const { buffer, counts } = await renderAndValidate(record);
      assert(counts.items === n, `expected ${n}, got ${counts.items}`);

      const { xml } = await slideText(buffer);
      const names = [...xml.matchAll(/<a:t>([^<]*)<\/a:t>/g)].map((m) => m[1]);
      for (const p of record.capability_pillars) assert(names.includes(p.name), `${p.name} missing`);
      const dropped = base().capability_pillars.slice(n);
      for (const p of dropped) assert(!names.includes(p.name), `${p.name} should have been removed`);

      // Count only the connectors in the icon row; the slide also carries three
      // horizontal rules that have nothing to do with the pillar count.
      const arrows = childElements(xml, 'p:spTree').filter((c) => {
        if (c.tag !== 'p:cxnSp') return false;
        const f = shapeFrame(c.xml);
        return f && Math.abs(f.y / 914400 - 4.1) < 0.12;
      }).length;
      assert(arrows === n - 1, `expected ${n - 1} connector arrows between ${n} icons, found ${arrows}`);

      // Re-centring is the whole reason a short row does not cling to the left,
      // and nothing above would notice if it stopped happening. The row's
      // midpoint must land on the row centre the card declares.
      const rowSpec = card.load('company-overview').layout.slots.items.row;
      const iconXs = childElements(xml, 'p:spTree')
        .filter((c) => c.tag === 'p:pic')
        .map((c) => shapeFrame(c.xml))
        .filter((f) => f && Math.abs(f.y / 914400 - 3.67) < 0.12)
        .map((f) => f.x + f.cx / 2)
        .sort((a, b) => a - b);
      assert(iconXs.length === n, `expected ${n} icons, found ${iconXs.length}`);
      const expected = row.centres(n, rowSpec);
      for (let i = 0; i < n; i++) {
        assert(Math.abs(iconXs[i] - expected[i]) <= 1, `icon ${i + 1} sits at ${iconXs[i]}, expected ${expected[i]}`);
      }
    });
  }

  await check('refuses a sixth pillar, naming the template and a way out', async () => {
    // Phase 2 moved this refusal. It used to be a cardinality of 5 on the
    // Drupal field, so a marketer could not store a sixth pillar the business
    // actually has. Now the record is fine and the *template* is what cannot
    // take it — so the message has to name the template, say why, and offer
    // the option of keeping the content and changing the template instead.
    const record = base();
    assert(record.capability_pillars.length === 6, 'the fixture should hold six pillars');

    let message = null;
    try { await render(record); } catch (e) { message = e.message; }
    assert(message, 'six pillars were accepted by a five-slot template');
    assert(/You have 6 capability pillars/.test(message), `should name the count, got: ${message}`);
    assert(/What We Do/.test(message), `should name the template, got: ${message}`);
    assert(/3–5|3-5/.test(message), `should name the limit, got: ${message}`);
    assert(/choose a template that holds 6/.test(message), `should offer a way out, got: ${message}`);

    // The sentence is assembled from parts, not glued around an optional
    // clause. A card without a `refusal` used to produce "holds 3–5 Pick 5".
    const bare = JSON.parse(fs.readFileSync(card.load('company-overview').file, 'utf8'));
    delete bare.contract.items.refusal;
    const file = writeCard('norefusal', bare, card.load('company-overview'));
    const [issue] = checkRecord(record, { template: file });
    fs.rmSync(file, { force: true });
    assert(
      /holds 3–5\. Pick 5 of them/.test(issue.message),
      `a card with no refusal produced a broken sentence: ${issue.message}`
    );
  });

  await check('the count refusal is available before a file is made', async () => {
    // The whole point of moving the check to generation time is that the CCR
    // can say it *before* the marketer presses Generate. If it were only
    // reachable by throwing from render(), the marketer would meet it as a
    // failed download.
    const record = base();
    record.capability_pillars[5].name = 'Skilled Workforce Solutions and Talent Enablement';

    const issues = checkRecord(record);
    const blocking = issues.filter((i) => i.blocking);
    assert(blocking.length === 1, `expected one blocking issue, got ${JSON.stringify(issues)}`);
    assert(blocking[0].label === 'Capability pillars', `unhelpful label: ${blocking[0].label}`);

    // ...and the over-long sixth name is still reported rather than swallowed,
    // so the marketer sees everything wrong at once, not one thing per attempt.
    assert(
      issues.some((i) => /Pillar 6 name/.test(i.label)),
      `the sixth pillar's own fit was not checked: ${JSON.stringify(issues)}`
    );
  });

  await check('a record missing a key the card needs is named, not rendered blank', async () => {
    // An absent key is not a crash: undefined flows through richtext.parse and
    // comes out as an empty box on a deck someone is about to present.
    const file = path.join(require('os').tmpdir(), `ccr-thin-${process.pid}.json`);
    const thin = base();
    delete thin.framework_name;
    delete thin.capability_pillars[2].icon_token;
    fs.writeFileSync(file, JSON.stringify(thin));

    let message = null;
    try { source.fromFixture(file); } catch (e) { message = e.message; }
    fs.rmSync(file, { force: true });
    assert(message, 'a record missing two keys was accepted');
    assert(/framework_name/.test(message), `should name the missing key, got: ${message}`);
    assert(/capability_pillars\[3\].icon_token/.test(message), `should name the missing item key, got: ${message}`);
  });

  await check('an empty value is as missing as an absent key', async () => {
    // The CCR emits null for an empty field as a matter of course — that is what
    // `->value` returns — so a check that only looked for `undefined` passed on
    // exactly the records it existed to catch. All three of undefined, null and
    // "" come out of the renderer as the same thing: a blank box on a finished
    // deck, reported as zero issues.
    const blueprint = card.load('company-overview');
    for (const [label, mutate] of [
      ['null', (r) => { r.framework_name = null; }],
      ['empty string', (r) => { r.framework_statement = ''; }],
      ['whitespace', (r) => { r.capability_pillars[1].name = '   '; }],
      ['absent', (r) => { delete r.positioning_statement; }],
    ]) {
      const record = base();
      mutate(record);
      let message = null;
      try { source.checkAgainstCard(record, blueprint, 'a test'); } catch (e) { message = e.message; }
      assert(message, `a ${label} value was accepted and would render as an empty box`);
      assert(/empty boxes/.test(message), `unhelpful refusal for ${label}: ${message}`);
    }
  });

  await check('the fixture satisfies the shipped card', () => {
    // The fixture is what keeps the renderer testable with no Drupal running,
    // so it has to stay a valid record for the template it feeds.
    const record = source.fromFixture(FIXTURE);
    const { top, repeats } = source.requiredKeys(card.load('company-overview'));
    for (const { key } of top) assert(record[key], `the fixture has nothing in ${key}`);
    assert(Object.keys(repeats).length === 1, 'expected one repeating source in the card');
  });

  await check('reports a pillar name that will not fit its box', async () => {
    const record = base();
    record.capability_pillars[0].name = 'Digital Strategy, Experience and Service Design Practice';
    const { issues } = await render(record, { selection: FIVE });
    assert(issues.some((i) => /Pillar 1 name/.test(i.label)), `no fit issue raised: ${JSON.stringify(issues)}`);
  });

  await check('refuses a token the template has no icon for', async () => {
    // The icon vocabulary belongs to the template, not to the repository: a card
    // names an icon set and can resolve exactly the tokens in it. This used to
    // be reported by render() as an ordinary issue, so the deck was produced
    // anyway with the template's own artwork left in that position — wrong
    // content on a finished deck, which is the drift the CCR exists to end.
    const record = base();
    record.capability_pillars[0].icon_token = 'rocket';

    const issues = checkRecord(record, { selection: FIVE });
    const blocking = issues.filter((i) => i.blocking);
    assert(blocking.length === 1, `expected one blocking issue, got ${JSON.stringify(issues)}`);
    assert(/no icon for "rocket"/.test(blocking[0].message), `unhelpful refusal: ${blocking[0].message}`);
    assert(/target, product, cloud, brain, climb/.test(blocking[0].message), 'the refusal should name what it carries');

    let message = null;
    try { await render(record, { selection: FIVE }); } catch (e) { message = e.message; }
    assert(message && /rocket/.test(message), `render should refuse too, got: ${message}`);
  });

  await check('orders pillars by weight, not by array position', async () => {
    const record = base();
    record.capability_pillars = [...record.capability_pillars].reverse();
    const { buffer } = await render(record, { selection: FIVE });
    const { xml } = await slideText(buffer);
    const first = xml.indexOf('Digital Strategy and Experience');
    const last = xml.indexOf('Organizational Transformation');
    assert(first > 0 && last > 0, 'pillar names missing');
  });

  await check('a field filled to its character limit fits its box', () => {
    // The two limits have to agree, or the counter the marketer is shown is a
    // lie: a field typed up to maxChars must still fit maxLines.
    //
    // This used to measure `'W'.repeat(maxChars)`, described as the pathological
    // case — but that is a single unbreakable word, and `wrap()` puts a word
    // that fits nowhere on a line of its own rather than splitting it. So the
    // line count was always 1 and the assertion could not fail for any value of
    // maxChars. Made to wrap, it failed for two of the shipped slots, whose
    // limits were 8% and 7% over what their boxes actually hold.
    //
    // maxChars is a proxy for ordinary prose, which is what it is measured
    // against here. It is not a guarantee for every string — a line of capitals
    // is wider — and it is not meant to be: the width check on the real text is
    // what catches that, at generation time, per field.
    const PROSE = 'the capability transformation of enterprise delivery across modern platforms and teams ';
    const prose = (n) => PROSE.repeat(Math.ceil(n / PROSE.length) + 1).slice(0, n).trim();

    for (const blueprint of registry.all()) {
      const font = blueprint.layout.font;
      const walk = (contract, layout, prefix) => {
        for (const [name, slot] of Object.entries(contract)) {
          if (slot.kind === 'repeat') { walk(slot.slots, layout[name].slots, `${name}.`); continue; }
          if (slot.kind !== 'text') continue;
          const box = layout[name].box;
          const lines = fm.wrap(prose(slot.maxChars), {
            family: font.family, bold: box.bold, weight: font.weight,
            sizePt: box.sizePt, widthPt: box.widthIn * 72 * font.widthSafety,
          });
          assert(lines, `${font.family} metrics unavailable — see renderer/template/fonts/`);
          assert(
            lines.length <= slot.maxLines,
            `${blueprint.id} ${prefix}${name}: ${slot.maxChars} characters of ordinary prose wrap to ` +
            `${lines.length} lines but the box holds ${slot.maxLines}`
          );
        }
      };
      walk(blueprint.contract, blueprint.layout.slots, '');
    }
  });

  await check('shape names and geometry find the same shapes', async () => {
    // The card locates by shape name and falls back to vertical bands. Both
    // describe the same template, so both must produce the same file — that
    // equivalence is what lets a template arrive un-renamed without becoming a
    // second, subtly different rendering path.
    const blueprint = card.load('company-overview');
    const stripped = JSON.parse(fs.readFileSync(blueprint.file, 'utf8'));
    (function strip(o) {
      if (o && typeof o === 'object') { delete o.byName; Object.values(o).forEach(strip); }
    })(stripped);
    const geoCard = writeCard('geo', stripped, blueprint);

    const byName = await render(base(), { selection: FIVE });
    const byGeometry = await render(base(), { template: geoCard, selection: FIVE });
    fs.rmSync(geoCard, { force: true });

    const a = (await slideText(byName.buffer)).xml;
    const b = (await slideText(byGeometry.buffer)).xml;
    assert(a === b, 'locating by name and by geometry produced different slides');
  });

  await check('every slot is located by name, not by the geometry fallback', async () => {
    // The card asks for shapes by name and can fall back to bands. Asserting
    // the output is right does not distinguish the two, so a card typo or a
    // re-extracted template would degrade to geometry permanently and
    // invisibly. This asserts which strategy actually resolved each slot.
    const blueprint = card.load('company-overview');
    const zip = await require('jszip').loadAsync(fs.readFileSync(blueprint.pptxPath));
    const xml = await zip.file(blueprint.parts.slide).async('string');
    const { via } = slots.locate(xml, blueprint);

    const bands = Object.entries(via).filter(([, v]) => v !== 'name').map(([k]) => k);
    assert(!bands.length, `${bands.join(', ')} fell back to geometry — run "npm run name:slots"`);
    assert(Object.keys(via).length === 8, `expected 8 located slots, got ${Object.keys(via).join(', ')}`);
  });

  await check('a card asking for a name the template does not have is refused', async () => {
    const blueprint = card.load('company-overview');
    const typo = JSON.parse(fs.readFileSync(blueprint.file, 'utf8'));
    typo.layout.slots.positioning.find.byName = 'slot.positioning.TYPO';
    const file = writeCard('typo', typo, blueprint);

    let message = null;
    try { await render(base(), { template: file, selection: FIVE }); } catch (e) { message = e.message; }
    fs.rmSync(file, { force: true });
    assert(message, 'a card with a wrong shape name rendered anyway, through the fallback');
    assert(/slot.positioning.TYPO/.test(message), `the refusal should name what it looked for, got: ${message}`);
  });

  await check('a slot the layout cannot find is refused, not left blank', async () => {
    // `required` defaults to true precisely so that a card author who omits it
    // gets an error rather than a slide with a silently empty box.
    const blueprint = card.load('company-overview');
    const lost = JSON.parse(fs.readFileSync(blueprint.file, 'utf8'));
    delete lost.contract.title.required;
    lost.layout.slots.title.find = { else: { bandIn: 99, tag: 'p:sp' } };
    const file = writeCard('lost', lost, blueprint);

    let message = null;
    try { await render(base(), { template: file, selection: FIVE }); } catch (e) { message = e.message; }
    fs.rmSync(file, { force: true });
    assert(message, 'a slot that could not be found was silently skipped');
    assert(/could not find the shape for slot "title"/.test(message), `unhelpful refusal: ${message}`);
  });

  await check('a card with two repeating slots renders a valid package', async () => {
    // Both rows used to be flattened into one list and then filled twice over,
    // which produced overlapping edits and a package PowerPoint would refuse to
    // open — with render() reporting success. Here the same five shapes are
    // split across two repeating slots, so the output must be unchanged.
    const blueprint = card.load('company-overview');
    const two = JSON.parse(fs.readFileSync(blueprint.file, 'utf8'));
    const icon = two.contract.items.slots.icon;
    const iconLayout = two.layout.slots.items.slots.icon;
    delete two.contract.items.slots.icon;
    delete two.layout.slots.items.slots.icon;

    two.contract.badges = {
      kind: 'repeat', source: 'capability_pillars', labelPattern: 'Badge {n} {slot}',
      min: 3, max: 5, slots: { icon },
    };
    two.layout.slots.badges = { row: two.layout.slots.items.row, slots: { icon: iconLayout } };
    const file = writeCard('tworepeat', two, blueprint);

    const selection = { items: FIVE.items, badges: FIVE.items };
    const out = await renderAndValidate(base(), { template: file, selection });
    fs.rmSync(file, { force: true });
    assert(out.counts.items === 5 && out.counts.badges === 5, `wrong counts: ${JSON.stringify(out.counts)}`);
    assert(out.issues.length === 0, `unexpected issues: ${JSON.stringify(out.issues)}`);

    const split = (await slideText(out.buffer)).xml;
    const single = (await slideText((await render(base(), { selection: FIVE })).buffer)).xml;
    assert(split === single, 'splitting one row across two repeating slots changed the slide');
  });

  await check('the rendered slide is byte-for-byte what it was', async () => {
    // A golden hash over the slide part. Everything else in this file asserts a
    // property; this one asserts the whole artefact, which is the only way a
    // change in captureStyle, fillShape or the splice shows up as a failure
    // rather than as a slide nobody looked at.
    const { buffer } = await render(base(), { selection: FIVE });
    const { xml } = await slideText(buffer);
    const sha = require('crypto').createHash('sha256').update(xml).digest('hex');
    assert(
      sha === GOLDEN_SLIDE_SHA256,
      `the slide part changed: ${sha}\n` +
      '        If that was intended, look at the rendered deck, then update ' +
      'GOLDEN_SLIDE_SHA256 in test.js.'
    );
  });

  await check('refuses to render when the font cannot be measured', async () => {
    const blueprint = card.load('company-overview');
    const unmeasurable = JSON.parse(fs.readFileSync(blueprint.file, 'utf8'));
    unmeasurable.layout.font.family = 'NoSuchFontFamily';
    const file = writeCard('nofont', unmeasurable, blueprint);

    let message = null;
    try { await render(base(), { template: file, selection: FIVE }); } catch (e) { message = e.message; }
    const issues = checkRecord(base(), { template: file, selection: FIVE });
    fs.rmSync(file, { force: true });

    assert(message, 'a deck was produced with no way to check it for overflow');
    assert(/NoSuchFontFamily/.test(message), `the refusal should name the font, got: ${message}`);
    assert(issues.length === 1 && issues[0].blocking, 'preflight should report one blocking issue, not silence');
  });

  await check('a second card changes what is accepted, with no code change', async () => {
    // The whole point of phase 1: a template's limits are data. This card is
    // the same artwork with a different contract, and nothing in renderer/
    // knows it exists.
    const blueprint = card.load('company-overview');
    const variant = JSON.parse(fs.readFileSync(blueprint.file, 'utf8'));
    variant.id = 'company-overview-strict';
    variant.name = 'Strict variant';
    variant.contract.items.min = 2;
    variant.contract.items.slots.name.maxChars = 20;
    const file = writeCard('variant', variant, blueprint);

    const two = base();
    two.capability_pillars = two.capability_pillars.slice(0, 2);

    let shipped = null;
    try { await render(two); } catch (e) { shipped = e.message; }
    assert(shipped && /3–5/.test(shipped), `the shipped card should refuse 2 pillars, got: ${shipped}`);

    const { counts, issues, template } = await render(two, { template: file });
    fs.rmSync(file, { force: true });
    assert(template === 'company-overview-strict', `rendered the wrong template: ${template}`);
    assert(counts.items === 2, `expected 2 pillars, got ${counts.items}`);
    assert(
      issues.some((i) => /Pillar 1 name/.test(i.label) && /limit is 20/.test(i.message)),
      `the variant's tighter limit was not applied: ${JSON.stringify(issues)}`
    );
  });

  // ------------------------------------------------ unwelding phase 3: library

  await check('the template library is a directory, not a list', () => {
    // Adding a template is dropping two files in. Nothing enumerates them in
    // code, so this asserts the scan finds both shipped templates and that a
    // card whose id disagrees with its filename is refused rather than served
    // under a name nobody typed.
    const ids = registry.ids();
    assert(ids.includes('company-overview'), `company-overview missing from ${ids.join(', ')}`);
    assert(ids.includes('capability-columns'), `capability-columns missing from ${ids.join(', ')}`);
    assert(ids.includes('section-cover'), `section-cover missing from ${ids.join(', ')}`);
    assert(registry.broken().length === 0, `broken cards: ${JSON.stringify(registry.broken())}`);

    const stray = path.join(card.TEMPLATE_DIR, 'zz-test-stray.card.json');
    fs.writeFileSync(stray, JSON.stringify({ id: 'something-else', name: 'x' }));
    try {
      const { ok, broken } = registry.scan();
      assert(ok.length === ids.length, 'a broken card changed the usable list');
      assert(broken.length === 1 && /no pptx named/.test(broken[0].error), `unhelpful: ${JSON.stringify(broken)}`);
    } finally {
      fs.rmSync(stray, { force: true });
    }
  });

  await check('a second, genuinely different template renders with no code change', async () => {
    // Not the same artwork with a different contract — a different slide of the
    // source deck, with its own layout, its own master, no connectors, a four
    // column row that is not re-centred, and type set in Raleway Medium rather
    // than Regular. Nothing in renderer/*.js knows it exists.
    const record = base();
    const four = { items: [0, 2, 4, 5].map((i) => record.capability_pillars[i].key) };

    const out = await renderAndValidate(record, { template: 'capability-columns', selection: four });
    assert(out.counts.items === 4, `expected 4 columns, got ${out.counts.items}`);
    assert(out.issues.length === 0, `unexpected issues: ${JSON.stringify(out.issues)}`);

    const { text } = await slideText(out.buffer);
    assert(text.includes('Skilled Workforce Solutions'), 'the sixth pillar is missing from the four-column slide');
    assert(!text.includes('Product Development and Integration'), 'an unselected pillar appeared');

    // The two templates are genuinely different packages, not one with two cards.
    const a = card.load('company-overview');
    const b = card.load('capability-columns');
    assert(a.pptxPath !== b.pptxPath, 'both cards point at the same .pptx');
    assert(b.layout.font.weight === 'Medium', 'the second template should be measured in the weight it is set in');
    assert(b.layout.slots.items.row.recentre === false, 'the four-column row keeps the positions the designer chose');
  });

  await check('a card with no repeating slot needs no code at all', async () => {
    // The claim unwelding phase 1 made and could not support: adding a template
    // is two files. This one is a cover — different artwork, a different kind of
    // card, and the only contract it has is a title. It was added after every
    // line of this phase's code was written, and nothing in renderer/ moved.
    const blueprint = card.load('section-cover');
    assert(!Object.values(blueprint.contract).some((s) => s.kind === 'repeat'), 'the cover should have no repeating slot');

    const out = await renderAndValidate(base(), { template: 'section-cover' });
    assert(Object.keys(out.counts).length === 0, `a card with no repeat reported counts: ${JSON.stringify(out.counts)}`);
    assert(out.issues.length === 0, `unexpected issues: ${JSON.stringify(out.issues)}`);

    const { text } = await slideText(out.buffer);
    assert(text.includes('What We Do'), 'the cover does not carry the record title');

    // And it takes part in a deck beside templates that do repeat.
    const record = base();
    const deck = await renderDeck([
      { template: 'section-cover', record },
      { template: 'company-overview', record, selection: FIVE },
    ]);
    fs.writeFileSync(tmp, deck.buffer);
    const v = await validate(tmp);
    assert(v.errors.length === 0, `package invalid: ${v.errors.join('; ')}`);
    assert(deck.slides.length === 2, 'the cover did not make it into the deck');
  });

  await check('a square icon is fitted, not stretched, into a frame that is not square', async () => {
    // A <p:pic> with <a:stretch><a:fillRect/></a:stretch> scales its image to
    // the frame. The brand icons are square (96x96 viewBox) and the second
    // template's frames are not — one is 0.78 — so filling would come out 22%
    // narrow. No text check would ever catch that: it is only visible to
    // somebody looking at the deck.
    const record = base();
    const four = { items: [0, 2, 4, 5].map((i) => record.capability_pillars[i].key) };
    const { buffer } = await render(record, { template: 'capability-columns', selection: four });
    const { xml } = await slideText(buffer);

    const blueprint = card.load('capability-columns');
    const zip = await require('jszip').loadAsync(fs.readFileSync(blueprint.pptxPath));
    const before = slots.locate(await zip.file(blueprint.parts.slide).async('string'), blueprint);
    const drawn = before.repeats.items.items.map((position) => position.icon.frame);

    const rendered = childElements(xml, 'p:spTree')
      .filter((c) => /^slot\.items\.\d+\.icon$/.test(shapeName(c.xml)))
      .map((c) => shapeFrame(c.xml));
    assert(rendered.length === 4, `expected four icons, found ${rendered.length}`);

    let narrowed = 0;
    rendered.forEach((frame, i) => {
      assert(Math.abs(frame.cx / frame.cy - 1) < 0.005, `icon ${i + 1} is ${(frame.cx / frame.cy).toFixed(3)}, not square`);
      // Fitted *inside* what the designer drew — never larger, and centred.
      assert(frame.cx <= drawn[i].cx + 1 && frame.cy <= drawn[i].cy + 1, `icon ${i + 1} grew past its frame`);
      const centred = Math.abs((frame.x + frame.cx / 2) - (drawn[i].x + drawn[i].cx / 2)) <= 1
        && Math.abs((frame.y + frame.cy / 2) - (drawn[i].y + drawn[i].cy / 2)) <= 1;
      assert(centred, `icon ${i + 1} moved off the centre of its frame`);
      if (frame.cx < drawn[i].cx - 1 || frame.cy < drawn[i].cy - 1) narrowed++;
    });
    assert(narrowed > 0, 'nothing was fitted, so this test would pass with the feature removed');

    // And it is a no-op where the frame already matches: slide 4's icon frames
    // are square, which is why the golden hash still holds.
    const four4 = card.load('company-overview');
    const zip4 = await require('jszip').loadAsync(fs.readFileSync(four4.pptxPath));
    const drawn4 = slots.locate(await zip4.file(four4.parts.slide).async('string'), four4)
      .repeats.items.items.map((p) => p.icon.frame);
    for (const f of drawn4) assert(Math.abs(f.cx / f.cy - 1) < 0.005, 'slide 4 icon frames should be square');
  });

  await check('a template can hold what another refuses', async () => {
    // The whole point of a library: "choose a template that holds 6" stops
    // being advice with nowhere to go. Neither shipped template holds six —
    // this deck has none — so what is asserted is that the two answer
    // differently, and that matching says so in the record's own words.
    const record = base();
    const answers = Object.fromEntries(match.all(record).map((m) => [m.id, m]));

    assert(answers['company-overview'].holds.items.max === 5, 'slide 4 should hold five');
    assert(answers['capability-columns'].holds.items.max === 4, 'the four-column slide should hold four');
    for (const id of ['company-overview', 'capability-columns']) {
      assert(answers[id].status === 'needs-selection', `${id} should need a selection for a six-pillar record`);
      assert(answers[id].holds.items.have === 6, `${id} should report six items on the record`);
    }
    // A template with nothing repeating has nothing to choose, so it simply
    // fits — "needs-selection" is a statement about a repeating slot, not a
    // state every template passes through.
    assert(answers['section-cover'].status === 'fits', 'the cover should just fit');
    assert(!Object.keys(answers['section-cover'].holds).length, 'the cover holds no repeating slot');
  });

  await check('matching names a record key no template can be fed', async () => {
    // The gap unwelding phase 2 left: /ccr/record is assembled by hand for one
    // bundle, so a card asking for a key it does not publish cannot be fed.
    // That is still true. What changed is that it says so, by name, instead of
    // being an impossibility nobody could see.
    const blueprint = card.load('company-overview');
    const other = JSON.parse(fs.readFileSync(blueprint.file, 'utf8'));
    other.id = 'built-for-other-content';
    other.name = 'A template built for other content';
    other.contract.title.source = 'headline';
    const file = writeCard('headline', other, blueprint);

    const answer = match.one(base(), card.load(file));
    fs.rmSync(file, { force: true });

    assert(answer.status === 'refused', `expected a refusal, got ${answer.status}`);
    const message = answer.refusals.map((r) => r.message).join(' ');
    assert(/has no headline/.test(message), `should name the missing key: ${message}`);
    assert(/publishes .*capability_pillars/.test(message), `should name what the record does publish: ${message}`);
  });

  await check('a deck is several slides, each keeping its own artwork', async () => {
    const record = base();
    const keys = record.capability_pillars.map((p) => p.key);
    const { buffer, issues, slides } = await renderDeck([
      { template: 'company-overview', record, selection: { items: keys.slice(0, 5) } },
      { template: 'capability-columns', record, selection: { items: [keys[0], keys[2], keys[4], keys[5]] } },
    ]);
    fs.writeFileSync(tmp, buffer);
    const v = await validate(tmp);
    assert(v.errors.length === 0, `package invalid: ${v.errors.join('; ')}`);
    assert(issues.length === 0, `unexpected issues: ${JSON.stringify(issues)}`);
    assert(slides.length === 2, `expected two slides, got ${slides.length}`);

    const zip = await require('jszip').loadAsync(buffer);
    const parts = Object.keys(zip.files).filter((f) => !zip.files[f].dir);
    const count = (re) => parts.filter((p) => re.test(p)).length;
    assert(count(/^ppt\/slides\/slide\d+\.xml$/) === 2, 'expected two slide parts');
    // Its own layout, master and theme apiece: the slides did not merge into
    // one another's design on the way into the package.
    assert(count(/^ppt\/slideLayouts\/slideLayout\d+\.xml$/) === 2, 'expected two layouts');
    assert(count(/^ppt\/slideMasters\/slideMaster\d+\.xml$/) === 2, 'expected two masters');

    for (const [n, expected] of [[1, 'slideLayout1'], [2, 'slideLayout2']]) {
      const rels = await zip.file(`ppt/slides/_rels/slide${n}.xml.rels`).async('string');
      assert(rels.includes(expected), `slide ${n} does not point at ${expected}`);
    }
  });

  await check('a deck does not carry the same media twice', async () => {
    // The background photograph and its HD Photo backup are 2.5 MB of the
    // company-overview template and they live on the layout, so four slides
    // from it would be four copies without content-hash dedupe.
    const record = base();
    const selection = { items: record.capability_pillars.slice(0, 5).map((p) => p.key) };
    const entry = { template: 'company-overview', record, selection };

    const one = await render(record, { selection });
    const four = await renderDeck([entry, entry, entry, entry]);
    const grown = four.buffer.length - one.buffer.length;

    assert(
      grown < 200 * 1024,
      `four slides cost ${(grown / 1024).toFixed(0)} KB more than one; media is being carried more than once`
    );
    fs.writeFileSync(tmp, four.buffer);
    const v = await validate(tmp);
    assert(v.errors.length === 0, `package invalid: ${v.errors.join('; ')}`);
  });

  await check('the package checker catches collisions a single slide cannot have', async () => {
    // Every one of these produces a file that passes the four structural checks
    // and still makes PowerPoint offer to repair it. The master/layout id case
    // is not hypothetical: it shipped, and PowerPoint titled the window
    // "deck - Repaired" while validate.js called the file clean.
    const record = base();
    const keys = record.capability_pillars.map((p) => p.key);
    const { buffer } = await renderDeck([
      { template: 'company-overview', record, selection: { items: keys.slice(0, 5) } },
      { template: 'capability-columns', record, selection: { items: [keys[0], keys[2], keys[4], keys[5]] } },
    ]);

    const JSZip = require('jszip');
    const mutate = async (label, fn) => {
      const zip = await JSZip.loadAsync(buffer);
      await fn(zip);
      fs.writeFileSync(tmp, await zip.generateAsync({ type: 'nodebuffer' }));
      const v = await validate(tmp);
      assert(v.errors.length > 0, `${label} was not caught`);
      return v.errors[0];
    };

    await mutate('two slides with the same sldId', async (zip) => {
      const pres = await zip.file('ppt/presentation.xml').async('string');
      zip.file('ppt/presentation.xml', pres.replace('<p:sldId id="257"', '<p:sldId id="256"'));
    });
    await mutate('a master id equal to a layout id', async (zip) => {
      const master = await zip.file('ppt/slideMasters/slideMaster1.xml').async('string');
      const pres = await zip.file('ppt/presentation.xml').async('string');
      const masterId = /<p:sldMasterId id="(\d+)"/.exec(pres)[1];
      zip.file('ppt/slideMasters/slideMaster1.xml', master.replace(/<p:sldLayoutId id="\d+"/, `<p:sldLayoutId id="${masterId}"`));
    });
    await mutate('two shapes with the same id on one slide', async (zip) => {
      const slide = await zip.file('ppt/slides/slide1.xml').async('string');
      const ids = [...slide.matchAll(/<p:cNvPr id="(\d+)"/g)].map((m) => m[1]);
      zip.file('ppt/slides/slide1.xml', slide.replace(`<p:cNvPr id="${ids[2]}"`, `<p:cNvPr id="${ids[1]}"`));
    });
    await mutate('a duplicated content-type override', async (zip) => {
      const ct = await zip.file('[Content_Types].xml').async('string');
      zip.file('[Content_Types].xml', ct.replace('</Types>', '<Override PartName="/ppt/slides/slide1.xml" ContentType="x"/></Types>'));
    });
    await mutate('two entries in the running order pointing at one slide', async (zip) => {
      const rels = await zip.file('ppt/_rels/presentation.xml.rels').async('string');
      zip.file('ppt/_rels/presentation.xml.rels', rels.replace('Target="slides/slide2.xml"', 'Target="slides/slide1.xml"'));
    });
  });

  await check('a selection names items, and is refused when it cannot', async () => {
    const record = base();
    const keys = record.capability_pillars.map((p) => p.key);
    const refuse = async (label, selection, pattern) => {
      let message = null;
      try { await render(record, { selection }); } catch (e) { message = e.message; }
      assert(message, `${label} was accepted`);
      assert(pattern.test(message), `${label}: unhelpful refusal: ${message}`);
    };

    await refuse('a key the record no longer has',
      { items: [keys[0], keys[1], keys[2], keys[3], 'deleted-pillar'] }, /no longer has: deleted-pillar/);
    await refuse('the same key twice',
      { items: [keys[0], keys[0], keys[1], keys[2]] }, /names "[^"]+" twice/);
    await refuse('a slot this template does not repeat',
      { columns: [keys[0]] }, /does not repeat/);
    await refuse('an empty selection', { items: [] }, /a slide with no items/);

    // Order is the deck's, not the record's. Asserted by position on the slide
    // rather than by position in the XML: the shapes appear in the source
    // deck's own order, so document order says nothing about what a reader
    // sees. The first selected item belongs in the leftmost column.
    const reversed = { items: keys.slice(0, 5).reverse() };
    const { buffer } = await render(record, { selection: reversed });
    const { xml } = await slideText(buffer);
    const columns = childElements(xml, 'p:spTree')
      .filter((c) => /^slot\.items\.\d+\.name$/.test(shapeName(c.xml)))
      .map((c) => ({ x: shapeFrame(c.xml).x, text: shapeText(c.xml) }))
      .sort((a, b) => a.x - b.x);
    assert(columns.length === 5, `expected five name shapes, found ${columns.length}`);
    assert(
      columns[0].text === 'Organizational Transformation',
      `leftmost column is "${columns[0].text}"; the selection order was not honoured`
    );
    assert(
      columns[4].text === 'Digital Strategy and Experience',
      `rightmost column is "${columns[4].text}"; the selection order was not honoured`
    );
  });

  await check('a row must declare an axis, and an unimplemented one is refused', () => {
    // The model used to carry a pitch and a centre with no axis while the mover
    // only moved x, so a card describing a stacked row was accepted and then
    // laid out sideways. `y` is declared and refused by name rather than
    // implemented: no template in this library has a vertical row, and a mover
    // with no caller is the untested generality this phase declined to ship.
    const blueprint = card.load('company-overview');
    const vertical = JSON.parse(fs.readFileSync(blueprint.file, 'utf8'));
    vertical.layout.slots.items.row.axis = 'y';
    const file = writeCard('vertical', vertical, blueprint);

    let message = null;
    try { card.load(file); } catch (e) { message = e.message; }
    fs.rmSync(file, { force: true });
    assert(message, 'a vertical row was accepted by a renderer that cannot lay one out');
    assert(/vertical rows are not implemented/.test(message), `unhelpful: ${message}`);
    assert(/setShapeX/.test(message), `should name where the mover goes: ${message}`);

    assert(card.load('company-overview').layout.slots.items.row.axis === 'x', 'the shipped card should declare its axis');
  });

  await check('the card\'s row geometry matches where the artwork actually is', async () => {
    // A card whose pitchIn or centreIn is wrong still renders — every shape is
    // simply moved to the wrong place, consistently, and the deck looks subtly
    // off rather than broken. Measuring how far re-centring moves things is the
    // only way to see that, so the shipped card's displacement is pinned.
    const blueprint = card.load('company-overview');
    const zip = await require('jszip').loadAsync(fs.readFileSync(blueprint.pptxPath));
    const xml = await zip.file(blueprint.parts.slide).async('string');
    const found = slots.locate(xml, blueprint);
    const rowSpec = blueprint.layout.slots.items.row;

    for (const child of ['icon', 'name', 'description']) {
      const shapes = found.repeats.items.items.map((position) => position[child]);
      const moved = row.snapDisplacementIn(shapes, rowSpec);
      assert(moved < 0.03, `${child} moves ${moved.toFixed(3)} in when re-centred; the card's pitch disagrees with the artwork`);
    }
    // The connector arrows are hand-placed and the largest correction the card
    // makes. Pinned rather than tightened: this is what the shipped deck does.
    const moved = row.snapDisplacementIn(found.repeats.items.connectors, rowSpec);
    assert(moved < 0.2, `connectors move ${moved.toFixed(3)} in, which is more than this template has ever needed`);
  });

  await check('the rich text parser keeps only emphasis', () => {
    const parsed = richtext.parse('a <script>x</script><strong>b</strong> <span class="q">c</span>');
    const flat = parsed[0].map((r) => `${r.emphasis ? '*' : ''}${r.text}`).join('');
    assert(flat === 'a x*b c', `unexpected parse: ${flat}`);
  });

  // ---- the writing assistant ------------------------------------------------
  // A stub stands in for the model throughout: it answers from a script and
  // keeps what it was asked. What is under test is the loop around the model —
  // that nothing reaches an editor unmeasured — and that needs no network.
  const scripted = (...answers) => {
    const asked = [];
    const complete = async (prompt) => { asked.push(prompt); return answers[Math.min(asked.length, answers.length) - 1]; };
    return { complete, asked };
  };
  const LONG = 'Design, prototype, test and continuously optimize digital experiences faster with AI-driven <strong>insight</strong>, automation and analytics across every channel.';
  const FITS = 'Design and optimize experiences faster with AI-driven <strong>insight</strong>.';

  await check('the writer finds a box by the record\'s name for it, never the template\'s', () => {
    const blueprint = card.load('company-overview');
    const description = writer.target(blueprint, 'capability_pillars.description');
    assert(description.slot.maxChars === 80 && description.box.widthIn === 2.144, 'the pillar description resolved to the wrong box');
    assert(description.label === 'Pillar description', `unexpected label: ${description.label}`);
    assert(writer.target(blueprint, 'positioning_statement').slot.maxLines === 2, 'the positioning statement resolved to the wrong box');

    let refusal = '';
    try { writer.target(blueprint, 'items.description'); } catch (e) { refusal = e.message; }
    assert(/capability_pillars\.description/.test(refusal), `a slot name should be refused by naming the record keys: ${refusal}`);
  });

  await check('a suggestion that fits is offered, with only emphasis left in it', async () => {
    const model = scripted(`<p>Design and optimize experiences faster with <span style="color:red">AI-driven</span> <em>insight</em>.</p>`);
    const out = await writer.shorten({
      card: card.load('company-overview'), source: 'capability_pillars.description', value: LONG, complete: model.complete,
    });
    assert(out.ok === true && out.attempts === 1, `expected one accepted attempt: ${JSON.stringify(out)}`);
    assert(out.suggestion === FITS, `markup other than emphasis survived: ${out.suggestion}`);
    assert(out.after.chars <= 80 && out.after.lines <= 4, `offered something that does not fit: ${JSON.stringify(out.after)}`);
    assert(out.before.chars > 80, 'the report should say what the original came to');
    assert(/at most 80 characters/.test(model.asked[0].user), 'the model was not told the template\'s limit');
  });

  await check('a suggestion that does not fit is measured, withheld, and sent back with what the box said', async () => {
    const tooLong = 'Design, prototype and optimize digital experiences much faster with AI-driven <strong>insight</strong>.';
    const model = scripted(tooLong, FITS);
    const out = await writer.shorten({
      card: card.load('company-overview'), source: 'capability_pillars.description', value: LONG, complete: model.complete,
    });
    assert(out.ok === true && out.attempts === 2, `expected the second attempt to be the one offered: ${JSON.stringify(out)}`);
    assert(out.suggestion === FITS, 'the attempt that did not fit was offered');
    assert(model.asked[1].user.includes(tooLong), 'the second ask did not show the model its failed attempt');
    assert(/characters, limit is 80/.test(model.asked[1].user), 'the second ask did not say what the measurement was');
  });

  await check('when nothing fits, nothing is offered', async () => {
    const model = scripted(LONG);
    const out = await writer.shorten({
      card: card.load('company-overview'), source: 'capability_pillars.description', value: LONG, complete: model.complete,
    });
    assert(out.ok === false && !('suggestion' in out), `a near miss was offered: ${JSON.stringify(out)}`);
    assert(model.asked.length === 3, `expected three asks, made ${model.asked.length}`);
    assert(/none is offered/.test(out.reason), `the refusal should say so plainly: ${out.reason}`);
  });

  await check('a width a character count cannot see is still caught', async () => {
    // 36 characters, inside the pillar name's limit — and far too wide for it.
    const wide = 'WWWWWWWWW WWWWWWWWW WWWWWWWWW WWWWWW';
    assert(wide.length <= 36, 'the test string should be inside the character limit');
    const model = scripted(wide, 'Digital Strategy');
    const out = await writer.shorten({
      card: card.load('company-overview'), source: 'capability_pillars.name',
      value: 'Digital Strategy, Customer Experience and Service Design', complete: model.complete,
    });
    assert(out.ok === true && out.attempts === 2, `the wide string should have been refused by the box, not the count: ${JSON.stringify(out)}`);
    assert(/wraps to \d+ lines, the box holds 2/.test(model.asked[1].user), 'the model was not told it was the width that failed');
  });

  await check('a plain field is handed plain text, and text that already fits asks nobody', async () => {
    const model = scripted('<strong>Radiant</strong> AI Fabric');
    const out = await writer.shorten({
      card: card.load('company-overview'), source: 'framework_name',
      value: 'Radiant’s AI Fabric for Intelligent Enterprise Transformation', complete: model.complete,
    });
    assert(out.ok === true && out.suggestion === 'Radiant AI Fabric', `a tag reached a plain string field: ${out.suggestion}`);

    const idle = scripted('should never be asked');
    const fits = await writer.shorten({
      card: card.load('company-overview'), source: 'framework_name', value: 'Radiant’s AI Fabric', complete: idle.complete,
    });
    assert(fits.ok === false && /already fits/.test(fits.reason), `expected "already fits": ${JSON.stringify(fits)}`);
    assert(idle.asked.length === 0, 'the model was asked about text that already fits');
  });

  await check('without a key the assistant says it is not set up, and says how to fix that', async () => {
    const saved = { key: process.env.ANTHROPIC_API_KEY, token: process.env.ANTHROPIC_AUTH_TOKEN };
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_AUTH_TOKEN;
    try {
      assert(llm.available() === false, 'available() should be false with no credential in the environment');
      let refusal = null;
      try { await llm.complete({ system: '', user: '' }); } catch (e) { refusal = e; }
      assert(refusal instanceof llm.LlmError, 'expected an LlmError, which the service turns into a sentence for the editor');
      assert(/renderer\/\.env/.test(refusal.message), `the refusal should say where the key goes: ${refusal?.message}`);
    } finally {
      if (saved.key !== undefined) process.env.ANTHROPIC_API_KEY = saved.key;
      if (saved.token !== undefined) process.env.ANTHROPIC_AUTH_TOKEN = saved.token;
    }
  });

  // ---- written channels: plan.md §8 A2 ------------------------------------

  const CASE = () => JSON.parse(fs.readFileSync(path.resolve(__dirname, '../fixtures/case-study.json'), 'utf8'));
  const SLIDE_COPY = () => JSON.parse(fs.readFileSync(path.resolve(__dirname, '../fixtures/case-study.slide-copy.json'), 'utf8'));

  await check('a case study slide keeps its headings, trims its table and matches its result boxes', async () => {
    const copy = SLIDE_COPY();
    copy.solutions = copy.solutions.slice(0, 4);
    const out = await renderAndValidate(copy, { template: 'case-study-metrics' });
    const { xml, text } = await slideText(out.buffer);

    // The fixed headings sit in the same boxes as the text under them.
    assert(/The Problem\|Dispatch ran on/.test(text), `"The Problem" heading lost or moved: ${text.slice(0, 200)}`);
    assert(/Our Client\|Kestrelmoor Freight Cooperative is/.test(text), '"Our Client" heading lost or moved');
    assert(!text.includes('Newfold'), 'the template\'s own client text survived');
    assert(!/\serr="1"/.test(xml), 'the source slide\'s spell-check flags were cloned onto new text');

    // Four solution rows, and a frame exactly four rows tall.
    const table = /<p:graphicFrame>[\s\S]*?<\/p:graphicFrame>/.exec(xml)[0];
    const rows = [...table.matchAll(/<a:tr\b[^>]*\bh="(\d+)"/g)];
    assert(rows.length === 4, `expected 4 table rows, got ${rows.length}`);
    const tall = rows.reduce((n, r) => n + Number(r[1]), 0);
    assert(shapeFrame(table).cy === tall, `table frame is ${shapeFrame(table).cy} EMU tall for ${tall} EMU of rows`);

    // Every result box a bold figure and a regular label — including the one
    // the artwork typed as a single bold run.
    for (let n = 1; n <= 4; n++) {
      const box = childElements(xml, 'p:spTree').find((c) => shapeName(c.xml) === `slot.metrics.${n}.text`).xml;
      const runs = [...box.matchAll(/<a:rPr\b[^>]*>/g)].map((m) => m[0]);
      assert(runs.length === 2 && /\bb="1"/.test(runs[0]) && /\bb="0"/.test(runs[1]), `result ${n} is not figure + label: ${runs.join(' ')}`);
      assert(runs.every((r) => (r.match(/\sb="/g) || []).length === 1), `result ${n} declares bold twice`);
    }
  });

  await check('a written slide refuses copy that does not fit, where a record-driven one only warns', async () => {
    const copy = SLIDE_COPY();
    copy.client_summary = `${copy.client_summary} ${copy.client_summary}`;
    let refusal = null;
    try { await render(copy, { template: 'case-study-metrics' }); } catch (e) { refusal = e; }
    assert(refusal && /Our Client/.test(refusal.message), `expected a refusal naming the box: ${refusal?.message}`);
  });

  await check('a template is offered only to the kind of record it draws on', () => {
    const overview = match.all(base()).map((t) => t.id);
    assert(!overview.includes('case-study-metrics'), 'the company overview was offered the case study slide');
    const cs = match.all(CASE()).map((t) => t.id);
    assert(cs.length === 1 && cs[0] === 'case-study-metrics', `the case study was offered ${cs.join(', ')}`);
  });

  await check('a number the source does not state is a problem; a name it does not contain is a warning', () => {
    const facts = require('./lib/facts');
    const record = CASE();
    const source = `${record.title}\n${record.client_name}\n${record.source_material}`;
    assert(facts.check('<strong>75% reduction</strong> in dispatch time', source).problems.length > 0, 'a rounded 74% went through');
    assert(facts.check('1,400 carriers in nine states', source).problems.length === 0, '"1,400" and "nine" are both in the source');
    assert(facts.check('12 dispatchers', source).problems.length === 0, 'the source says "twelve dispatchers"; digits and words should agree');
    const named = facts.check('Built with Acme Logistics', source);
    assert(named.problems.length === 0 && /Acme/.test(named.warnings[0] || ''), `expected a name warning: ${JSON.stringify(named)}`);
    for (const [key, value] of Object.entries(SLIDE_COPY())) {
      const lines = Array.isArray(value) ? value.map((v) => v.name || v.text) : [value];
      for (const line of lines) {
        const r = facts.check(line, source, 'Case Study');
        assert(!r.problems.length && !r.warnings.length, `hand-written ${key} flagged: ${JSON.stringify(r)}`);
      }
    }
  });

  /** A model that answers each ask from a script, and records what it was asked. */
  const drafting = (...answers) => {
    const asked = [];
    return { asked, complete: async (req) => { asked.push(req); return answers[Math.min(asked.length - 1, answers.length - 1)]; } };
  };
  const slideAnswer = () => {
    const c = SLIDE_COPY();
    return {
      headline: c.headline, solution_name: c.solution_name, client_summary: c.client_summary,
      problem: richtext.parse(c.problem).map((p) => p.map((r) => r.text).join('')),
      solutions: c.solutions.map((s) => ({ name: s.name })),
      metrics: c.metrics.map((m) => ({ text: m.text })),
    };
  };

  await check('a draft that passes is returned whole, with keys and order the slide can render', async () => {
    const model = drafting(slideAnswer());
    const channel = writer.channelOfCard(card.load('case-study-metrics'));
    const out = await writer.draft({ channel, record: CASE(), complete: model.complete });
    assert(out.ok && model.asked.length === 1, `expected one ask and a pass: ${JSON.stringify(out.fields)}`);
    assert(/^<p>.*<\/p><p>.*<\/p>$/.test(out.copy.problem), `two paragraphs should come back as two <p>: ${out.copy.problem}`);
    assert(out.copy.metrics[0].key === 'metrics-1' && out.copy.metrics[0].weight === 1, 'repeating items need a key and an order');
    assert(out.warnings.length === 1 && /Newfold/.test(out.warnings[0]), 'the placeholder artwork should be said out loud');
    assert(/<source_material>[\s\S]*Kestrelmoor[\s\S]*<\/source_material>/.test(model.asked[0].user), 'the source material was not sent');
    await renderAndValidate(out.copy, { template: 'case-study-metrics' });
  });

  await check('a field with an invented number goes back alone, with what was wrong, and a miss is never returned', async () => {
    const first = slideAnswer();
    first.metrics[0].text = '<strong>75% reduction</strong> in time to place a load';
    const second = { metrics: slideAnswer().metrics };
    const model = drafting(first, second);
    const out = await writer.draft({ channel: writer.channelOfCard(card.load('case-study-metrics')), record: CASE(), complete: model.complete });
    assert(out.ok && model.asked.length === 2, `expected a retry that passes: ${JSON.stringify(out.fields.metrics)}`);
    assert(Object.keys(model.asked[1].schema.properties).join() === 'metrics', `only the failed field should be asked again: ${Object.keys(model.asked[1].schema.properties)}`);
    assert(/75 is not in the source material/.test(model.asked[1].user), 'the retry did not say what was wrong');

    const stubborn = drafting(first);
    const miss = await writer.draft({ channel: writer.channelOfCard(card.load('case-study-metrics')), record: CASE(), complete: stubborn.complete });
    assert(!miss.ok && stubborn.asked.length === 3, `expected three asks and a failure: ${stubborn.asked.length}`);
    assert(!('metrics' in miss.copy) && miss.fields.metrics.status === 'failed', 'a field that never passed was returned');
    assert('headline' in miss.copy, 'fields that passed should still be returned');
  });

  await check('a web contract is measured in characters, because a page has no box', async () => {
    const channel = writer.channelOfContract({
      id: 'web', name: 'Web page',
      contract: { headline: { kind: 'text', source: 'headline', label: 'Headline', brief: 'The headline.', maxChars: 20, emphasis: false } },
    });
    const check_ = writer.checkCopy({ channel, copy: { headline: 'Dispatch in twelve minutes, not 47' }, record: CASE() });
    assert(!check_.ok && /characters, limit is 20/.test(check_.fields.headline.problems[0]), JSON.stringify(check_));
    const ok = writer.checkCopy({ channel, copy: { headline: 'Dispatch, modernized' }, record: CASE() });
    assert(ok.ok, JSON.stringify(ok));
  });

  fs.rmSync(tmp, { force: true });
  for (const [status, name] of results) console.log(`${status === 'pass' ? '  ok' : 'FAIL'}  ${name}`);
  console.log(`\n${results.length - failures}/${results.length} passed`);
  process.exit(failures ? 1 : 0);
}

main();
