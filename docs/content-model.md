# Company Overview — content model v1.0

**Phase 0 deliverable** (plan.md). Derived from two real sources, not invented:

- `Radiant Capabilities Overview.pptx` slide 4 — *"What We Do : Overall Approach"*
- the "what we do" section of **radiant.digital**, read 2026-08-20

Since unwelding phase 3 the model feeds **three** templates, all carved from the same source deck — slide 4, slide 29's four-column capability grid, and slide 3's cover. The model itself did not change to accommodate them, which is the most useful thing the second and third templates had to say. What did change is that the record now publishes a stable `key` per pillar, so a deck can record which of them each slide shows.

---

## 1. The fields

Content type **`company_overview`**, one node.

| Field | Type | Limit | Slide 4 value |
|---|---|---|---|
| `title` | string | 60 | What We Do : Overall Approach |
| `positioning_statement` | constrained rich text | 180 | Radiant helps organizations **accelerate** digital transformation through **Applied AI**… |
| `framework_name` | string | 30 | Radiant's AI Fabric |
| `framework_statement` | constrained rich text | 120 | We infuse intelligence into every enabler… |
| `capability_pillars` | paragraph, unlimited | 3–5 on *this* template, 3–4 on `capability-columns`, none on `section-cover` | — |
| ↳ `name` | string | 36 | Digital Strategy and Experience |
| ↳ `description` | constrained rich text | 80 | Design and optimize experiences faster with AI-driven **insight** and automation. |
| ↳ `icon_token` | select | one of 5 tokens | `target` `product` `cloud` `brain` `climb` |
| ↳ `key` | — | the record's own name for an item; the paragraph's uuid | — |

`weight` is the paragraph field's own drag order, not a field the editor types into. `key` is not a field either — it is the paragraph's uuid, published so that a deck showing five of six can say *which* five without naming positions. A selection by position is right until somebody drags a pillar, and then it is silently wrong.

**An icon is fitted to its frame, not stretched into it.** The brand icons are square (a 96×96 viewBox); the frames a designer drew for them are not always — one on the four-column template is 0.78 — and a `<p:pic>` scales its image to fill. So the renderer shrinks the picture on its long axis and keeps the centre the designer gave it. Both numbers come from the artwork: the frame from the slide, the aspect from the icon's own file. It is a no-op on slide 4, whose frames are square, which is why the golden hash is unaffected. This is the sort of defect no text check catches and only somebody looking at the deck would see.

**The icon vocabulary belongs to the template, not to the repository.** Each blueprint card names an icon set and can resolve exactly the tokens in it. The two content templates carry the same five brand icons, so they share one index; a template carrying three would have its own, and a record asking for a fourth is refused **by name** at match time rather than rendered with whatever artwork happened to be in that position. Wrong content on a finished deck is the drift this project exists to end; an overflowing box is only untidy.

The five tokens are also a small version of the same tension as the six pillars: the brand icon set has five icons and the business has six pillars, so *Skilled Workforce Solutions* reuses `climb`. Nobody has been asked for a sixth icon.

**Constrained rich text** means one format, `ccr_inline`, and a CKEditor toolbar carrying a single **Bold** button.

In the CCR the format permits `<strong>` only. CKEditor 5 requires every permitted tag to have an enabled plugin behind it, so permitting `<em>` would mean adding an Italic button — a second control for a distinction the model does not make. The renderer and the website both accept `<em>` on input anyway, so content pasted or imported from elsewhere keeps its emphasis rather than losing it silently.

### Character limits are a proxy; the renderer is the authority

A limit the marketer can see and act on has to be a character count — it is the only unit a form can express. But characters are not what overflows a box: `"Product Development"` and `"mmmmmmmmmmmmmmmmmmm"` are the same length and very different widths.

So the limits above are calibrated against the real box, and the renderer independently measures every slide-bound field using Raleway metrics read from the font file, reporting anything that will not fit before the deck is downloaded. The limits stop the ordinary case; the fit check catches the pathological one.

**Two of those limits were wrong until unwelding phase 3, and the test that should have caught it could not.** `renderer/test.js` asserted that `maxChars` of text fits `maxLines`, measured with `'W'.repeat(maxChars)` and described as the strictest possible form of the question. It is a single unbreakable word: `wrap()` puts a word that fits nowhere on a line of its own rather than splitting it, so the answer was always one line and the assertion could not fail for any value. Rewritten to measure wrappable prose, it failed immediately — `positioning_statement` advertised 200 characters into a box that holds 184, and a pillar `description` 90 into one that holds 84. A marketer typing to the advertised limit would have overflowed while the counter said they were fine, which is the one thing the counter exists to prevent. Corrected to 180 and 80.

The lesson is narrower than "test your limits": it is that a check whose *inputs* cannot express the failure will pass forever and look like diligence. This is the second time a test in this file has claimed more than it checked.

**The limits in that table are the template's, not the repository's.** Since unwelding phase 2 the CCR stores what the business has: `capability_pillars` has no cardinality, `pillar name` has the ordinary 255-character string storage, and the numbers above are what the *default deck template* can show. They appear on the form as a live counter that you can exceed, and they are read from that template's blueprint card so the form and the renderer cannot disagree.

**A third thing changed in phase 3.** A card can now name the *weight* its ordinary text is set in. The four-column template is Raleway Medium, and measuring Medium as Regular under-reads by 1.7% — a systematic error a safety margin would hide rather than fix. Bold still wins over weight, because a run marked `b="1"` is the family's Bold whatever the surrounding text is. Raleway Medium is vendored alongside Regular and Bold.

**Two things about the fit check changed in unwelding phase 1** (`plan.md` §7).

*It is no longer optional.* `font-metrics.js` returns `null` when the font is unavailable, and the check used to read that as "nothing wrong" — so on a machine without Raleway it disabled itself and still reported success. It now refuses to render, names the font, and says where to put it. Raleway Regular and Bold are vendored in `renderer/template/fonts/`.

*The numbers moved out of the renderer.* Every box width and point size in the table below used to be a `FIELD_RULES` entry in `renderer/render.js`. They are now the `layout` half of `renderer/template/company-overview.card.json`, which travels with the artwork it measures. The reasoning stays here; the numbers live beside the `.pptx`.

| Field | Box | Type | Lines it holds |
|---|---|---|---|
| `title` | layout placeholder | 27.9 pt bold | 1 |
| `positioning_statement` | 11.23 in | 17.85 pt | 2 |
| `framework_name` | auto-sized pill | 13.88 pt | 1 |
| `framework_statement` | 11.23 in | 13.88 pt | 1 |
| pillar `name` | 2.037 in | 12.89 pt bold | **2** |
| pillar `description` | 2.144 in | 11.90 pt | 4 |

Those are slide 4's boxes. The other two templates have their own, in their own cards — the four-column grid gives a pillar description 3.005 in and seventeen lines, and gives its name two lines in a box 0.76 in narrower than slide 4's. The same content is comfortable on one and tight on the other, which is the point of a library.

The binding constraint on slide 4 is the pillar **name** box. It sits 0.51 in above the description box, so a third line collides with the description below it — the collision visible in `slide4.jpg`. Two lines at 2.037 in and 12.89 pt Raleway Bold is roughly 36 characters, which is where that limit comes from and why it is the tightest one in the model.

---

## 2. What the slide forces on the model

### 2.1 Inline emphasis is semantic, not decorative

Slide 4 carries emphasis in two places and treats them differently: **bold white** in the positioning statement, **bold Radiant green** (`92D050`) on the keyword ending each pillar description. Both mean "this is the part that matters". Only the treatment differs.

A plain-text field loses this outright. Storing the *treatment* — a colour, a weight — would push a slide's styling into the repository and break the moment a second channel appeared.

So the CCR stores emphasis and only emphasis. `<strong>` and `<em>` both mean emphasis; the channel decides what emphasis looks like in the place it lands. The renderer never contains the colour `92D050` — it copies the run properties already present in that shape on the real slide. **This is the sharpest H1 finding and it survived contact with the build.**

### 2.2 Icons are references, not assets

`icon_token` is a select list of five tokens. The deck renderer resolves a token to the Radiant SVG lifted from the source deck; the website resolves the same token to its own icon. A marketer never sources, crops or uploads an image, and cannot put an off-brand icon on a slide.

### 2.3 The slide's geometry leaks into the model, and that is worth admitting

The pillar row is five icons joined by four connecting arrows — fixed brand artwork. It does not extend to six. The renderer supports 3, 4 or 5 by removing the unused slots and re-centring the rest at the source slide's pitch, and refuses a sixth with an explicit message rather than silently dropping it.

That cap is a channel constraint sitting in a channel-neutral repository, which is uncomfortable and honest. See §3.1 — the website has six.

**Where the leak sits now — and it is no longer a leak.** Unwelding phase 1 moved the cap out of `renderer/render.js` and into the template's blueprint card, where it reads `"items": { "min": 3, "max": 5 }` alongside the reason it is 5. Phase 2 removed the other half: `field_capability_pillars` has no cardinality, so the website's sixth pillar can be stored, and the template is what refuses:

> you have 6 capability pillars. The template "What We Do — Overall Approach" holds 3–5, because the row of icons and connecting arrows is fixed brand artwork and does not extend. **Pick 5, or choose a template that holds 6.**

Two things about that sentence are the whole point. It names the *template* rather than telling the marketer their content is wrong, and its second option is to keep the content and change the channel. A cardinality of 5 could say neither.

---

## 3. What the website comparison changed

The plan called for this comparison and warned it might weaken H1. It did not, but it moved where the difficulty is.

### 3.1 The website has six pillars; the slide has five

The site lists **Skilled Workforce Solutions** as a sixth enabler. The slide does not. This is a genuine content difference, not a rendering choice — and it is the clearest limit on H1: the deck cannot show it.

**Decision for the POC, v1.0:** cardinality 5, enforced in the CCR, with the renderer stating the reason when given more.

**Reversed in unwelding phase 2, and the reversal is the more interesting finding.** The v1.0 decision let one channel's artwork decide what the repository was allowed to hold — the collateral problem in miniature, reproduced inside the thing built to solve it. The CCR now stores all six and the template refuses to show six. What was still not built was the channel-side *selection*: a slide taking five *of* six is a choice somebody has to make and record, and the only answer was "delete one".

**Built in unwelding phase 3, and the building found the harder fact.**

Selection now exists. A deck records which items each slide shows and in what order, by the record's own item key, and it **never writes back to the repository**. Two decks can show different fives from one record on the same afternoon and the record does not move. The marketer makes the choice on a form that says *"this record has 6 capability pillars"* and shows what each template holds; `renderer/lib/select.js` refuses, by name, a selection that names an item the record no longer has, rather than quietly rebuilding the deck as whatever is left.

Phase 2 could only offer *"choose a template that holds 6"*. Phase 3 went looking for one and established that **there is none, and there cannot be one in this deck**. All 35 slides of `Radiant Capabilities Overview.pptx` were scanned for uniform repeating rows: the largest is five. The slide is 13.33 in wide, and every card grid in the deck is already at capacity — slide 4 extended to six columns puts the last description box at 14.17 in, slide 29 extended to five puts it at 13.46 in.

So the resolution is not a better slide. It is this:

> The business has six capability pillars. Radiant's artwork holds five, or four, or three. Somebody has to choose which ones go on which slide, and the repository's job is to remember what they chose — not to have an opinion about how many there are.

That is a smaller claim than "one model, every channel, no compromises", and it is the true one. The compromise did not disappear; it moved to where a person can see it and make it deliberately.

**Still open, and it is a question for the brand rather than for more building:** nobody has been asked to draw a six-slot slide. See `plan.md` §5.

### 3.2 The same pillar carries different copy on each channel

| Pillar | Slide 4 | radiant.digital |
|---|---|---|
| Digital Strategy and Experience | Design and optimize experiences faster with AI-driven **insight** and automation. | Discover improved customer experience, productivity, and ROI. |
| Product Development and Integration | Accelerate delivery and reduce cost through AI-enabled **development**. | Deliver products at the speed of change. |
| Cloud Transformation | Enhance scalability and performance with AI-optimized **infrastructure**. | Scalable, secure, and agile cloud infrastructure is taking the industry by storm. |

The obvious reading is that these are two fields. **They are not, and treating them as two would defeat the exercise.** Both are one short sentence of the same kind, both fit the same 90-character box, and neither is shaped by its channel. They differ because they were written at different times by different people — which is precisely the collateral drift the CCR exists to end.

**Decision:** one `description` field, one canonical sentence per pillar. Converging them is not a loss of fidelity; it is the deliverable.

The same applies one level up: the slide says the framework is *"Radiant's AI Fabric"* and the site says *"Applied AI"*. One field, one answer, and someone has to decide which. The CCR does not resolve that disagreement — it makes it impossible to keep having it in two places at once.

### 3.2a What a second template wanted, and the record did not have

Unwelding phase 3 added a second content template — slide 29, a four-column icon/heading/body grid. It is the first time this content model has been asked to feed a piece of artwork it was not derived from, which makes what it found worth more than anything the original slide could have told us.

**The shape agreed. The field inventory did not.**

Each of slide 29's columns carries a heading, then a bold lead-in sentence, then a paragraph, then an "Outcome:" line. The record has a pillar `name` and a pillar `description` and nothing else — so the template renders correctly and *sparsely*: one 80-character sentence in a box that holds 590.

That is a real finding and it cuts both ways.

- **In favour of the model:** nothing broke, nothing had to be rewritten by a human, and the deck is on-brand. A template asking for fields the record lacks does not fail; it simply shows less. The card declares what it accepts, the record satisfies it, and the extra space is a design judgement rather than a defect.
- **Against it:** a per-pillar lead-in is plainly a *content* field, not a rendering flourish — somebody wrote those sentences. If Radiant wants that template to look the way it was drawn, the model needs a second sentence per pillar, and that is a decision for the business, not a bug to fix.

Deliberately **not** added to v1.0, for the same reason §3.3's service-page link was not: adding an unshared field to make one channel happier is exactly the drift the CCR exists to end. Recorded here as the second thing to weigh when the model is next opened.

**A smaller one, on the same slide.** Its heading box holds two lines of 20 pt bold in 2.797 in, and *"Product Development and Integration"* wraps to three. The renderer says so — *"Column 2 name: wraps to 3 lines, the box holds 2"* — at match time, before anything is generated, so the marketer choosing four of six can see which two names will not fit and choose around them. One pillar name that fits one template and not another is not a content problem. It is what having more than one template means.

### 3.3 What the web needs and the slide does not

Each website pillar links to a service page. The slide has no such thing.

That is a real field the web wants — and it is deliberately **not** in v1.0. CLAUDE.md §8 constrains the model to what slide 4 contains, and adding an unshared field would soften exactly the tension H1 is meant to test. Recorded here as the first thing to add when a second content type arrives.

### 3.4 The website prose is thin, which flatters H1

The site's "what we do" is fielded and short — a name and a sentence per pillar, not narrative. So the web and the slide really do share a shape here.

**This is the friendliest possible case and must not be generalised.** A prose-heavy overview — company history, a mission narrative — has no fielded structure to share, and one `body` blob would give the deck renderer mush. The POC proves H1 for structured, fielded sections. It proves nothing about long-form content, and claiming otherwise would be the easiest way to get this wrong later.

---

## 4. Where the fixture departs from slide 4

The fixture is slide 4 verbatim with two exceptions, both deliberate:

1. **"Applied AI" is fully bold.** On the real slide the bold run stops after `Applied A`, leaving the `I` unbolded — a typo that has been carried around in every copy of this deck. The CCR value is correct. This is a small, real example of the argument for a single source: the fix happens once.
2. **Pillar names are single strings.** The slide hard-codes a line break (`Product Development` / `and Integration`). The CCR stores the name; the renderer lets the box wrap it. A marketer should never have to decide where a line breaks on a slide they cannot see.

---

**Phase 3 added a sixth pillar to the fixture.** *Skilled Workforce Solutions* is the website's own sixth enabler (§3.1), and it is in the fixture now because the fixture is meant to be the record the CCR holds — and the CCR holds six. It could not be stored at all before phase 2, and could not be rendered anywhere before phase 3. It appears on the website, on the four-column slide, and not on slide 4, which is exactly the arrangement the model is claiming to support.

There is a companion file, `fixtures/company-overview.deck.json`: a deck definition — an ordered list of (template, selection) against that record — so a multi-slide deck can be built with no Drupal running, the same way the record fixture keeps the renderer testable.

---

## 5. JSON:API field mapping

Drupal machine names are prefixed. **The renderer no longer does this translation** — since unwelding phase 2 the CCR publishes the neutral record itself at `/ccr/record`, using the same `RecordNormaliser` it already used to publish to the website. The table below is what that normaliser does, and it is now the only place the mapping exists rather than one of two.

| Fixture key | Drupal field |
|---|---|
| `title` | `title` |
| `positioning_statement` | `field_positioning_statement` |
| `framework_name` | `field_framework_name` |
| `framework_statement` | `field_framework_statement` |
| `capability_pillars` | `field_capability_pillars` (paragraph) |
| ↳ `name` | `field_pillar_name` |
| ↳ `description` | `field_pillar_description` |
| ↳ `icon_token` | `field_icon_token` |

There is a second mapping, one step further out: the blueprint card's `contract.<slot>.source` says which key of the neutral record feeds each slot on the slide — `positioning` ← `positioning_statement`, `items.name` ← `name`. It is written down in each card rather than in code, which is what lets three templates read the same record into three different arrangements of slots. `renderer/lib/source.js` uses it to check that a record can actually feed the template it is about to fill, and to name what is missing when it cannot — because a missing key is not a crash, it is a blank box on a finished deck.

**What that mapping still cannot do, stated so nobody has to find out the hard way.** The table above is hand-written, in `RecordNormaliser::toRecord()`, behind a controller that knows one bundle. So a card declaring `"source": "headline"` cannot be fed: `/ccr/record` will never emit `headline`, whatever the card asks for. Unwelding phase 2's brief asked for this mapping to be card-driven and it was substituted for rather than built; phase 3 did not build it either.

What phase 3 did was stop it being invisible. `POST /match` refuses such a template by name — *"this record has no headline. It publishes title, positioning_statement, framework_name, framework_statement, capability_pillars."* — so the limit announces itself the moment a card runs into it.

**The trigger for building the real thing is a second content type**, not a spare afternoon. A per-bundle configurable map with exactly one bundle to serve is generality nothing can test, and the last two reviews of this project both punished exactly that. When there is a second content type, there is a second mapping to write, and at that point the config-driven version is the cheaper of the two options rather than the more elegant one.

`framework_label` became `framework_name` in the same phase. A label is what the slide calls it; a name is what it is. `ccr/scripts/migrate-model.php` and `site/scripts/migrate-model.php` carry the rename.
