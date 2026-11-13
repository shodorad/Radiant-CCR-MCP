#!/usr/bin/env node
/**
 * Render from the command line.
 *
 *   node cli.js --fixture ../fixtures/company-overview.json --out out/deck.pptx
 *   node cli.js --ccr --out out/deck.pptx
 *   node cli.js --template capability-columns --ccr
 *   node cli.js --select items=digital-strategy,cloud-transformation,organizational-transformation
 *   node cli.js --deck ../fixtures/deck.json --out out/deck.pptx
 *
 * `--deck` takes a deck definition — an ordered list of (template, selection),
 * against one record — and produces one .pptx from several filled slides. It is
 * the same shape the CCR POSTs to /deck, so a deck can be reproduced here
 * without Drupal, which is what makes the assembly testable.
 *
 * The fixture path exists so the renderer stays testable with no Drupal running
 * (plan.md phase 3 acceptance criteria).
 */
const fs = require('fs');
const path = require('path');
const { render, renderDeck } = require('./render');
const source = require('./lib/source');

function parseArgs(argv) {
  const args = { out: 'out/company-overview.pptx' };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--fixture') args.fixture = argv[++i];
    else if (a === '--deck') args.deck = argv[++i];
    else if (a === '--ccr') args.ccr = true;
    else if (a === '--url') { args.ccr = true; args.url = argv[++i]; }
    else if (a === '--out') args.out = argv[++i];
    else if (a === '--template') args.template = argv[++i];
    else if (a === '--select') args.select = argv[++i];
    else if (a === '--strict') args.strict = true;
    else if (a === '--json') args.json = true;
    else { console.error(`unknown argument: ${a}`); process.exit(2); }
  }
  if (!args.fixture && !args.ccr) args.fixture = path.resolve(__dirname, '../fixtures/company-overview.json');

  // `--select items=a,b,c` — which items of a repeating slot this slide shows,
  // in order, by the record's own keys. The record holds more capability
  // pillars than any template does, so choosing is not an advanced option: it
  // is how you render one slide of it. Same shape as a deck entry's selection.
  if (args.select) {
    args.selection = {};
    for (const part of args.select.split(';')) {
      const [slot, keys] = part.split('=');
      if (!slot || !keys) {
        console.error(`--select wants slot=key,key — got "${part}"`);
        process.exit(2);
      }
      args.selection[slot.trim()] = keys.split(',').map((k) => k.trim()).filter(Boolean);
    }
  }
  return args;
}

const report = (issues) => {
  if (issues.length) {
    console.log(`\n${issues.length} fit issue${issues.length === 1 ? '' : 's'}:`);
    for (const i of issues) {
      console.log(`  ${i.severity === 'error' ? '✗' : '!'}${i.slide ? ` slide ${i.slide}` : ''} ${i.label}: ${i.message}`);
    }
  } else {
    console.log('fit       every slide-bound field fits its box');
  }
};

async function main() {
  const args = parseArgs(process.argv);
  fs.mkdirSync(path.dirname(path.resolve(args.out)), { recursive: true });

  if (args.deck) {
    const definition = JSON.parse(fs.readFileSync(args.deck, 'utf8'));
    const shared = definition.record
      ? definition.record
      : args.ccr
        ? await source.fromCCR({ baseUrl: args.url })
        : JSON.parse(fs.readFileSync(args.fixture, 'utf8'));

    const entries = definition.entries.map((entry) => ({
      template: entry.template,
      selection: entry.selection,
      record: entry.record ?? shared,
    }));

    const { buffer, issues, slides } = await renderDeck(entries);
    fs.writeFileSync(args.out, buffer);

    if (args.json) {
      console.log(JSON.stringify({ out: args.out, bytes: buffer.length, slides, issues }, null, 2));
    } else {
      console.log(`deck      ${path.relative(process.cwd(), args.deck)}`);
      for (const s of slides) console.log(`slide ${s.slide}   ${s.template}  ${JSON.stringify(s.counts)}`);
      console.log(`written   ${args.out}  ${(buffer.length / 1024).toFixed(0)} KB`);
      report(issues);
    }
    if (args.strict && issues.some((i) => i.severity === 'error')) process.exit(1);
    return;
  }

  const record = args.ccr
    ? await source.fromCCR({ baseUrl: args.url, template: args.template })
    : source.fromFixture(args.fixture, { template: args.template });

  const { buffer, issues, counts, template } = await render(record, {
    template: args.template,
    selection: args.selection,
  });
  fs.writeFileSync(args.out, buffer);

  if (args.json) {
    console.log(JSON.stringify({ out: args.out, template, bytes: buffer.length, counts, issues }, null, 2));
  } else {
    console.log(`source    ${args.ccr ? 'CCR' : `fixture ${path.relative(process.cwd(), args.fixture)}`}`);
    console.log(`template  ${template}`);
    for (const [slot, n] of Object.entries(counts)) console.log(`${slot.padEnd(10)}${n}`);
    console.log(`written   ${args.out}  ${(buffer.length / 1024).toFixed(0)} KB`);
    report(issues);
  }
  if (args.strict && issues.some((i) => i.severity === 'error')) process.exit(1);
}

main().catch((e) => { console.error(`\n${e.message}\n`); process.exit(1); });
