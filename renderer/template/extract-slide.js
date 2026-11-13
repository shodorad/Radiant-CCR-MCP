#!/usr/bin/env node
/**
 * Carve one slide of a real deck into a single-slide template package.
 *
 *   node template/extract-slide.js --slide 24 --id capability-grid
 *   node template/extract-slide.js --slide 4  --id scratch --out /tmp/x.pptx
 *
 * `extract-template.js` beside this file does the same job for slide 4 and is
 * welded to it: a hardcoded layout part, a hand-written token-to-media table,
 * and a fixed list of the media the layout needs. That was fine while there was
 * one template. A library needs a tool that reads those facts out of the deck
 * instead of being told them, so this one walks relationships:
 *
 *   the slide      -> its layout, and the media it draws
 *   the layout     -> its master, and the media it draws
 *   the master     -> its theme, and the media it draws
 *
 * Everything carried is carried byte for byte. Nothing here writes a colour, a
 * font, a dimension or a crop; the only XML this file authors is the package
 * plumbing PowerPoint needs to open the result — presentation.xml, the content
 * types and docProps — none of which describes the artwork.
 *
 * Two things are deliberately rewritten:
 *
 *   Part numbering. The kept layout becomes slideLayout1.xml and the slide
 *   becomes slide1.xml, so a template package is the same shape whichever slide
 *   it came from.
 *
 *   The master's layout list. A master lists all seventeen layouts of the source
 *   deck; the template keeps one, so the list and the relationships have to be
 *   trimmed to agree with each other or PowerPoint offers to repair the file.
 *
 * Relationships whose targets the template does not carry — the notes slide,
 * comments, tags — are dropped. A relationship pointing at a part that is not in
 * the package is one of the four things `validate.js` exists to catch.
 *
 * `--icons` additionally carries the brand icon set named in icons/index.json,
 * so a card on this template can resolve `icon_token` the same way slide 4's
 * does. Those media names come from the index, not from this file.
 */
const fs = require('fs');
const path = require('path');
const JSZip = require('jszip');

const R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const CT = 'http://schemas.openxmlformats.org/package/2006/content-types';

const MIME = {
  png: 'image/png', svg: 'image/svg+xml', jpeg: 'image/jpeg', jpg: 'image/jpeg',
  wdp: 'image/vnd.ms-photo', gif: 'image/gif', emf: 'image/x-emf', tiff: 'image/tiff',
  bmp: 'image/bmp', wmf: 'image/x-wmf', mp4: 'video/mp4', m4a: 'audio/mp4',
};

/**
 * Relationship types that name another *part* of the template package.
 * Anything else is kept only if it points into ppt/media/ — which is the honest
 * rule, because the question is "does the template carry this?" rather than
 * "do we recognise the type?". The photographic background on slide 4's layout
 * is reached by a Microsoft `hdphoto` relationship, not by an `image` one, so a
 * whitelist of official types dropped it and left the layout referencing an
 * rId with no relationship — one of the four things validate.js catches.
 */
const STRUCTURE = new Set([`${R}/slideLayout`, `${R}/slideMaster`, `${R}/theme`]);
const isMedia = (part) => part.startsWith('ppt/media/');

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

/** `ppt/slides/slide4.xml` + `../media/x.svg` -> `ppt/media/x.svg` */
const resolve = (part, target) =>
  path.posix.normalize(path.posix.join(path.posix.dirname(part), target)).replace(/^\/+/, '');

const relsPartFor = (part) =>
  `${path.posix.dirname(part)}/_rels/${path.posix.basename(part)}.rels`;

function parseArgs(argv) {
  const args = { icons: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--slide') args.slide = Number(argv[++i]);
    else if (a === '--id') args.id = argv[++i];
    else if (a === '--source') args.source = argv[++i];
    else if (a === '--out') args.out = argv[++i];
    else if (a === '--icons') args.icons = true;
    else { console.error(`unknown argument: ${a}`); process.exit(2); }
  }
  if (!args.slide || !args.id) {
    console.error('usage: node template/extract-slide.js --slide <n> --id <template-id> [--icons] [--out file.pptx]');
    process.exit(2);
  }
  args.source = path.resolve(args.source || path.join(__dirname, '../../assets/Radiant Capabilities Overview.pptx'));
  args.out = path.resolve(args.out || path.join(__dirname, `${args.id}.pptx`));
  return args;
}

async function main() {
  const args = parseArgs(process.argv);
  if (!fs.existsSync(args.source)) {
    console.error(`source deck not found: ${args.source}`);
    process.exit(1);
  }

  const src = await JSZip.loadAsync(fs.readFileSync(args.source));
  const out = new JSZip();
  const read = async (p) => {
    const f = src.file(p);
    if (!f) throw new Error(`missing part in source deck: ${p}`);
    return f.async('string');
  };
  const readBin = async (p) => {
    const f = src.file(p);
    if (!f) throw new Error(`missing part in source deck: ${p}`);
    return f.async('nodebuffer');
  };

  const media = new Set();

  /**
   * Copy one part, keeping only the relationships whose targets travel with it,
   * and remembering the media it draws. `retarget` renames the parts that get
   * renumbered on the way out.
   */
  async function carry(srcPart, outPart, retarget = {}) {
    out.file(outPart, await read(srcPart));

    const relsSrc = relsPartFor(srcPart);
    if (!src.file(relsSrc)) return [];

    const kept = [];
    for (const r of parseRels(await read(relsSrc))) {
      const target = resolve(srcPart, r.target);
      if (isMedia(target)) media.add(target);
      else if (!STRUCTURE.has(r.type)) continue;
      const to = retarget[r.type];
      kept.push({ ...r, xml: to ? r.xml.replace(/Target="[^"]*"/, `Target="${to}"`) : r.xml });
    }
    out.file(relsPartFor(outPart), relsFile(kept.map((r) => r.xml).join('')));
    return kept;
  }

  // ------------------------------------------------------------------ slide
  const slidePart = `ppt/slides/slide${args.slide}.xml`;
  const slideRels = parseRels(await read(relsPartFor(slidePart)));
  const layoutRel = slideRels.find((r) => r.type === `${R}/slideLayout`);
  if (!layoutRel) throw new Error(`slide ${args.slide} has no layout relationship`);
  const layoutPart = resolve(slidePart, layoutRel.target);

  await carry(slidePart, 'ppt/slides/slide1.xml', { [`${R}/slideLayout`]: '../slideLayouts/slideLayout1.xml' });

  // ----------------------------------------------------------------- layout
  const layoutRelsAll = parseRels(await read(relsPartFor(layoutPart)));
  const masterRel = layoutRelsAll.find((r) => r.type === `${R}/slideMaster`);
  if (!masterRel) throw new Error(`${layoutPart} has no master relationship`);
  const masterPart = resolve(layoutPart, masterRel.target);

  await carry(layoutPart, 'ppt/slideLayouts/slideLayout1.xml', {
    [`${R}/slideMaster`]: '../slideMasters/slideMaster1.xml',
  });

  // ----------------------------------------------------------------- master
  // The master lists every layout of the source deck and this package keeps
  // one, so the list and the relationships are trimmed together. The layout
  // keeps the id the source deck gave it rather than a number invented here.
  const masterXml = await read(masterPart);
  const masterRels = parseRels(await read(relsPartFor(masterPart)));
  const themeRel = masterRels.find((r) => r.type === `${R}/theme`);
  if (!themeRel) throw new Error(`${masterPart} has no theme relationship`);

  const layoutRelId = masterRels.find(
    (r) => r.type === `${R}/slideLayout` && resolve(masterPart, r.target) === layoutPart
  )?.id;
  const layoutId = layoutRelId
    ? (new RegExp(`<p:sldLayoutId id="(\\d+)" r:id="${layoutRelId}"/>`).exec(masterXml) || [])[1]
    : null;

  out.file('ppt/slideMasters/slideMaster1.xml', masterXml.replace(
    /<p:sldLayoutIdLst>[\s\S]*?<\/p:sldLayoutIdLst>/,
    `<p:sldLayoutIdLst><p:sldLayoutId id="${layoutId || 2147483661}" r:id="rId1"/></p:sldLayoutIdLst>`
  ));
  for (const r of masterRels) {
    const target = resolve(masterPart, r.target);
    if (isMedia(target)) media.add(target);
  }
  out.file('ppt/slideMasters/_rels/slideMaster1.xml.rels', relsFile(
    rel('rId1', `${R}/slideLayout`, '../slideLayouts/slideLayout1.xml') +
    rel('rId2', `${R}/theme`, '../theme/theme1.xml')
  ));

  // ------------------------------------------------------------------ theme
  out.file('ppt/theme/theme1.xml', await read(resolve(masterPart, themeRel.target)));

  // ------------------------------------------------------------------ media
  // The brand icon set, so a card on this template can resolve icon_token. The
  // media names come out of the index rather than out of this file.
  if (args.icons) {
    const index = JSON.parse(fs.readFileSync(path.join(__dirname, 'icons/index.json'), 'utf8'));
    for (const icon of Object.values(index)) media.add(`ppt/media/${icon.media}`);
  }
  for (const m of [...media].sort()) out.file(m, await readBin(m));

  // ----------------------------------------------------------- presentation
  const srcPres = await read('ppt/presentation.xml');
  const sldSz = srcPres.match(/<p:sldSz[^>]*\/>/)[0];
  const notesSz = (srcPres.match(/<p:notesSz[^>]*\/>/) || ['<p:notesSz cx="6858000" cy="9144000"/>'])[0];
  const defaultTextStyle = (srcPres.match(/<p:defaultTextStyle>[\s\S]*?<\/p:defaultTextStyle>/) || [''])[0];

  out.file('ppt/presentation.xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n` +
    `<p:presentation xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"` +
    ` xmlns:r="${R}"` +
    ` xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" saveSubsetFonts="1">` +
    `<p:sldMasterIdLst><p:sldMasterId id="2147483660" r:id="rId1"/></p:sldMasterIdLst>` +
    `<p:sldIdLst><p:sldId id="256" r:id="rId2"/></p:sldIdLst>` +
    sldSz + notesSz + defaultTextStyle +
    `</p:presentation>`);

  out.file('ppt/_rels/presentation.xml.rels', relsFile(
    rel('rId1', `${R}/slideMaster`, 'slideMasters/slideMaster1.xml') +
    rel('rId2', `${R}/slide`, 'slides/slide1.xml') +
    rel('rId3', `${R}/theme`, 'theme/theme1.xml')
  ));

  out.file('_rels/.rels', relsFile(
    rel('rId1', `${R}/officeDocument`, 'ppt/presentation.xml') +
    rel('rId2', `${R}/metadata/core-properties`, 'docProps/core.xml') +
    rel('rId3', 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties', 'docProps/app.xml')
  ));

  out.file('docProps/core.xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n` +
    `<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties"` +
    ` xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/"` +
    ` xmlns:dcmitype="http://purl.org/dc/dcmitype/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">` +
    `<dc:title>${args.id}</dc:title><dc:creator>Radiant CCR</dc:creator>` +
    `<cp:lastModifiedBy>Radiant CCR</cp:lastModifiedBy></cp:coreProperties>`);

  out.file('docProps/app.xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n` +
    `<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"` +
    ` xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes">` +
    `<Application>Radiant CCR renderer</Application><Slides>1</Slides><Company>Radiant Digital</Company>` +
    `</Properties>`);

  const exts = [...new Set([...media].map((m) => m.split('.').pop().toLowerCase()))].sort();
  const unknown = exts.filter((e) => !MIME[e]);
  if (unknown.length) throw new Error(`no content type known for media extension: ${unknown.join(', ')}`);

  out.file('[Content_Types].xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n` +
    `<Types xmlns="${CT}">` +
    `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
    `<Default Extension="xml" ContentType="application/xml"/>` +
    exts.map((e) => `<Default Extension="${e}" ContentType="${MIME[e]}"/>`).join('') +
    ov('/ppt/presentation.xml', 'application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml') +
    ov('/ppt/slideMasters/slideMaster1.xml', 'application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml') +
    ov('/ppt/slideLayouts/slideLayout1.xml', 'application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml') +
    ov('/ppt/slides/slide1.xml', 'application/vnd.openxmlformats-officedocument.presentationml.slide+xml') +
    ov('/ppt/theme/theme1.xml', 'application/vnd.openxmlformats-officedocument.theme+xml') +
    ov('/docProps/core.xml', 'application/vnd.openxmlformats-package.core-properties+xml') +
    ov('/docProps/app.xml', 'application/vnd.openxmlformats-officedocument.extended-properties+xml') +
    `</Types>`);

  const buf = await out.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 9 } });
  fs.mkdirSync(path.dirname(args.out), { recursive: true });
  fs.writeFileSync(args.out, buf);

  console.log(`source    ${path.basename(args.source)}  slide ${args.slide}`);
  console.log(`layout    ${layoutPart}  ->  slideLayout1.xml  (id ${layoutId || 'invented'})`);
  console.log(`master    ${masterPart}`);
  console.log(`media     ${[...media].map((m) => path.posix.basename(m)).join(', ')}`);
  console.log(`template  ${path.relative(process.cwd(), args.out)}  ${(buf.length / 1024 / 1024).toFixed(2)} MB`);
  console.log(`\nnext:  node template/name-slots.js ${args.id} --write`);
}

main().catch((e) => { console.error(`\n${e.message}\n`); process.exit(1); });
