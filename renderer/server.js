#!/usr/bin/env node
/**
 * The renderer as a service — the second channel hanging off the CCR.
 *
 * Deliberately thin. It owns no content and no brand decisions; it fetches a
 * record, fills the template and hands back a .pptx. That is the point of H2:
 * a channel attaches to the repository, the repository knows nothing about it.
 *
 *   GET  /health             the service, and the templates it can fill
 *   GET  /render[?nid=N]     fetch from the CCR and download one slide
 *   POST /render             render a record supplied in the body (used by tests)
 *   GET  /preflight[?nid=N]  fit report only, no file — what the CCR shows the editor
 *   POST /match              which templates can show this record, and why not
 *   POST /values             the lines this template puts on a slide, for drift
 *   POST /deck               an ordered list of (template, record, selection) -> one .pptx
 *   POST /suggest            a shorter version of one line, measured before it is offered
 *   POST /draft              every field of a written channel, from source material
 *   POST /copy/check         measure edited copy against its channel — no model involved
 *
 * `/render` makes one slide from one template. `/deck` makes a presentation out
 * of several, which is what the CCR's Generate button posts: the deck definition
 * lives in the repository, because a deck is a thing somebody decided on and
 * expects to be able to rebuild, not a shape the renderer invents each time.
 *
 * `/suggest` is the only route that involves a language model, and the only one
 * that can be missing: without a key it answers "not set up" and `/health`
 * reports `ai.available: false`, which is what the CCR reads before it offers
 * anybody a button. It writes words and never a slide — see lib/writer.js.
 *
 * Every single-slide route takes an optional `?template=<card id>`, checked
 * against the ids the template directory holds.
 *
 * No auth: the renderer trusts the CCR and the CCR trusts the renderer. That is
 * a stated POC shortcut (plan.md §4).
 */
const http = require('http');
const { render, renderDeck, checkRecord, DEFAULT_TEMPLATE } = require('./render');
const card = require('./lib/card');
const registry = require('./lib/registry');
const match = require('./lib/match');
const select = require('./lib/select');
const source = require('./lib/source');
const values = require('./lib/values');
const log = require('./lib/generation-log');
const writer = require('./lib/writer');
const llm = require('./lib/llm');

const PORT = Number(process.env.PORT || 5001);
const CCR_BASE_URL = process.env.CCR_BASE_URL || source.DEFAULT_CCR;

const json = (res, status, body) => {
  const payload = JSON.stringify(body, null, 2);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload), 'Access-Control-Allow-Origin': '*' });
  res.end(payload);
};

const readBody = (req) =>
  new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => {
      chunks.push(c);
      if (chunks.reduce((n, b) => n + b.length, 0) > 1e6) reject(new Error('request body too large'));
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });

/**
 * A card id from the query string, or a refusal naming what the library has.
 *
 * `card.load` will happily resolve a path, and this value comes straight off the
 * query string — so it is checked against the ids the template directory holds
 * rather than passed through. `registry.get` throws the refusal; this only has
 * to supply the default.
 */
function resolveTemplate(requested) {
  if (!requested) return DEFAULT_TEMPLATE;
  return registry.get(requested).id;
}

const filename = (record, title) =>
  `${(title || record?.title || 'company-overview').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}.pptx`;

/**
 * @returns {Promise<{record: object, selfDriven: boolean}>}
 *
 * `selfDriven` says who started this generation, which decides who logs it.
 * A record posted in the body means the CCR drove it — the CCR is holding the
 * node and will write its own log row. A GET means the renderer fetched the
 * record itself, so nothing else knows this deck exists and the renderer has to
 * say so. Getting this wrong logs one button press twice.
 *
 * Both branches check the record against the card. The POST branch used not to,
 * which was the worst possible place to skip it: POST is the branch the CCR's
 * own "Generate deck" button uses, so the one path a marketer actually takes
 * was the one path with no check on it. A record with an empty field went
 * straight through to a 200 and a deck with blank boxes.
 */
async function loadRecord(req, url, template) {
  if (req.method === 'POST') {
    const body = await readBody(req);
    if (!body.length) throw new Error(`POST ${url.pathname} needs a content record in the body`);
    const posted = JSON.parse(body.toString('utf8'));

    // Either a bare record, or `{ record, selection }`. The bare form is what
    // every caller sent before decks existed and it still works.
    const record = posted.record ?? posted;
    const selection = posted.record ? posted.selection : undefined;
    const blueprint = card.load(template);
    // Checked against the items this deck actually uses: a pillar with an empty
    // description that no slide selects is not a reason to refuse.
    source.checkAgainstCard(record, blueprint, 'the request body', select.rows(record, blueprint, selection));
    return { record, selection, selfDriven: false };
  }
  return {
    record: await source.fromCCR({
      baseUrl: CCR_BASE_URL,
      nid: url.searchParams.get('nid') || undefined,
      template,
    }),
    selfDriven: true,
  };
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const started = Date.now();

  try {
    // Only ids the template directory actually holds. `card.load` would happily
    // resolve a path, and this parameter comes straight off the query string.
    const template = resolveTemplate(url.searchParams.get('template'));

    if (url.pathname === '/health') {
      // The contract, not the layout: what a template will accept is the half a
      // caller can act on, and the half the CCR would drive a form from.
      const { ok, broken } = registry.scan();
      const templates = ok.map((c) => ({
        id: c.id, name: c.name, provenance: c.provenance ?? null, contract: c.contract,
        record: c.record ?? null, written: Boolean(c.written), brief: c.brief ?? null, placeholderArt: c.placeholderArt ?? null,
      }));
      // A card that is present but unusable is reported rather than omitted. A
      // library that silently drops what it cannot read looks identical to a
      // library that was never given the file.
      return json(res, 200, {
        ok: true, ccr: CCR_BASE_URL, default: DEFAULT_TEMPLATE, templates, broken,
        ai: { available: llm.available(), model: llm.MODEL },
      });
    }

    if (url.pathname === '/suggest') {
      // The record's own name for the field, and the text as the editor has it
      // now — unsaved, which is why it is posted rather than fetched. Everything
      // an editor can be told comes back as a 200 with a sentence in it, the way
      // /preflight does: "already fits", "not set up" and "nothing fitted" are
      // answers, not failures.
      if (req.method !== 'POST') throw new Error('a suggestion is POSTed: { source, value, about? }');
      const body = await readBody(req);
      const asked = body.length ? JSON.parse(body.toString('utf8')) : {};

      let result;
      try {
        result = await writer.shorten({
          card: card.load(template),
          source: asked.source,
          value: asked.value,
          about: asked.about,
          complete: llm.complete,
        });
      } catch (e) {
        if (!(e instanceof llm.LlmError)) throw e;
        result = { ok: false, reason: e.message };
      }

      console.log(
        `suggest ${asked.source}  ${result.before?.chars ?? '?'} -> ${result.after?.chars ?? '—'} chars  ` +
        `${result.ok ? `fits in ${result.attempts} ask${result.attempts === 1 ? '' : 's'}` : 'nothing offered'}  ${Date.now() - started}ms`
      );
      return json(res, 200, { template, model: llm.MODEL, ...result });
    }

    if (url.pathname === '/draft' || url.pathname === '/copy/check') {
      // A written channel's copy, from the record's source material. `/draft`
      // asks the model; `/copy/check` measures copy a person has edited, with
      // no model at all — it is what stands between an edit and "Approve". The
      // channel is either a written template in this library, by id, or a
      // contract another channel posted (the website's), so one writer serves
      // both and neither has to know how the other measures.
      if (req.method !== 'POST') throw new Error(`${url.pathname} is POSTed: { template | contract, record${url.pathname === '/copy/check' ? ', copy' : ''} }`);
      const body = await readBody(req);
      const asked = body.length ? JSON.parse(body.toString('utf8')) : {};
      if (!asked.record) throw new Error(`${url.pathname} needs the record whose source material the copy is written from`);

      let channel;
      if (asked.contract) {
        channel = writer.channelOfContract(asked.contract);
      } else {
        const blueprint = registry.get(asked.template || '');
        if (!blueprint.written) {
          throw new Error(`the template "${blueprint.id}" renders its record directly; only a written template has copy to draft`);
        }
        channel = writer.channelOfCard(blueprint);
      }

      if (url.pathname === '/copy/check') {
        return json(res, 200, writer.checkCopy({ channel, copy: asked.copy || {}, record: asked.record }));
      }

      let result;
      try {
        result = await writer.draft({ channel, record: asked.record, complete: llm.complete });
      } catch (e) {
        if (!(e instanceof llm.LlmError)) throw e;
        result = { ok: false, copy: {}, fields: {}, warnings: channel.warnings, reason: e.message };
      }
      const failed = Object.entries(result.fields).filter(([, f]) => f.status === 'failed').map(([k]) => k);
      console.log(
        `draft   ${channel.id}  ${asked.record.title || ''}  ${result.attempts ?? 0} ask${result.attempts === 1 ? '' : 's'}  ` +
        `${result.ok ? 'all fields passed' : result.reason || `failed: ${failed.join(', ')}`}  ${Date.now() - started}ms`
      );
      return json(res, 200, { channel: channel.id, model: llm.MODEL, ...result });
    }

    if (url.pathname === '/preflight') {
      // Everything a refusal could be — an empty required field, a count the
      // template cannot hold, text that will not fit, an unusable card — arrives
      // as an issue in the list the editor already reads, rather than as a 500
      // they never see. That is the whole point of preflight: it runs on page
      // load, before the marketer presses anything.
      let record;
      let selection;
      try {
        ({ record, selection } = await loadRecord(req, url, template));
      } catch (e) {
        return json(res, 200, {
          template,
          issues: [{ severity: 'error', blocking: true, field: 'record', label: 'Record', message: e.message }],
        });
      }
      try {
        return json(res, 200, { title: record.title, template, issues: checkRecord(record, { template, selection }) });
      } catch (e) {
        return json(res, 200, {
          title: record.title,
          template,
          issues: [{ severity: 'error', blocking: true, field: 'template', label: 'Renderer', message: e.message }],
        });
      }
    }

    if (url.pathname === '/render') {
      const { record, selection, selfDriven } = await loadRecord(req, url, template);
      const { buffer, issues, counts } = await render(record, { template, selection });

      // The deck now exists in the world and will drift from the record, so the
      // CCR has to know about it — but only one of us should say so.
      const entry = selfDriven
        ? await log.record({
            baseUrl: CCR_BASE_URL,
            record,
            generatedBy: url.searchParams.get('user') || 'marketing',
            template,
            bytes: buffer.length,
          })
        : null;

      res.writeHead(200, {
        'Content-Type': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
        'Content-Disposition': `attachment; filename="${filename(record)}"`,
        'Content-Length': buffer.length,
        'X-CCR-Template': template,
        'X-CCR-Slot-Counts': JSON.stringify(counts),
        'X-CCR-Fit-Issues': String(issues.length),
        'X-CCR-Generation-Id': entry?.id ?? (selfDriven ? 'unlogged' : 'logged-by-caller'),
        'Access-Control-Allow-Origin': '*',
      });
      console.log(`render  ${record.title}  ${template}  ${JSON.stringify(counts)}  ${issues.length} fit issues  ${selfDriven ? 'logged here' : 'logged by caller'}  ${Date.now() - started}ms`);
      return res.end(buffer);
    }

    if (url.pathname === '/values') {
      // The lines this template actually puts on a slide, flattened and keyed
      // by item. The CCR stores this beside a generation so it can later say
      // which lines moved, without having to learn what a template holds —
      // see lib/values.js for why that answer belongs here and not there.
      const { record, selection } = await loadRecord(req, url, template);
      return json(res, 200, values.valuesOf(record, { template, selection }));
    }

    if (url.pathname === '/match') {
      // Which templates can show this record, in the record's own words. The
      // CCR drives its deck builder from this: what fits, what needs a
      // selection and how many it holds, and why the rest are refused.
      const { record } = await loadRecord(req, url, template);
      return json(res, 200, { title: record.title, templates: match.all(record) });
    }

    if (url.pathname === '/deck') {
      if (req.method !== 'POST') throw new Error('a deck is POSTed: { entries: [{ template, selection, record }] }');
      const body = await readBody(req);
      if (!body.length) throw new Error('POST /deck needs a deck definition in the body');
      const definition = JSON.parse(body.toString('utf8'));

      const entries = (definition.entries || []).map((entry, i) => {
        const record = entry.record ?? definition.record;
        if (!record) throw new Error(`slide ${i + 1} has no record, and the deck supplies no default`);
        const blueprint = card.load(resolveTemplate(entry.template));
        source.checkAgainstCard(
          record, blueprint, `slide ${i + 1}`, select.rows(record, blueprint, entry.selection)
        );
        return { template: blueprint.id, record, selection: entry.selection };
      });

      const { buffer, issues, slides } = await renderDeck(entries);

      // A deck posted with its definition was driven by the CCR, which holds
      // that definition and writes its own log. Nothing to log from here.
      res.writeHead(200, {
        'Content-Type': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
        'Content-Disposition': `attachment; filename="${filename(definition.record || entries[0].record, definition.title)}"`,
        'Content-Length': buffer.length,
        'X-CCR-Slides': String(slides.length),
        'X-CCR-Templates': slides.map((s) => s.template).join(','),
        'X-CCR-Fit-Issues': String(issues.length),
        'Access-Control-Allow-Origin': '*',
      });
      console.log(`deck    ${slides.length} slides  ${slides.map((s) => s.template).join(' + ')}  ${issues.length} fit issues  ${Date.now() - started}ms`);
      return res.end(buffer);
    }

    return json(res, 404, { error: `no route for ${url.pathname}` });
  } catch (e) {
    console.error(`error   ${url.pathname}: ${e.message}`);
    return json(res, 500, { error: e.message });
  }
});

server.listen(PORT, () => {
  console.log(`renderer listening on http://localhost:${PORT}`);
  console.log(`CCR      ${CCR_BASE_URL}`);
});
