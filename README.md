# Sunex Optics MCP Server

A public [Model Context Protocol](https://modelcontextprotocol.io) server that lets AI assistants search [Sunex](https://www.optics-online.com)'s lens and imager catalog in natural language.

**Live endpoint:** `https://mcp.sunex-ai.com/mcp`
**Landing page:** [sunex-ai.com](https://sunex-ai.com)
**Transport:** Streamable HTTP (MCP spec 2025-03-26). Legacy SSE endpoint at `/sse` preserved for older clients.

## Connect in 30 seconds

### Claude
Settings → Connectors → Add custom connector → paste `https://mcp.sunex-ai.com/mcp`

### Cursor / Continue / Zed
Add to your MCP config with transport `streamable-http` and the URL above.

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

Thin proxy on Cloudflare Workers (free tier) over Sunex's production catalog. Streamable HTTP transport per MCP spec 2025-03-26 (with legacy SSE preserved). No auth, read-only.

## Endpoints

| Path | Purpose |
|---|---|
| `/mcp` | **Primary** — Streamable HTTP transport (current MCP standard) |
| `/sse` | Legacy SSE transport, preserved for backward compatibility |
| `/.well-known/mcp.json` | Public discovery manifest |
| `/` | Landing page with install instructions |

## Self-host

```bash
git clone https://github.com/Sunex-AI/Optics-mcp
cd Optics-mcp
npm install
npx wrangler login
npx wrangler deploy
```

## Calling a tool directly (Python)

```python
from mcp import ClientSession
from mcp.client.streamable_http import streamablehttp_client

async with streamablehttp_client("https://mcp.sunex-ai.com/mcp") as (r, w, _):
    async with ClientSession(r, w) as session:
        await session.initialize()
        result = await session.call_tool(
            "recommend_lens_for_imager",
            {"imagerPn": "IMX577", "fNumMax": 2.0}
        )
```

## Discovery

Public manifest: [`https://mcp.sunex-ai.com/.well-known/mcp.json`](https://mcp.sunex-ai.com/.well-known/mcp.json)

## Contributing

Issues and PRs welcome. For requests about the backend API (pricing, additional catalog fields, new endpoints), email [support@sunex.com](mailto:support@sunex.com).

## License

MIT — see [LICENSE](LICENSE).
