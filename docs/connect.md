# Connecting to the Radiant content repository

You'll get a personal link that looks like `https://mcp-poc.example.com/mcp/<your-key>`. Treat it like a password: it's tied to your name, and every request made with it is logged.

## Claude (claude.ai or the desktop app)

1. Go to **Settings → Connectors → Add custom connector**.
2. Name it **Radiant CCR** and paste your link as the URL. Leave OAuth blank.
3. In a chat, turn the connector on from the tools menu.

## Claude Code

```bash
claude mcp add --transport http radiant-ccr https://mcp-poc.example.com/mcp/<your-key>
```

## Other chat apps

Any app that supports remote MCP servers ("Streamable HTTP") will work. Use the same link. If the app has a separate field for an API key or bearer token, you can use the base URL `…/mcp` and put the key in that field instead.

## Things to try

- "What content does the Radiant repository have?"
- "Give me the Radiant overview for a utilities prospect, with our three most relevant case studies."
- "What are Radiant's capability pillars? Quote them exactly."

**During the pilot, case studies marked PLACEHOLDER are made up.** Don't use them outside the pilot.

## Feedback

After a session, tell us three things: did you find what you needed, would you use the content as returned, and what was missing.
