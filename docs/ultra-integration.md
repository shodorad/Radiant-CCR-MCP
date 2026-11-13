# The Ultra app as a third channel

**Status:** built and working end to end, verified against the running stack.
**Read first:** `CLAUDE.md` §4 (topology) and §8 (content model). This document
assumes both.

---

## 1. What this is for

The Ultra demo platform has an *Assets & Collaterals* persona whose whole
subject is the problem the CCR exists to solve: a piece of collateral is a
point-in-time copy of a record that keeps moving, so decks, one-pagers and the
website drift apart until nobody knows which sentence is current.

Until now it said so from a hand-written catalogue. A row was stale because
`src/data/collateral.js` contained the string `state: 'stale'`, and the
before/after quoted on the drift card was prose somebody typed. It reads
correctly and proves nothing.

This connects that shelf to the repository, so it can say the one sentence the
CCR was built to make sayable:

> **The Radiant Capabilities Overview you downloaded a week ago is out of date.
> 1 line has changed in the repository since, on 1 of its 3 slides. Download the
> updated one.**

Every number and both quoted sentences in that paragraph are read from the CCR.

## 2. The demo it supports

1. In Ultra, the marketer downloads the Overview deck. The CCR builds it and
   records that this channel is now holding a copy.
2. In the CCR, the marketer edits one line.
3. Ultra's shelf — polling — turns red and quotes the change, naming which
   slides carry it and which do not.
4. The marketer presses **Download the updated one**. A new file arrives, the
   panel goes quiet.

Beat 3 is the one worth watching, and it is the reason this was worth building
rather than scripting: the panel names *one* slide out of three, because only
one of them shows the line that moved.

## 3. Shape

```
   Ultra (Vite/React, localhost:5173)
        │  GET  /ccr/decks?channel=ultra     what am I holding, and what moved
        │  POST /ccr/deck/build              build it, and log that I have it
        ▼
   CCR (Drupal 10, ccr-poc.ddev.site)  ── the repository, the deck definitions,
        │                                  the generation log and its snapshots
        │  POST /values   what will you put on this slide?
        │  POST /deck     make the file
        ▼
   renderer (node, localhost:5001)     ── the artwork and what it holds
```

Ultra knows no Drupal field names, cannot write to a record, and does not know
what a template is. It reads a listing and asks for a file. That is a small H2
claim in its own right: a third channel attached without the repository moving.

## 4. How "what changed" is computed

The generation log recorded which content, which version, by whom and when.
"Which version" was `content_changed`, a timestamp — which answers *whether*
something moved and never *what*.

Now each log row also keeps `rendered`: the lines the renderer said it put on
that slide, as `POST /values` returned them. Asking the same question later
gives a second list, and the difference between them is the drift, quoted.

Three properties, in order of how much they matter:

- **It cannot over-report.** A save that touched a field no template shows — the
  sixth pillar on a five-pillar slide — produces an empty difference and the
  deck is correctly *not* stale. The timestamp marked it stale every time.
- **It cannot get long.** Only lines that reached the slide are compared, and
  every slide-bound field is capped by its template (title 60, positioning 180,
  a pillar description 80). A whole slide is a few hundred characters; a
  three-slide deck is a few dozen comparable lines. There is no character-level
  diff and there does not need to be one.
- **Lines are keyed by item, not position** — `items:<uuid>:name`, for the same
  reason `select.js` names items rather than counting them. Dragging a pillar
  reports nothing, which is correct, instead of reporting every line below it.

**The renderer owns the question of what reaches a slide.** Recomputing that in
Drupal would be a second implementation of `select.rows` plus the contract walk,
and it would drift from the real one the first time a card gained a slot. A
drift report that is itself out of date is worse than none.

### One thing this got wrong first, and it is worth knowing

`drift()` was originally guarded by the timestamp — if `changed` had not moved,
skip the comparison. That looked free and was a false-negative generator:
editing a capability pillar and saving the paragraph does **not** bump the
node's `changed`, because the node's own field values did not change and
`ChangedItem::preSave()` only bumps it when they did. A deck reported as current
while the words on its slides had moved is precisely the failure this feature
exists to prevent, so the cheap check no longer gets an opinion. It costs one
renderer call per slide per listing, memoised per request.

## 5. What was built

### Renderer

| File | What |
|---|---|
| `renderer/lib/values.js` | new — the lines a template puts on a slide, flattened and keyed by item |
| `renderer/server.js` | `POST /values` |
| `renderer/lib/generation-log.js` | reports which template it filled, so a snapshot can be taken against it |

### CCR

| File | What |
|---|---|
| `src/Snapshot.php` | new — comparing two line lists; markup and plain text for each side |
| `src/Controller/ChannelController.php` | new — `GET /ccr/decks`, `POST /ccr/deck/build` |
| `src/Entity/DeckGeneration.php` | `rendered` base field; captured on `log()` and `saveDeck()`; `drift()`, `canReportDrift()` |
| `src/RendererClient.php` | `values()` |
| `ccr_poc.install` | new — installs the base field on a repository that already has rows |
| `ccr_poc.routing.yml` | the two channel routes |
| `web/sites/default/services.yml` | new — CORS, so a browser on another origin can read these |
| `demo.sh` | `./demo.sh ultra [days]` |

A channel takes its **own copy** of a deck: `POST /ccr/deck/build` with a
`deck_id` the repository has not seen clones an existing definition into it.
From then on that id is the channel's — its own owner, its own generation time,
its own staleness. Two channels holding the same deck at different versions is
the situation the collateral shelf is about, so they get separate ids on
purpose.

### Ultra

| File | What |
|---|---|
| `src/lib/ccr.js` | new — the three calls, with offline treated as a state rather than an error |
| `src/hooks/useCcrDecks.js` | new — polls the listing, pauses on a hidden tab, keeps the last good answer |
| `src/components/collateral/StaleDownloadBanner.jsx` | new — the panel, and its four states |
| `src/components/collateral/CollateralBriefing.jsx` | new — one poller feeding both children |
| `src/components/collateral/DownloadLatestCollateral.jsx` | the live row builds instead of linking |
| `src/data/collateral.js` | the Capabilities Overview row gained a `source`; `applyDeck`/`withLiveDecks` |
| `src/markets/.../lead/manifest.tsx` | mounts the briefing |
| `.env.example` | the base URL, the channel and the owner name |

**One row is live, and the rest of the shelf is deliberately still static.** The
shelf is not the demo; the one live row is. The two kinds sitting side by side
is also the honest picture of a real marketing library mid-migration.

## 6. Running it

```bash
./demo.sh start                 # both Drupal instances and the renderer
./demo.sh reset                 # fixture content, the three-slide deck defined
./demo.sh ultra 7               # Ultra takes a copy, backdated a week

cd apps/ultra && npm run dev
open 'http://localhost:5173/?access=rdvr@9705&persona=collateral_lead'
```

`./demo.sh ultra` backdates only the generation *time*. The snapshot of what was
rendered is left exactly as the renderer reported it, so the drift the demo
shows is caused by the marketer's edit and not by anything seeded.

**Run Ultra locally, not from Vercel.** The CCR is on the laptop by constraint
(`CLAUDE.md` §2), so a deployed build cannot reach it. A deployed build is not
broken by this — every live row falls back to its static state and says it could
not check.

## 7. Decisions left open, and things not done

**The CCR dashboard and the Ultra shelf now answer staleness differently.**
`/admin/content/decks` still uses the timestamp, so for the demo's edit it
reports *3 of 3 slides*; the channel endpoint compares values and reports *1 of
3*. Both are honest about their own method and they are looking at different
decks, but a demo showing both screens invites the question. Aligning the
dashboard is a small change to `DashboardController::rows()` — the reason it was
not made here is that it changes the existing demo's beat 4 and the assertion in
`tools/rehearse.js` that goes with it, which is a call about the CEO demo rather
than about this integration.

**The scripted conversation is still scripted.** The persona greeting and the
stat tiles compute their counts from the catalogue at import time, so they still
quote the static numbers while the banner above them reads the CCR live. That
seam is marked in the manifest. Closing it needs the chat engine to take an
async source, which is a bigger change than this one.

**The single-slide path snapshots only when the caller names a template.** The
renderer now reports which template it filled, so `/render` is covered. Anything
else posting to `/ccr/generation-log` without a `template` gets a row that can
say a deck moved but not which lines — reported as `can_report_drift: false`
rather than as silence.

**No auth, open CORS.** Same stated shortcut as `/ccr/record` and
`/ccr/generation-log` (`plan.md` §4), and `services.yml` does not widen it — it
makes the existing shortcut usable from a browser instead of only from curl.
`/ccr/deck/build` is the first endpoint here that *makes* something, so it is
the first one that would need authenticating for real.

**Rows written before this existed are not backfilled.** The lines those decks
carried are not recoverable, and writing today's lines into a row generated last
week would assert that nothing has changed since — the one wrong answer worth
being careful about.
