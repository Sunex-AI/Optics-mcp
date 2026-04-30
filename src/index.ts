import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

const API = "https://www.optics-online.com/api/v1";
const CANONICAL_URL = "https://mcp.sunex-ai.com/mcp";

const qs = (p: Record<string, unknown>) =>
  Object.entries(p)
    .filter(([, v]) => v !== undefined && v !== "" && v !== null)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
    .join("&");

async function fetchJson(path: string, params: Record<string, unknown>) {
  const url = `${API}/${path}${Object.keys(params).length ? "?" + qs(params) : ""}`;
  const r = await fetch(url, { headers: { Accept: "application/json" } });
  return { status: r.status, text: await r.text() };
}

async function call(path: string, params: Record<string, unknown>) {
  const { text } = await fetchJson(path, params);
  return { content: [{ type: "text" as const, text }] };
}

export class OpticsMCP extends McpAgent {
  server = new McpServer({ name: "sunex-optics", version: "1.0.0" });

  async init() {
    // 1. Imager search
    this.server.tool(
      "search_imagers",
      "Search the Sunex imager (sensor) catalog by part number, manufacturer, or resolution class. Use detail=true with a specific pn for a single-record exact lookup.",
      {
        pn: z.string().optional().describe("Partial ImagerPN match (e.g. 'IMX577', 'OV')"),
        mfg: z.string().optional().describe("Partial manufacturer match (e.g. 'Sony')"),
        resClass: z.string().optional().describe("Resolution class prefix (e.g. '2MP (1080p)')"),
        detail: z.boolean().optional(),
        limit: z.number().int().min(1).max(500).optional(),
      },
      async (args) =>
        call("imagers.asp", { ...args, detail: args.detail ? 1 : undefined })
    );

    // 2. Imager detail + geometry
    this.server.tool(
      "get_imager_detail",
      "Get full imager specs PLUS computed sensor geometry (effective width/height/diagonal in mm) and a pre-built lens-wizard URL.",
      {
        pn: z.string().describe("Required. Partial ImagerPN match."),
        limit: z.number().int().min(1).max(256).optional(),
      },
      async (args) => call("imager_detail.asp", args)
    );

    // 3. Lens wizard
    this.server.tool(
      "find_compatible_lenses",
      "Given an imager's pixel count and pitch, return lenses whose image circle and resolving power cover the sensor, with per-lens FOV and angular resolution. Supports optional FOV and F/# range filters.",
      {
        hPixel: z.number().int().positive(),
        vPixel: z.number().int().positive(),
        hPitch: z.number().positive().describe("Horizontal pixel pitch in µm"),
        vPitch: z.number().positive().optional().describe("Defaults to hPitch"),
        hFovMin: z.number().optional(),
        hFovMax: z.number().optional(),
        vFovMin: z.number().optional(),
        vFovMax: z.number().optional(),
        dFovMin: z.number().optional(),
        dFovMax: z.number().optional(),
        fNumMin: z.number().optional(),
        fNumMax: z.number().optional(),
        limit: z.number().int().min(1).max(500).optional(),
      },
      async (args) => call("lens_wizard.asp", args)
    );

    // 4. All-products search
    this.server.tool(
      "search_products",
      "Search the full Sunex product catalog by PN prefix and/or description keyword. Returns sample price, currency, and URLs for spec sheet, sample order, and RFQ.",
      {
        pn: z.string().optional(),
        q: z.string().optional().describe("Description keyword (e.g. 'fisheye')"),
        detail: z.boolean().optional(),
        limit: z.number().int().min(1).max(500).optional(),
      },
      async (args) =>
        call("products.asp", { ...args, detail: args.detail ? 1 : undefined })
    );

    // 5. CHAINED: imager PN -> compatible lenses in one shot
    this.server.tool(
      "recommend_lens_for_imager",
      "One-shot recommendation: given an imager part number (e.g. 'IMX577'), looks up its geometry, then returns compatible lenses with FOV and angular resolution. Use this when the user names a sensor and wants lens options.",
      {
        imagerPn: z.string().describe("Imager part number, e.g. 'IMX577', 'AR0820'"),
        hFovMin: z.number().optional(),
        hFovMax: z.number().optional(),
        dFovMin: z.number().optional(),
        dFovMax: z.number().optional(),
        fNumMax: z.number().optional().describe("Cap F-number (e.g. 2.0 = fast lenses only)"),
        limit: z.number().int().min(1).max(500).optional(),
      },
      async ({ imagerPn, ...filters }) => {
        const detail = await fetchJson("imager_detail.asp", { pn: imagerPn, limit: 1 });
        let imager: any;
        try {
          const parsed = JSON.parse(detail.text);
          imager = parsed?.data?.[0];
        } catch {
          return {
            content: [{ type: "text", text: `Failed to parse imager_detail response: ${detail.text.slice(0, 500)}` }],
            isError: true,
          };
        }
        if (!imager) {
          return {
            content: [{ type: "text", text: `No imager found matching PN="${imagerPn}". Try search_imagers first to find the exact part number.` }],
            isError: true,
          };
        }

        const lenses = await fetchJson("lens_wizard.asp", {
          hPixel: imager.hPixel,
          vPixel: imager.vPixel,
          hPitch: imager.hPitchUm,
          vPitch: imager.vPitchUm,
          ...filters,
        });

        let lensPayload: any;
        try { lensPayload = JSON.parse(lenses.text); } catch { lensPayload = { raw: lenses.text }; }

        const merged = {
          ok: true,
          resolvedImager: {
            pn: imager.imagerPn,
            mfg: imager.mfg,
            format: imager.format,
            hPixel: imager.hPixel,
            vPixel: imager.vPixel,
            hPitchUm: imager.hPitchUm,
            vPitchUm: imager.vPitchUm,
            diagonalMm: imager.diagonalMm,
          },
          lensResults: lensPayload,
        };
        return { content: [{ type: "text", text: JSON.stringify(merged, null, 2) }] };
      }
    );
  }
}

// ---------- Public manifest (canonical URL) ----------
const MANIFEST = {
  schema_version: "2024-11-05",
  name: "Sunex Optics",
  description:
    "Search Sunex M12 lenses for automotive, robotics, medical, machine vision, drone and physical AI applications, match CMOS sensors to compatible lenses with FOV and angular resolution, and get sample pricing. An AI-ready MCP server from Sunex.",
  vendor: "Sunex Inc",
  homepage: "https://sunex-ai.com",
  contact_email: "support@sunex.com",
  transport: "streamable-http",
  url: CANONICAL_URL,
  auth: { type: "none" },
  capabilities: { tools: true, resources: false, prompts: false },
};

// ---------- Landing page ----------
const LANDING_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Sunex AI &mdash; Find best lens/CMOS sensor solutions for your imaging applications, directly from your AI chat apps</title>
<meta name="description" content="A public MCP server that lets Claude, ChatGPT, Cursor and any MCP-compatible AI models direct access to our 350+ lens dataset utilizing our powerful Optics-Wizards&trade; tools to find the best lens/imager solutions for automotive, robotics, drone, medical and physical AI applications. Based in the U.S. and serving customers worldwide for 25 years, Sunex has shipped over 100M+ lenses and imaging solutions for mission-critical systems with unmatched reliability. ">
<meta property="og:title" content="Sunex AI &mdash; Lens & imager catalog for AI agents">
<meta property="og:description" content="A public MCP server that lets Claude, ChatGPT, Cursor and any MCP-compatible AI models direct access to our 350+ lens dataset utilizing our powerful Optics-Wizards&trade; tools to find the best lens/imager solutions for automotive, robotics, drone, medical and physical AI applications. Based in the U.S. and serving customers worldwide for 25 years, Sunex has shipped over 100M+ lenses and imaging solutions for mission-critical systems with unmatched reliability. ">
<meta property="og:type" content="website">
<meta property="og:url" content="https://sunex-ai.com">
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Ccircle cx='16' cy='16' r='14' fill='%232E5597'/%3E%3Ccircle cx='16' cy='16' r='5' fill='white'/%3E%3C/svg%3E">
<style>
:root{--sunex:#2E5597;--sunex-dark:#1E3A6E;--sunex-light:#E8EEF7;--ink:#0A1628;--ink-2:#3C4A5F;--ink-3:#6B7A90;--line:#D8DEE8;--bg:#FFFFFF;--bg-2:#F6F8FB;--code-bg:#0A1628;--code-ink:#E8EEF7;--max:1100px}
*{box-sizing:border-box;margin:0;padding:0}
html{scroll-behavior:smooth}
body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;font-size:16px;line-height:1.6;color:var(--ink);background:var(--bg);-webkit-font-smoothing:antialiased}
a{color:var(--sunex);text-decoration:none}
a:hover{text-decoration:underline}
code,pre{font-family:ui-monospace,"SF Mono",Menlo,Monaco,Consolas,monospace;font-size:14px}
.container{max-width:var(--max);margin:0 auto;padding:0 24px}
nav{position:sticky;top:0;z-index:50;background:rgba(255,255,255,0.92);backdrop-filter:saturate(180%) blur(10px);border-bottom:1px solid var(--line)}
.nav-inner{display:flex;align-items:center;justify-content:space-between;height:64px}
.logo{display:flex;align-items:center;gap:10px;font-weight:700;font-size:18px;color:var(--ink)}
.logo-mark{width:28px;height:28px;border-radius:6px;background:var(--sunex);display:flex;align-items:center;justify-content:center}
.logo-mark::after{content:"";width:10px;height:10px;border-radius:50%;background:#fff}
.nav-links{display:flex;gap:28px;align-items:center;font-size:15px}
.nav-links a{color:var(--ink-2);font-weight:500}
.nav-links a:hover{color:var(--sunex);text-decoration:none}
.nav-cta{background:var(--sunex);color:#fff !important;padding:8px 16px;border-radius:6px;font-weight:600;font-size:14px}
.nav-cta:hover{background:var(--sunex-dark);text-decoration:none !important}
@media(max-width:640px){.nav-links a:not(.nav-cta){display:none}}
.hero{padding:72px 0 56px;background:linear-gradient(180deg,var(--sunex-light) 0%,var(--bg) 100%);border-bottom:1px solid var(--line);position:relative;overflow:hidden}
.hero::before{content:"";position:absolute;top:-40%;right:-10%;width:600px;height:600px;background:radial-gradient(circle,rgba(46,85,151,0.06) 0%,transparent 70%);pointer-events:none}
.hero-inner{position:relative;z-index:1}
.eyebrow{display:inline-block;font-size:13px;font-weight:600;letter-spacing:0.08em;color:var(--sunex);text-transform:uppercase;background:#fff;padding:6px 12px;border-radius:20px;border:1px solid var(--sunex-light);margin-bottom:20px}
h1{font-size:clamp(32px,5vw,52px);line-height:1.1;font-weight:800;color:var(--ink);letter-spacing:-0.02em;margin-bottom:20px;max-width:780px}
h1 .accent{color:var(--sunex)}
.sub{font-size:clamp(17px,2vw,20px);color:var(--ink-2);max-width:640px;margin-bottom:32px;line-height:1.5}
.cta-row{display:flex;gap:12px;flex-wrap:wrap;align-items:center}
.btn{display:inline-flex;align-items:center;gap:8px;padding:12px 20px;border-radius:8px;font-weight:600;font-size:15px;transition:all 0.15s;border:1px solid transparent;cursor:pointer}
.btn-primary{background:var(--sunex);color:#fff}
.btn-primary:hover{background:var(--sunex-dark);text-decoration:none;transform:translateY(-1px)}
.btn-ghost{background:#fff;color:var(--ink);border-color:var(--line)}
.btn-ghost:hover{border-color:var(--sunex);color:var(--sunex);text-decoration:none}
.btn svg{width:16px;height:16px}
.hero-stats{display:grid;grid-template-columns:repeat(3,1fr);gap:24px;margin-top:56px;padding-top:32px;border-top:1px solid var(--line);max-width:720px}
.stat .num{font-size:28px;font-weight:700;color:var(--sunex);line-height:1}
.stat .lbl{font-size:13px;color:var(--ink-3);margin-top:6px;font-weight:500}
@media(max-width:640px){.hero-stats{grid-template-columns:1fr 1fr;gap:20px}}
section{padding:72px 0;border-bottom:1px solid var(--line)}
section.alt{background:var(--bg-2)}
h2{font-size:clamp(26px,3.5vw,36px);font-weight:700;color:var(--ink);letter-spacing:-0.01em;margin-bottom:14px;line-height:1.2}
h3{font-size:18px;font-weight:600;color:var(--ink);margin-bottom:8px}
.section-intro{font-size:17px;color:var(--ink-2);max-width:640px;margin-bottom:48px}
.value-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:20px}
@media(max-width:860px){.value-grid{grid-template-columns:1fr}}
.v-card{background:#fff;border:1px solid var(--line);border-radius:12px;padding:28px;transition:border-color 0.15s}
.v-card:hover{border-color:var(--sunex)}
.v-icon{width:40px;height:40px;border-radius:8px;background:var(--sunex-light);display:flex;align-items:center;justify-content:center;margin-bottom:16px;color:var(--sunex)}
.v-icon svg{width:20px;height:20px}
.v-card p{color:var(--ink-2);font-size:15px}
.examples{display:grid;grid-template-columns:1fr 1fr;gap:20px;margin-top:20px}
@media(max-width:860px){.examples{grid-template-columns:1fr}}
.example{background:#fff;border:1px solid var(--line);border-radius:12px;overflow:hidden}
.ex-prompt{padding:20px 24px;background:var(--bg-2);border-bottom:1px solid var(--line);display:flex;gap:12px;align-items:flex-start}
.ex-prompt .pill{flex-shrink:0;font-size:11px;font-weight:700;letter-spacing:0.05em;color:var(--sunex);background:#fff;padding:4px 8px;border-radius:4px;text-transform:uppercase;border:1px solid var(--sunex-light);margin-top:2px}
.ex-prompt .text{font-size:15px;color:var(--ink);font-weight:500;font-style:italic}
.ex-body{padding:20px 24px;font-size:14px;color:var(--ink-2);line-height:1.7}
.ex-body .tool{display:inline-block;font-family:ui-monospace,monospace;font-size:12px;background:var(--ink);color:#fff;padding:2px 8px;border-radius:4px;margin-bottom:10px}
.ex-body ul{list-style:none;padding:0;margin-top:10px}
.ex-body li{padding:4px 0;display:flex;gap:10px}
.ex-body li::before{content:"\\2192";color:var(--sunex);font-weight:700;flex-shrink:0}
.install-grid{display:grid;grid-template-columns:1fr 1fr;gap:24px;align-items:start}
@media(max-width:860px){.install-grid{grid-template-columns:1fr}}
.install-card{background:#fff;border:1px solid var(--line);border-radius:12px;padding:28px}
.install-card h3{margin-bottom:6px;display:flex;align-items:center;gap:10px}
.install-card h3 .num{width:24px;height:24px;border-radius:50%;background:var(--sunex);color:#fff;display:inline-flex;align-items:center;justify-content:center;font-size:13px;font-weight:700}
.install-card .who{font-size:13px;color:var(--ink-3);margin-bottom:18px;font-weight:500}
.url-box{display:flex;align-items:center;background:var(--code-bg);border-radius:8px;padding:12px 16px;font-family:ui-monospace,monospace;font-size:14px;color:var(--code-ink);gap:12px;margin:12px 0}
.url-box code{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#fff;background:transparent}
.url-box button{background:rgba(255,255,255,0.1);color:#fff;border:0;padding:6px 12px;border-radius:6px;cursor:pointer;font-size:12px;font-weight:600;flex-shrink:0;transition:background 0.15s}
.url-box button:hover{background:rgba(255,255,255,0.2)}
.url-box button.ok{background:#10b981}
ol.steps{list-style:none;padding:0;counter-reset:step}
ol.steps li{padding:6px 0 6px 28px;position:relative;font-size:14px;color:var(--ink-2);line-height:1.5;counter-increment:step}
ol.steps li::before{content:counter(step);position:absolute;left:0;top:6px;width:20px;height:20px;border-radius:50%;background:var(--sunex-light);color:var(--sunex);font-size:11px;font-weight:700;display:flex;align-items:center;justify-content:center}
ol.steps li code{background:var(--bg-2);padding:2px 6px;border-radius:4px;color:var(--ink)}
.tools-list{display:grid;grid-template-columns:1fr 1fr;gap:16px}
@media(max-width:700px){.tools-list{grid-template-columns:1fr}}
.tool-row{background:#fff;border:1px solid var(--line);border-radius:10px;padding:18px 22px}
.tool-row .name{font-family:ui-monospace,monospace;font-size:14px;color:var(--sunex);font-weight:600;margin-bottom:4px}
.tool-row .desc{font-size:14px;color:var(--ink-2);line-height:1.5}
.tool-row.featured{border:2px solid var(--sunex);background:var(--sunex-light)}
.tool-row.featured .badge{display:inline-block;font-size:10px;font-weight:700;letter-spacing:0.08em;background:var(--sunex);color:#fff;padding:2px 8px;border-radius:4px;text-transform:uppercase;margin-bottom:8px}
.dev-row{display:grid;grid-template-columns:1.2fr 1fr;gap:40px;align-items:start}
@media(max-width:860px){.dev-row{grid-template-columns:1fr}}
pre.code{background:var(--code-bg);color:var(--code-ink);padding:20px 24px;border-radius:10px;overflow-x:auto;font-size:13px;line-height:1.6}
pre.code .k{color:#7DD3C0}
pre.code .s{color:#F9C859}
pre.code .c{color:#6B7A90;font-style:italic}
.dev-list{list-style:none;padding:0}
.dev-list li{padding:10px 0;border-bottom:1px solid var(--line);display:flex;gap:12px;align-items:flex-start}
.dev-list li:last-child{border-bottom:0}
.dev-list li::before{content:"";flex-shrink:0;width:6px;height:6px;border-radius:50%;background:var(--sunex);margin-top:9px}
.dev-list strong{color:var(--ink);font-weight:600}
.dev-list span{color:var(--ink-2);font-size:14px}
.faq details{background:#fff;border:1px solid var(--line);border-radius:10px;padding:0;margin-bottom:10px;overflow:hidden}
.faq summary{padding:18px 22px;cursor:pointer;font-weight:600;color:var(--ink);font-size:15px;list-style:none;display:flex;justify-content:space-between;align-items:center}
.faq summary::after{content:"+";font-size:20px;color:var(--sunex);font-weight:400;transition:transform 0.2s}
.faq details[open] summary::after{transform:rotate(45deg)}
.faq details[open] summary{border-bottom:1px solid var(--line)}
.faq details p{padding:16px 22px;color:var(--ink-2);font-size:14px;line-height:1.7}
.faq details code{background:var(--bg-2);padding:2px 6px;border-radius:4px;font-size:13px}
footer{padding:48px 0;background:var(--ink);color:#9AA8BE;font-size:14px}
footer .container{display:flex;justify-content:space-between;gap:24px;flex-wrap:wrap}
footer a{color:#D8DEE8}
footer a:hover{color:#fff}
footer .foot-links{display:flex;gap:24px;flex-wrap:wrap}
footer .brand{display:flex;align-items:center;gap:10px;color:#fff;font-weight:600}
footer .brand .logo-mark{width:24px;height:24px;border-radius:5px}
footer .brand .logo-mark::after{width:8px;height:8px}
</style>
</head>
<body>

<nav>
  <div class="container nav-inner">
    <a href="/" class="logo"><span class="logo-mark"></span><span>Sunex AI</span></a>
    <div class="nav-links">
      <a href="#how">How it works</a>
      <a href="#install">Install</a>
      <a href="#tools">Tools</a>
      <a href="#developers">Developers</a>
      <a href="#install" class="nav-cta">Connect</a>
    </div>
  </div>
</nav>

<header class="hero">
  <div class="container hero-inner">
    <span class="eyebrow">Model Context Protocol &middot; Live</span>
    <h1>Find best lens/CMOS sensor solutions for your imaging applications, directly in AI chat apps</h1>
    <p class="sub">A public MCP server that lets Claude, ChatGPT, Cursor and any MCP-compatible AI models direct access to our 350+ lens dataset utilizing our powerful Optics-Wizards&trade; tools to find the best lens/CMOS imager solutions for automotive, robotics, drone, medical and physical AI applications. Based in the U.S. and serving customers worldwide for 25 years, Sunex has shipped over 100M+ lenses and imaging solutions for mission-critical systems with unmatched reliability. </p>
    <div class="cta-row">
      <a href="#install" class="btn btn-primary">Connect in 30 seconds
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M5 12h14M13 5l7 7-7 7"/></svg>
      </a>
      <a href="#how" class="btn btn-ghost">See what it does</a>
    </div>
    <div class="hero-stats">
      <div class="stat"><div class="num">5</div><div class="lbl">AI-callable tools</div></div>
      <div class="stat"><div class="num">Live</div><div class="lbl">Real-time catalog</div></div>
      <div class="stat"><div class="num">Free</div><div class="lbl">Public, no API key</div></div>
    </div>
  </div>
</header>

<section id="how">
  <div class="container">
    <h2>What your AI assistant can do</h2>
    <p class="section-intro">Ask in natural language. The assistant picks the right tool, queries our live catalog, and returns structured results with spec-sheet, sample-order, and RFQ links.</p>
    <div class="value-grid">
      <div class="v-card">
        <div class="v-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/></svg></div>
        <h3>Find sensors fast</h3>
        <p>Search by part number, manufacturer, or resolution class. Get full specs plus computed sensor geometry in millimeters.</p>
      </div>
      <div class="v-card">
        <div class="v-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="4"/></svg></div>
        <h3>Match lenses to imagers</h3>
        <p>Feed any imager PN and get compatible M12 lenses with per-lens FOV, angular resolution, and F/# filters.</p>
      </div>
      <div class="v-card">
        <div class="v-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 3v18h18"/><path d="M7 14l4-4 4 4 5-5"/></svg></div>
        <h3>Quote &amp; spec in one turn</h3>
        <p>Every result includes sample pricing, spec sheet URL, sample order link, and volume RFQ link. No separate lookup.</p>
      </div>
    </div>
    <div class="examples">
      <div class="example">
        <div class="ex-prompt"><span class="pill">Ask</span><span class="text">"Recommend a wide-angle lens for the Sony IMX577 sensor, F/2.0 or faster."</span></div>
        <div class="ex-body">
          <span class="tool">recommend_lens_for_imager</span>
          <div>Resolves IMX577 geometry (4056&times;3040, 1.55&micro;m), then filters lens catalog:</div>
          <ul><li>DSL945 &mdash; EFL 2.2mm, F/1.8, HFOV 150&deg;</li><li>DSL219 &mdash; EFL 1.9mm, F/2.0, HFOV 168&deg;</li><li>Plus spec sheet, sample order &amp; RFQ links</li></ul>
        </div>
      </div>
      <div class="example">
        <div class="ex-prompt"><span class="pill">Ask</span><span class="text">"I need fisheye lenses under $100. What do you have?"</span></div>
        <div class="ex-body">
          <span class="tool">search_products</span>
          <div>Scans full catalog, returns PN, description, sample price, and:</div>
          <ul><li>Direct spec-sheet URLs</li><li>One-click sample order</li><li>Volume quote request</li></ul>
        </div>
      </div>
      <div class="example">
        <div class="ex-prompt"><span class="pill">Ask</span><span class="text">"What's the diagonal of the IMX477 in mm? And what's its Nyquist?"</span></div>
        <div class="ex-body">
          <span class="tool">get_imager_detail</span>
          <div>Returns full specs plus:</div>
          <ul><li>Effective width / height / diagonal in mm</li><li>Nyquist frequencies (mono, green, red/blue)</li><li>Pre-built lens-wizard URL</li></ul>
        </div>
      </div>
      <div class="example">
        <div class="ex-prompt"><span class="pill">Ask</span><span class="text">"Compare lenses for a 1920&times;1080 sensor with 3&micro;m pixels, 100-180&deg; HFOV."</span></div>
        <div class="ex-body">
          <span class="tool">find_compatible_lenses</span>
          <div>Applies FOV, F/#, and image-circle filters:</div>
          <ul><li>Per-lens HFOV, VFOV, DFOV in degrees</li><li>Angular resolution px/deg (on-axis and edge)</li><li>Image-circle clamp flags</li></ul>
        </div>
      </div>
    </div>
  </div>
</section>

<section id="install" class="alt">
  <div class="container">
    <h2>Connect in 30 seconds</h2>
    <p class="section-intro">No account, no API key, no install. Just paste one URL into your MCP-compatible client.</p>
    <div class="url-box" style="max-width:640px;margin-bottom:8px">
      <code id="mcp-url">${CANONICAL_URL}</code>
      <button onclick="copyUrl(this)">Copy URL</button>
    </div>
    <p style="font-size:13px;color:var(--ink-3);margin-bottom:40px">
      This is the canonical MCP endpoint. <code style="background:var(--bg-2);padding:2px 6px;border-radius:4px;font-size:12px">https://sunex-ai.com/mcp</code> also works.
    </p>
    <div class="install-grid">
      <div class="install-card">
        <h3><span class="num">1</span> Claude (web &amp; desktop)</h3>
        <div class="who">Anthropic &middot; Pro / Team / Enterprise</div>
        <ol class="steps">
          <li>Open <a href="https://claude.ai" target="_blank" rel="noopener">claude.ai</a> &rarr; <code>Settings &rarr; Connectors</code></li>
          <li>Click <code>Add custom connector</code></li>
          <li>Paste the URL above</li>
          <li>Name it <em>Sunex Optics</em> and save</li>
        </ol>
      </div>
      <div class="install-card">
        <h3><span class="num">2</span> Cursor / Continue / Zed</h3>
        <div class="who">IDE assistants &middot; MCP support built-in</div>
        <ol class="steps">
          <li>Open your MCP config (e.g. <code>~/.cursor/mcp.json</code>)</li>
          <li>Add an entry with transport <code>sse</code> and the URL above</li>
          <li>Restart the editor</li>
          <li>Tools appear in the assistant's tool picker</li>
        </ol>
      </div>
      <div class="install-card">
        <h3><span class="num">3</span> ChatGPT (custom GPTs)</h3>
        <div class="who">OpenAI &middot; via MCP bridge</div>
        <ol class="steps">
          <li>Create a custom GPT with Actions enabled</li>
          <li>Use any MCP&rarr;OpenAPI bridge (e.g. <code>mcp-openapi</code>)</li>
          <li>Point it at the URL above</li>
          <li>The 5 tools become Actions</li>
        </ol>
      </div>
      <div class="install-card">
        <h3><span class="num">4</span> Your own code</h3>
        <div class="who">Python / TypeScript / any language</div>
        <ol class="steps">
          <li>Install the MCP client SDK for your language</li>
          <li>Connect via SSE to the URL above</li>
          <li>Call tools by name with the documented params</li>
          <li>See <a href="/.well-known/mcp.json">manifest</a> for schema</li>
        </ol>
      </div>
    </div>
  </div>
</section>

<section id="tools">
  <div class="container">
    <h2>Five tools, one endpoint</h2>
    <p class="section-intro">All tools return structured JSON. Parameters are self-documenting &mdash; your AI client sees descriptions and types automatically.</p>
    <div class="tools-list">
      <div class="tool-row featured">
        <span class="badge">Most powerful</span>
        <div class="name">recommend_lens_for_imager</div>
        <div class="desc">One-shot chained lookup. Give any imager PN and get compatible lenses with FOV, angular resolution, and filter options. Saves a round trip.</div>
      </div>
      <div class="tool-row">
        <div class="name">search_imagers</div>
        <div class="desc">Search sensor catalog by PN, manufacturer, or resolution class. Returns full specs from SunexOOL.ImagerList.</div>
      </div>
      <div class="tool-row">
        <div class="name">get_imager_detail</div>
        <div class="desc">Full sensor specs plus computed geometry (width / height / diagonal in mm) and pre-built lens-wizard URL.</div>
      </div>
      <div class="tool-row">
        <div class="name">find_compatible_lenses</div>
        <div class="desc">Given pixel count and pitch, return lenses whose image circle and resolving power cover the sensor, with per-lens FOV and angular resolution.</div>
      </div>
      <div class="tool-row">
        <div class="name">search_products</div>
        <div class="desc">Search full product catalog by PN prefix and/or description keyword. Returns sample pricing and URLs for spec sheet, sample order, and RFQ.</div>
      </div>
    </div>
  </div>
</section>

<section id="developers" class="alt">
  <div class="container">
    <h2>For developers</h2>
    <p class="section-intro">A thin MCP server on Cloudflare Workers, proxying Sunex's live product database. Everything is public, documented, and auditable.</p>
    <div class="dev-row">
      <div>
        <h3 style="margin-bottom:16px">Call a tool directly (Streamable HTTP)</h3>
<pre class="code"><span class="c"># List available tools</span>
<span class="k">curl</span> -X POST ${CANONICAL_URL}

<span class="c"># Inspect the public manifest</span>
<span class="k">curl</span> https://mcp.sunex-ai.com/.well-known/mcp.json

<span class="c"># From Python with the MCP SDK</span>
<span class="k">from</span> mcp <span class="k">import</span> ClientSession
<span class="k">from</span> mcp.client.streamable_http <span class="k">import</span> streamablehttp_client

<span class="k">async with</span> streamablehttp_client(<span class="s">"${CANONICAL_URL}"</span>) <span class="k">as</span> (r, w, _):
    <span class="k">async with</span> ClientSession(r, w) <span class="k">as</span> session:
        <span class="k">await</span> session.initialize()
        result = <span class="k">await</span> session.call_tool(
            <span class="s">"recommend_lens_for_imager"</span>,
            {<span class="s">"imagerPn"</span>: <span class="s">"IMX577"</span>, <span class="s">"fNumMax"</span>: <span class="s">2.0</span>}
        )</pre>
      </div>
      <div>
        <h3 style="margin-bottom:16px">What's under the hood</h3>
        <ul class="dev-list">
          <li><div><strong>Transport</strong><br><span>Streamable HTTP per MCP 2025-03-26 spec (legacy SSE endpoint preserved)</span></div></li>
          <li><div><strong>Runtime</strong><br><span>Cloudflare Workers, global edge, free tier</span></div></li>
          <li><div><strong>Backend</strong><br><span>Sunex's production catalog at optics-online.com</span></div></li>
          <li><div><strong>Auth</strong><br><span>None &mdash; public read-only endpoint</span></div></li>
          <li><div><strong>Rate limit</strong><br><span>Fair use; contact us for high-volume access</span></div></li>
          <li><div><strong>Status</strong><br><span>Live &middot; <a href="/.well-known/mcp.json">manifest</a></span></div></li>
        </ul>
      </div>
    </div>
  </div>
</section>

<section class="faq">
  <div class="container" style="max-width:820px">
    <h2>Frequently asked</h2>
    <p class="section-intro">The essentials, for engineers and buyers alike.</p>
    <details>
      <summary>What is MCP, and why should I care?</summary>
      <p>Model Context Protocol is an open standard (originally from Anthropic, now supported by OpenAI, Google, Cursor, Zed, and others) that lets AI assistants call external tools. Think "USB-C for LLMs." If your assistant supports MCP, it can talk to our catalog without any custom integration work on your end &mdash; you just paste a URL.</p>
    </details>
    <details>
      <summary>Is this really free? What's the catch?</summary>
      <p>Free and public. Sunex maintains it because helping engineers find the right lens faster is good for everyone &mdash; including us. The server is stateless, read-only, and rate-limited fairly. If you want high-volume programmatic access or custom tools, contact us.</p>
    </details>
    <details>
      <summary>Does it work with ChatGPT?</summary>
      <p>MCP is native in Claude, Cursor, Continue, Zed, and a growing list of clients. ChatGPT supports it indirectly via a bridge to Actions / custom GPTs. OpenAI has announced MCP support, and we'll update this page when native connectors ship.</p>
    </details>
    <details>
      <summary>How current is the data?</summary>
      <p>Live. The MCP server proxies Sunex's production catalog in real time &mdash; same data as <a href="https://www.optics-online.com" target="_blank" rel="noopener">optics-online.com</a>. When we add a new lens, it's callable within minutes.</p>
    </details>
    <details>
      <summary>Can I self-host or white-label this?</summary>
      <p>The server code is open and deployable to any Cloudflare account. If you're an integrator or distributor who wants your own branded MCP endpoint against our catalog, contact us &mdash; we're happy to help.</p>
    </details>
    <details>
      <summary>What if a tool returns wrong or surprising results?</summary>
      <p>The math and database come directly from our lens wizard, which has been in production for years. But if you see something off, we want to know &mdash; email <a href="mailto:support@sunex.com">support@sunex.com</a> with the prompt and the response.</p>
    </details>
    <details>
      <summary>Will you add write actions (RFQ submit, sample order)?</summary>
      <p>Yes, on the roadmap. Current tools are read-only by design &mdash; anything that creates an order or RFQ will require explicit auth and per-session confirmation.</p>
    </details>
  </div>
</section>

<footer>
  <div class="container">
    <div class="brand"><span class="logo-mark"></span><span>Sunex AI</span></div>
<div class="foot-links">
  <a href="https://github.com/Sunex-AI/Optics-mcp" target="_blank" rel="noopener">GitHub</a>
  <a href="/.well-known/mcp.json">Manifest</a>
  <a href="https://www.optics-online.com" target="_blank" rel="noopener">optics-online.com</a>
  <a href="https://modelcontextprotocol.io" target="_blank" rel="noopener">About MCP</a>
  <a href="mailto:support@sunex.com">Contact</a>
</div>  </div>
  <div class="container" style="margin-top:24px;color:#6B7A90;font-size:13px">
    &copy; Sunex Inc. &middot; Optical systems for the AI era.
  </div>
</footer>

<script>
function copyUrl(btn){
  const url=document.getElementById('mcp-url').textContent;
  navigator.clipboard.writeText(url).then(()=>{
    const old=btn.textContent;
    btn.textContent='Copied \\u2713';
    btn.classList.add('ok');
    setTimeout(()=>{btn.textContent=old;btn.classList.remove('ok')},1600);
  });
}
</script>

</body>
</html>`;

// ---------- Worker fetch handler ----------
export default {
  fetch(req: Request, env: unknown, ctx: ExecutionContext) {
    const url = new URL(req.url);
    // Track mcp access log use npx wrangler tail
    console.log(`${req.method} ${url.pathname} UA="${req.headers.get("user-agent")?.slice(0,80) || ""}"`);
    // Streamable HTTP endpoint (current MCP spec, primary)
    if (url.pathname === "/mcp" || url.pathname.startsWith("/mcp/")) {
      // @ts-ignore
      return OpticsMCP.serve("/mcp").fetch(req, env, ctx);
    }

    // SSE endpoint (legacy MCP transport, kept for backward compat)
    if (url.pathname === "/sse" || url.pathname === "/sse/message") {
      // @ts-ignore
      return OpticsMCP.serveSSE("/sse").fetch(req, env, ctx);
    }

    // Public manifest — canonical URL (always points to mcp.sunex-ai.com/mcp)
    if (url.pathname === "/.well-known/mcp.json" || url.pathname === "/manifest.json") {
      return new Response(JSON.stringify(MANIFEST, null, 2), {
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
          "Cache-Control": "public, max-age=3600",
        },
      });
    }

    // Landing page
    if (url.pathname === "/") {
      return new Response(LANDING_HTML, {
        headers: {
          "Content-Type": "text/html; charset=utf-8",
          "Cache-Control": "public, max-age=300",
        },
      });
    }

    return new Response("Not found", { status: 404 });
  },
};
