/**
 * Several filled slides, one .pptx.
 *
 * Each template is its own single-slide package: its own layout, its own
 * master, its own theme, its own media. Putting two of them in one file is not
 * concatenation — every part name, every relationship and every content-type
 * override has to be made to agree, or PowerPoint offers to repair the file and
 * the demo is over.
 *
 * **Relationship ids are not rewritten, and that is not an oversight.** An r:id
 * is scoped to the part that declares it: `rId2` inside slide1.xml.rels has
 * nothing to do with `rId2` inside slide2.xml.rels. So a filled slide's XML is
 * carried through byte for byte and only the *targets* in its `.rels` move.
 * Rewriting ids across parts would be a large amount of fragile string surgery
 * to solve a collision that cannot happen.
 *
 * What does have to be made unique is everything in the *package's* namespace:
 * part names, `p:sldId`, `p:sldMasterId` and `p:sldLayoutId`. Those are
 * renumbered here.
 *
 * **Media is deduped by content hash.** The Radiant background photograph and
 * its HD Photo backup are 2.5 MB of the company-overview template, and they
 * live on the layout — so two slides from that template would carry them twice
 * and a four-slide deck four times. Keyed by sha256, the second slide costs
 * only its own slide part. Media that nothing references after filling is not
 * carried at all, which is how the icon artwork a template shipped with drops
 * out once every icon has been swapped for the one the record asked for.
 *
 * Nothing here writes a brand value. The only XML this file authors is package
 * plumbing: presentation.xml, [Content_Types].xml and docProps.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const JSZip = require('jszip');

const R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const CT = 'http://schemas.openxmlformats.org/package/2006/content-types';

const MIME = {
  png: 'image/png', svg: 'image/svg+xml', jpeg: 'image/jpeg', jpg: 'image/jpeg',
  wdp: 'image/vnd.ms-photo', gif: 'image/gif', emf: 'image/x-emf', tiff: 'image/tiff',
  bmp: 'image/bmp', wmf: 'image/x-wmf', mp4: 'video/mp4', m4a: 'audio/mp4',
};

const OVERRIDES = {
  presentation: 'application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml',
  slide: 'application/vnd.openxmlformats-officedocument.presentationml.slide+xml',
  slideLayout: 'application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml',
  slideMaster: 'application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml',
  theme: 'application/vnd.openxmlformats-officedocument.theme+xml',
};

const rel = (id, type, target) => `<Relationship Id="${id}" Type="${type}" Target="${target}"/>`;
const relsFile = (inner) =>
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n` +
  `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${inner}</Relationships>`;
const ov = (part, type) => `<Override PartName="${part}" ContentType="${type}"/>`;

const parseRels = (xml) =>
  [...xml.matchAll(/<Relationship\b[^>]*\/>/g)].map((m) => ({
    xml: m[0],
    id: (/Id="([^"]+)"/.exec(m[0]) || [])[1],
    type: (/Type="([^"]+)"/.exec(m[0]) || [])[1],
    target: (/Target="([^"]+)"/.exec(m[0]) || [])[1],
  }));

const resolve = (part, target) =>
  path.posix.normalize(path.posix.join(path.posix.dirname(part), target)).replace(/^\/+/, '');
const relsPartFor = (part) =>
  `${path.posix.dirname(part)}/_rels/${path.posix.basename(part)}.rels`;
const relative = (from, to) => path.posix.relative(path.posix.dirname(from), to);

/**
 * @param {Array<{blueprint: object, slideXml: string, relsXml: string}>} slides
 *        in deck order; `slideXml`/`relsXml` are what render() produced
 * @returns {Promise<Buffer>}
 */
async function assemble(slides) {
  if (!slides.length) throw new Error('a deck needs at least one slide');

  const out = new JSZip();
  const media = new Map();      // sha256 -> output part name
  const usedMediaNames = new Set();
  const templates = new Map();  // template id -> { layout, master, theme, zip }
  const overrides = [];

  /** One output media part per distinct file, whatever it was called before. */
  function claimMedia(buffer, sourceName) {
    const hash = crypto.createHash('sha256').update(buffer).digest('hex');
    if (media.has(hash)) return media.get(hash);

    const ext = path.posix.extname(sourceName);
    const stem = path.posix.basename(sourceName, ext);
    let name = `${stem}${ext}`;
    for (let n = 2; usedMediaNames.has(name); n++) name = `${stem}-${n}${ext}`;

    const part = `ppt/media/${name}`;
    usedMediaNames.add(name);
    media.set(hash, part);
    out.file(part, buffer);
    return part;
  }

  /** Retarget one part's relationships into the merged package. */
  async function rewriteRels(zip, sourcePart, outPart, resolvePart) {
    const relsSource = relsPartFor(sourcePart);
    const file = zip.file(relsSource);
    if (!file) return;

    const kept = [];
    for (const r of parseRels(await file.async('string'))) {
      const target = resolve(sourcePart, r.target);
      let to = null;

      if (target.startsWith('ppt/media/')) {
        const bin = zip.file(target);
        if (!bin) throw new Error(`${sourcePart} points at ${target}, which its package does not hold`);
        to = claimMedia(await bin.async('nodebuffer'), path.posix.basename(target));
      } else {
        to = resolvePart(target, r.type);
      }
      if (!to) continue;
      kept.push(r.xml.replace(/Target="[^"]*"/, `Target="${relative(outPart, to)}"`));
    }
    out.file(relsPartFor(outPart), relsFile(kept.join('')));
  }

  /**
   * Everything behind a slide: its layout, master and theme, carried once per
   * template however many slides use it.
   */
  async function carryTemplate(blueprint) {
    if (templates.has(blueprint.id)) return templates.get(blueprint.id);

    const zip = await JSZip.loadAsync(fs.readFileSync(blueprint.pptxPath));
    const index = templates.size + 1;

    const slidePart = blueprint.parts.slide;
    const slideRels = parseRels(await zip.file(relsPartFor(slidePart)).async('string'));
    const layoutSource = slideRels.find((r) => r.type === `${R}/slideLayout`);
    if (!layoutSource) throw new Error(`${blueprint.id}: its slide has no layout`);
    const layoutPart = resolve(slidePart, layoutSource.target);

    const layoutRels = parseRels(await zip.file(relsPartFor(layoutPart)).async('string'));
    const masterSource = layoutRels.find((r) => r.type === `${R}/slideMaster`);
    if (!masterSource) throw new Error(`${blueprint.id}: its layout has no master`);
    const masterPart = resolve(layoutPart, masterSource.target);

    const masterRels = parseRels(await zip.file(relsPartFor(masterPart)).async('string'));
    const themeSource = masterRels.find((r) => r.type === `${R}/theme`);
    if (!themeSource) throw new Error(`${blueprint.id}: its master has no theme`);
    const themePart = resolve(masterPart, themeSource.target);

    const entry = {
      zip,
      index,
      source: { slide: slidePart, layout: layoutPart, master: masterPart, theme: themePart },
      layout: `ppt/slideLayouts/slideLayout${index}.xml`,
      master: `ppt/slideMasters/slideMaster${index}.xml`,
      theme: `ppt/theme/theme${index}.xml`,
      // p:sldMasterId and p:sldLayoutId share ONE number space, not two. Two
      // masters carrying the layout id their source deck gave them collide with
      // each other; a master id that happens to equal a layout id collides just
      // as badly, and PowerPoint's answer to either is to repair the file on
      // open — silently, with `validate.js` reporting it clean. Interleaved two
      // apiece so neither can meet the other.
      masterId: 2147483648 + index * 2,
      layoutId: 2147483649 + index * 2,
    };
    templates.set(blueprint.id, entry);

    const within = (target) => {
      if (target === entry.source.layout) return entry.layout;
      if (target === entry.source.master) return entry.master;
      if (target === entry.source.theme) return entry.theme;
      return null;
    };

    out.file(entry.layout, await zip.file(layoutPart).async('string'));
    await rewriteRels(zip, layoutPart, entry.layout, within);

    // The master lists the layouts it owns; this package gives it exactly one.
    const masterXml = (await zip.file(masterPart).async('string')).replace(
      /<p:sldLayoutIdLst>[\s\S]*?<\/p:sldLayoutIdLst>/,
      `<p:sldLayoutIdLst><p:sldLayoutId id="${entry.layoutId}" r:id="rId1"/></p:sldLayoutIdLst>`
    );
    out.file(entry.master, masterXml);
    await rewriteRels(zip, masterPart, entry.master, within);

    out.file(entry.theme, await zip.file(themePart).async('string'));

    overrides.push(ov(`/${entry.layout}`, OVERRIDES.slideLayout));
    overrides.push(ov(`/${entry.master}`, OVERRIDES.slideMaster));
    overrides.push(ov(`/${entry.theme}`, OVERRIDES.theme));
    return entry;
  }

  // ------------------------------------------------------------------ slides
  const presRels = [];
  const sldIds = [];
  let slideSize = null;
  let notesSize = null;
  let defaultTextStyle = '';

  for (const [i, slide] of slides.entries()) {
    const template = await carryTemplate(slide.blueprint);
    const part = `ppt/slides/slide${i + 1}.xml`;

    // Every template must agree about the shape of a slide, or half the deck is
    // laid out for a page it is not on.
    const presXml = await template.zip.file(slide.blueprint.parts.presentation).async('string');
    const size = (/<p:sldSz[^>]*\/>/.exec(presXml) || [])[0];
    if (!size) throw new Error(`${slide.blueprint.id}: its presentation declares no slide size`);
    if (slideSize && size !== slideSize) {
      throw new Error(
        `${slide.blueprint.id} is drawn for a different slide size than the templates before it ` +
        `(${size} against ${slideSize}), so they cannot go in one deck.`
      );
    }
    slideSize = size;
    notesSize = notesSize || (/<p:notesSz[^>]*\/>/.exec(presXml) || [])[0];
    defaultTextStyle = defaultTextStyle || (/<p:defaultTextStyle>[\s\S]*?<\/p:defaultTextStyle>/.exec(presXml) || [''])[0];

    out.file(part, slide.slideXml);

    // The filled slide's own rels, retargeted. Media it no longer references —
    // the icon artwork the template shipped with — is simply never claimed.
    const kept = [];
    for (const r of parseRels(slide.relsXml)) {
      const target = resolve(slide.blueprint.parts.slide, r.target);
      let to = null;
      if (target.startsWith('ppt/media/')) {
        const bin = template.zip.file(target);
        if (!bin) throw new Error(`${slide.blueprint.id} points at ${target}, which its package does not hold`);
        to = claimMedia(await bin.async('nodebuffer'), path.posix.basename(target));
      } else if (target === template.source.layout) {
        to = template.layout;
      }
      if (!to) continue;
      kept.push(r.xml.replace(/Target="[^"]*"/, `Target="${relative(part, to)}"`));
    }
    out.file(relsPartFor(part), relsFile(kept.join('')));

    overrides.push(ov(`/${part}`, OVERRIDES.slide));
    const relId = `rId${100 + i}`;
    presRels.push(rel(relId, `${R}/slide`, relative('ppt/presentation.xml', part)));
    sldIds.push(`<p:sldId id="${256 + i}" r:id="${relId}"/>`);
  }

  // ------------------------------------------------------------ presentation
  const masters = [...templates.values()];
  const masterRels = masters.map((t, i) =>
    rel(`rId${i + 1}`, `${R}/slideMaster`, relative('ppt/presentation.xml', t.master))
  );
  const themeRel = rel(`rId${masters.length + 1}`, `${R}/theme`, relative('ppt/presentation.xml', masters[0].theme));

  out.file('ppt/presentation.xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n` +
    `<p:presentation xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"` +
    ` xmlns:r="${R}"` +
    ` xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" saveSubsetFonts="1">` +
    `<p:sldMasterIdLst>${masters.map((t, i) => `<p:sldMasterId id="${t.masterId}" r:id="rId${i + 1}"/>`).join('')}</p:sldMasterIdLst>` +
    `<p:sldIdLst>${sldIds.join('')}</p:sldIdLst>` +
    slideSize + (notesSize || '<p:notesSz cx="6858000" cy="9144000"/>') + defaultTextStyle +
    `</p:presentation>`);

  out.file('ppt/_rels/presentation.xml.rels', relsFile([...masterRels, ...presRels, themeRel].join('')));
  overrides.push(ov('/ppt/presentation.xml', OVERRIDES.presentation));

  // ----------------------------------------------------------------- package
  out.file('_rels/.rels', relsFile(
    rel('rId1', `${R}/officeDocument`, 'ppt/presentation.xml') +
    rel('rId2', `${R}/metadata/core-properties`, 'docProps/core.xml') +
    rel('rId3', 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties', 'docProps/app.xml')
  ));

  const title = slides[0].title || 'Radiant deck';
  out.file('docProps/core.xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n` +
    `<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties"` +
    ` xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/"` +
    ` xmlns:dcmitype="http://purl.org/dc/dcmitype/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">` +
    `<dc:title>${title.replace(/[<>&"]/g, '')}</dc:title><dc:creator>Radiant CCR</dc:creator>` +
    `<cp:lastModifiedBy>Radiant CCR</cp:lastModifiedBy></cp:coreProperties>`);

  out.file('docProps/app.xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n` +
    `<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"` +
    ` xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes">` +
    `<Application>Radiant CCR renderer</Application><Slides>${slides.length}</Slides>` +
    `<Company>Radiant Digital</Company></Properties>`);

  const exts = [...new Set([...media.values()].map((m) => m.split('.').pop().toLowerCase()))].sort();
  const unknown = exts.filter((e) => !MIME[e]);
  if (unknown.length) throw new Error(`no content type known for media extension: ${unknown.join(', ')}`);

  out.file('[Content_Types].xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n` +
    `<Types xmlns="${CT}">` +
    `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
    `<Default Extension="xml" ContentType="application/xml"/>` +
    exts.map((e) => `<Default Extension="${e}" ContentType="${MIME[e]}"/>`).join('') +
    overrides.join('') +
    ov('/docProps/core.xml', 'application/vnd.openxmlformats-package.core-properties+xml') +
    ov('/docProps/app.xml', 'application/vnd.openxmlformats-officedocument.extended-properties+xml') +
    `</Types>`);

  return out.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 9 } });
}

module.exports = { assemble };
