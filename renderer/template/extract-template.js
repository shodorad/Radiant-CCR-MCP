/**
 * One-time build tool: carve a single-slide, on-brand PPTX template out of the
 * full "Radiant Capabilities Overview.pptx" deck.
 *
 * Slide 4 ("What We Do : Overall Approach") is the source of truth for the
 * content model (CLAUDE.md §8). Rather than re-draw it, the renderer fills text
 * runs in place inside a copy of the real slide — background photo, layout,
 * connectors, arrows and icon artwork all survive untouched. That is what makes
 * the output on-brand rather than merely brand-coloured.
 *
 * Run:  npm run build:template && npm run name:slots
 * Emits: renderer/template/company-overview.pptx   (~2.7 MB, 1 slide)
 *        renderer/template/icons/<token>.svg       (the brand icon set)
 *
 * The second step matters. This tool carries the shapes out under the names the
 * source deck gave them, and the source deck calls three different pillars
 * "Google Shape;185;p30". The blueprint card locates slots by name, so a freshly
 * extracted template has to be named for its card before it is usable:
 * `template/name-slots.js` does that, driven by the card's own fallback
 * geometry. `renderer/test.js` fails if the step is skipped.
 */
const fs = require('fs');
const path = require('path');
const JSZip = require('jszip');

const SOURCE = path.resolve(__dirname, '../../assets/Radiant Capabilities Overview.pptx');
const OUT = path.resolve(__dirname, 'company-overview.pptx');
const ICON_DIR = path.resolve(__dirname, 'icons');
const SOURCE_SLIDE = 4;
const SOURCE_LAYOUT = 'slideLayout13.xml';

// icon_token -> the media part on slide 4 that carries that artwork.
// Tokens come from CLAUDE.md §8; descriptions are the source deck's own alt text.
const ICONS = {
  target:  { media: 'image17.svg', descr: 'Bullseye outline' },
  product: { media: 'image15.svg', descr: 'Ui Ux outline' },
  cloud:   { media: 'image18.svg', descr: 'Internet Of Things outline' },
  brain:   { media: 'image19.svg', descr: 'Artificial Intelligence outline' },
  climb:   { media: 'image16.svg', descr: 'Aspiration outline' },
};

// Media the layout needs: the photographic background and the RADIANT wordmark.
const LAYOUT_MEDIA = ['image1.png', 'image2.svg', 'hdphoto1.wdp'];

const XMLNS_R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const CT = 'http://schemas.openxmlformats.org/package/2006/content-types';

const mime = {
  png: 'image/png', svg: 'image/svg+xml', jpeg: 'image/jpeg', jpg: 'image/jpeg',
  wdp: 'image/vnd.ms-photo', gif: 'image/gif', emf: 'image/x-emf',
};

async function main() {
  if (!fs.existsSync(SOURCE)) {
    console.error(`Source deck not found: ${SOURCE}`);
    process.exit(1);
  }
  const src = await JSZip.loadAsync(fs.readFileSync(SOURCE));
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

  // ---------------------------------------------------------------- slide
  let slide = await read(`ppt/slides/slide${SOURCE_SLIDE}.xml`);
  const slideRels = await read(`ppt/slides/_rels/slide${SOURCE_SLIDE}.xml.rels`);

  // Drop the notes-slide relationship; the template carries no notes part.
  const keptRels = [...slideRels.matchAll(/<Relationship\b[^>]*\/>/g)]
    .map((m) => m[0])
    .filter((r) => !/notesSlide/.test(r))
    .map((r) => r.replace(/Target="\.\.\/slideLayouts\/[^"]*"/, 'Target="../slideLayouts/slideLayout1.xml"'));

  out.file('ppt/slides/slide1.xml', slide);
  out.file('ppt/slides/_rels/slide1.xml.rels', relsFile(keptRels.join('')));

  // ---------------------------------------------------------------- layout
  const layout = await read(`ppt/slideLayouts/${SOURCE_LAYOUT}`);
  const layoutRels = await read(`ppt/slideLayouts/_rels/${SOURCE_LAYOUT}.rels`);
  out.file('ppt/slideLayouts/slideLayout1.xml', layout);
  out.file('ppt/slideLayouts/_rels/slideLayout1.xml.rels', layoutRels);

  // ---------------------------------------------------------------- master
  // The master lists all 17 layouts; the template keeps one. Trim both the
  // relationship file and the sldLayoutIdLst so they agree.
  let master = await read('ppt/slideMasters/slideMaster1.xml');
  master = master.replace(
    /<p:sldLayoutIdLst>[\s\S]*?<\/p:sldLayoutIdLst>/,
    '<p:sldLayoutIdLst><p:sldLayoutId id="2147483661" r:id="rId1"/></p:sldLayoutIdLst>'
  );
  out.file('ppt/slideMasters/slideMaster1.xml', master);
  out.file('ppt/slideMasters/_rels/slideMaster1.xml.rels', relsFile(
    rel('rId1', `${XMLNS_R}/slideLayout`, '../slideLayouts/slideLayout1.xml') +
    rel('rId2', `${XMLNS_R}/theme`, '../theme/theme1.xml')
  ));

  // ---------------------------------------------------------------- theme
  out.file('ppt/theme/theme1.xml', await read('ppt/theme/theme1.xml'));

  // ---------------------------------------------------------------- media
  const media = new Set(LAYOUT_MEDIA);
  for (const v of Object.values(ICONS)) media.add(v.media);
  for (const m of media) out.file(`ppt/media/${m}`, await readBin(`ppt/media/${m}`));

  // The icon set the renderer resolves icon_token against, extracted so it can
  // be inspected and extended without opening the 147 MB source deck.
  fs.mkdirSync(ICON_DIR, { recursive: true });
  for (const [token, v] of Object.entries(ICONS)) {
    fs.writeFileSync(path.join(ICON_DIR, `${token}.svg`), await readBin(`ppt/media/${v.media}`));
  }
  fs.writeFileSync(
    path.join(ICON_DIR, 'index.json'),
    JSON.stringify(
      Object.fromEntries(Object.entries(ICONS).map(([t, v]) => [t, { file: `${t}.svg`, media: v.media, label: v.descr }])),
      null, 2
    ) + '\n'
  );

  // ---------------------------------------------------------------- presentation
  const srcPres = await read('ppt/presentation.xml');
  const sldSz = srcPres.match(/<p:sldSz[^>]*\/>/)[0];
  const notesSz = (srcPres.match(/<p:notesSz[^>]*\/>/) || ['<p:notesSz cx="6858000" cy="9144000"/>'])[0];
  const defaultTextStyle = (srcPres.match(/<p:defaultTextStyle>[\s\S]*?<\/p:defaultTextStyle>/) || [''])[0];

  out.file('ppt/presentation.xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n` +
    `<p:presentation xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"` +
    ` xmlns:r="${XMLNS_R}"` +
    ` xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" saveSubsetFonts="1">` +
    `<p:sldMasterIdLst><p:sldMasterId id="2147483660" r:id="rId1"/></p:sldMasterIdLst>` +
    `<p:sldIdLst><p:sldId id="256" r:id="rId2"/></p:sldIdLst>` +
    sldSz + notesSz + defaultTextStyle +
    `</p:presentation>`);

  out.file('ppt/_rels/presentation.xml.rels', relsFile(
    rel('rId1', `${XMLNS_R}/slideMaster`, 'slideMasters/slideMaster1.xml') +
    rel('rId2', `${XMLNS_R}/slide`, 'slides/slide1.xml') +
    rel('rId3', `${XMLNS_R}/theme`, 'theme/theme1.xml')
  ));

  // ---------------------------------------------------------------- package
  out.file('_rels/.rels', relsFile(
    rel('rId1', `${XMLNS_R}/officeDocument`, 'ppt/presentation.xml') +
    rel('rId2', `${XMLNS_R}/metadata/core-properties`, 'docProps/core.xml') +
    rel('rId3', 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties', 'docProps/app.xml')
  ));

  out.file('docProps/core.xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n` +
    `<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties"` +
    ` xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/"` +
    ` xmlns:dcmitype="http://purl.org/dc/dcmitype/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">` +
    `<dc:title>Company Overview</dc:title><dc:creator>Radiant CCR</dc:creator>` +
    `<cp:lastModifiedBy>Radiant CCR</cp:lastModifiedBy></cp:coreProperties>`);

  out.file('docProps/app.xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n` +
    `<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"` +
    ` xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes">` +
    `<Application>Radiant CCR renderer</Application><Slides>1</Slides><Company>Radiant Digital</Company>` +
    `</Properties>`);

  const exts = new Set(['rels', 'xml']);
  for (const m of media) exts.add(m.split('.').pop().toLowerCase());
  out.file('[Content_Types].xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n` +
    `<Types xmlns="${CT}">` +
    `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
    `<Default Extension="xml" ContentType="application/xml"/>` +
    [...exts].filter((e) => mime[e]).map((e) => `<Default Extension="${e}" ContentType="${mime[e]}"/>`).join('') +
    ov('/ppt/presentation.xml', 'application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml') +
    ov('/ppt/slideMasters/slideMaster1.xml', 'application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml') +
    ov('/ppt/slideLayouts/slideLayout1.xml', 'application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml') +
    ov('/ppt/slides/slide1.xml', 'application/vnd.openxmlformats-officedocument.presentationml.slide+xml') +
    ov('/ppt/theme/theme1.xml', 'application/vnd.openxmlformats-officedocument.theme+xml') +
    ov('/docProps/core.xml', 'application/vnd.openxmlformats-package.core-properties+xml') +
    ov('/docProps/app.xml', 'application/vnd.openxmlformats-officedocument.extended-properties+xml') +
    `</Types>`);

  const buf = await out.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 9 } });
  fs.writeFileSync(OUT, buf);
  console.log(`template  ${path.relative(process.cwd(), OUT)}  ${(buf.length / 1024 / 1024).toFixed(2)} MB`);
  console.log(`icons     ${Object.keys(ICONS).join(', ')}`);
}

const rel = (id, type, target) => `<Relationship Id="${id}" Type="${type}" Target="${target}"/>`;
const relsFile = (inner) =>
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n` +
  `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${inner}</Relationships>`;
const ov = (part, type) => `<Override PartName="${part}" ContentType="${type}"/>`;

main().catch((e) => { console.error(e); process.exit(1); });
