# Sunex Optics MCP Server

A public [Model Context Protocol](https://modelcontextprotocol.io) server that lets AI assistants search [Sunex](https://www.optics-online.com)'s lens and imager catalog in natural language.

**Live endpoint:** `https://mcp.sunex-ai.com/sse`
**Landing page:** [sunex-ai.com](https://sunex-ai.com)

## Connect in 30 seconds

### Claude
Settings → Connectors → Add custom connector → paste `https://mcp.sunex-ai.com/sse`

### Cursor / Continue / Zed
Add to your MCP config with transport `sse` and the URL above.

### ChatGPT
Via any MCP → OpenAPI bridge as a custom GPT Action.

## Five tools

| Tool | What it does |
|---|---|
| `recommend_lens_for_imager` | Give it an imager PN → compatible lenses with FOV and angular resolution. One shot. |
| `search_imagers` | Find sensors by PN, manufacturer, or resolution class. |
| `get_imager_detail` | Full sensor specs plus computed geometry (width / height / diagonal in mm). |
| `find_compatible_lenses` | Given pixel count + pitch, return lenses whose image circle covers the sensor. |
| `search_products` | Full catalog search by PN or keyword, with sample pricing and RFQ links. |

## Example prompts

- *"Recommend a wide-angle lens for the Sony IMX577 with F/2.0 or faster."*
- *"I need fisheye lenses under $100."*
- *"What's the diagonal of the IMX477 in mm?"*
- *"Find lenses for a 1920×1080 sensor with 3µm pixels, 100–180° HFOV."*

## Architecture

```
Claude / Cursor / ChatGPT  →  mcp.sunex-ai.com  →  optics-online.com/api/v1
     (MCP client)         (Cloudflare Worker)      (ASP JSON API)
```

Thin proxy on Cloudflare Workers (free tier) over Sunex's production catalog. SSE transport per MCP spec 2024-11-05. No auth, read-only.

## Self-host

```bash
git clone https://github.com/sunex-ai/optics-mcp
cd optics-mcp
npm install
npx wrangler login
npx wrangler deploy
```

## Discovery

Public manifest: [`https://mcp.sunex-ai.com/.well-known/mcp.json`](https://mcp.sunex-ai.com/.well-known/mcp.json)

## Contributing

Issues and PRs welcome. For requests about the backend API (pricing, additional catalog fields, new endpoints), email [support@sunex.com](mailto:support@sunex.com).

## License

MIT — see [LICENSE](LICENSE).
