# Radiant CCR MCP

POC: the CCR (Drupal 10) served through an MCP server. Phase 1 returns content (demo Fri 4 Dec 2026). Phase 2 returns an on-brand .pptx (demo Wed 30 Dec 2026). The plan is the "CCR for radiant.digital" artifact (revised 12 Nov 2026).

`ccr/`, `renderer/` and `fixtures/` came from `/Users/shobhit/Downloads/Assets/Rad-Content-Model`. Read its `CLAUDE.md` §4, §8 and §9 before changing either. The rules that carry over:

- **The repository owns its export.** Channels, the MCP included, read `/ccr/record(s)` and never Drupal field names or JSON:API. A new field gets mapped once, in `RecordNormaliser.php`.
- **A model may write words; it may not touch a slide.** The deck is template-fill. Any AI writing goes through `renderer/lib/writer.js` and is measured before anyone sees it.
- **Limits are the template's, not the repository's.** Blueprint cards in `renderer/template/*.card.json` are the PowerPoint contract.

New in this repo:

- **NOT FOR PUBLICATION never leaves through the MCP.** The CCR's `view=public` removes it, and the MCP refuses a record that still has it. Don't weaken either check.
- **Placeholder content is marked.** `fixtures/placeholder-case-studies/*` are fictional, and the MCP flags them. Replace them before testers see them (decision 3).
- **Auth is per-tester shared keys** (`MCP_KEYS`), by Bearer header or `/mcp/<key>`. Never log request URLs.

Checks: `cd mcp && npm test` (17), `cd renderer && npm test` (50).
