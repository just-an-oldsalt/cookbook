// The index page: what the list is, how to use it, and where each part
// comes from. Generated at each build, so the numbers are always current.

import type { Stats } from "./core.ts";

const esc = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

const n = (x: number) => x.toLocaleString("en-US");

export function renderIndex(stats: Stats, base: string): string {
  const rows = stats.sources
    .map(
      (s) => `<tr>
  <td><a href="${esc(s.homepage)}">${esc(s.name)}</a></td>
  <td class="num">${n(s.domains)}</td>
  <td class="num">${n(s.cidrs)}</td>
  <td><span class="st ${s.status}">${s.status}</span>${s.detail ? ` <small>${esc(s.detail)}</small>` : ""}</td>
  <td><a href="${esc(s.licenseUrl)}">${esc(s.license)}</a></td>
</tr>`,
    )
    .join("\n");

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>cookbook</title>
<meta name="description" content="A merged list of known malicious domains and address ranges from open threat-intelligence feeds.">
<style>
  :root { --bg: #fbfaf7; --fg: #1d1c1a; --muted: #6b6760; --line: #e4e0d8; --accent: #8a3b12; --ok: #2f6b3a; --warn: #8a6a12; --bad: #9b2c2c; }
  @media (prefers-color-scheme: dark) {
    :root { --bg: #161513; --fg: #ece8e1; --muted: #a39d93; --line: #2e2b27; --accent: #e08a5a; --ok: #7fbf8a; --warn: #d9b35a; --bad: #e07a7a; }
  }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--fg); font: 16px/1.55 ui-sans-serif, -apple-system, "Segoe UI", sans-serif; }
  main { max-width: 860px; margin: 0 auto; padding: 48px 16px 64px; }
  h1 { font: 700 2.2rem/1.1 ui-serif, Georgia, serif; margin: 0 0 6px; }
  h1 span { color: var(--accent); }
  h2 { font-size: 1.05rem; margin: 40px 0 10px; letter-spacing: .02em; }
  p, li { color: var(--fg); }
  .sub { color: var(--muted); margin: 0 0 28px; }
  .stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 12px; }
  .stat { border: 1px solid var(--line); border-radius: 10px; padding: 14px 16px; }
  .stat b { display: block; font-size: 1.6rem; font-variant-numeric: tabular-nums; }
  .stat small { color: var(--muted); }
  code, pre { font: 14px/1.5 ui-monospace, "SF Mono", Menlo, monospace; }
  pre { background: color-mix(in srgb, var(--line) 45%, transparent); border-radius: 8px; padding: 12px 14px; overflow-x: auto; }
  .table { overflow-x: auto; }
  table { width: 100%; border-collapse: collapse; font-size: 15px; }
  th, td { text-align: left; padding: 8px 10px; border-bottom: 1px solid var(--line); vertical-align: top; }
  th { color: var(--muted); font-weight: 600; }
  .num { text-align: right; font-variant-numeric: tabular-nums; }
  .st { font-weight: 600; }
  .st.fresh { color: var(--ok); } .st.fallback, .st.held { color: var(--warn); } .st.failed { color: var(--bad); }
  td small { color: var(--muted); display: block; }
  a { color: var(--accent); }
  .note { border-left: 3px solid var(--accent); padding: 4px 14px; color: var(--muted); }
  footer { margin-top: 48px; color: var(--muted); font-size: 14px; }
</style>
</head>
<body>
<main>
  <h1>cook<span>book</span></h1>
  <p class="sub">Known malicious domains and address ranges, merged from open threat-intelligence feeds. Built ${esc(stats.builtAt.replace("T", " ").replace(/\..*/, ""))} UTC.</p>

  <div class="stats">
    <div class="stat"><b>${n(stats.domains)}</b><small>domains</small></div>
    <div class="stat"><b>${n(stats.cidrs)}</b><small>address ranges</small></div>
    <div class="stat"><b>${n(stats.sources.length)}</b><small>sources</small></div>
    <div class="stat"><b>${n(stats.removedPopular + stats.removedAllow + stats.removedProtected)}</b><small>left out for safety</small></div>
  </div>

  <h2>Files</h2>
  <ul>
    <li><a href="/list.txt">list.txt</a>: the merged list, one entry per line.</li>
    <li><a href="/list.txt.sha256">list.txt.sha256</a>: its SHA-256.</li>
    <li><a href="/stats.json">stats.json</a>: counts and the status of each source.</li>
    <li><a href="/attribution.txt">attribution.txt</a>: sources and their licenses.</li>
    <li><a href="/removed.txt">removed.txt</a>: feed entries left out (popular sites, public suffixes, protected ranges), with the reason.</li>
    <li><code>/sources/&lt;id&gt;.txt</code>: each source on its own, normalized.</li>
  </ul>

  <h2>Use it with SafeRoom</h2>
  <p>Put these keys in the <code>ProviderConfiguration</code> of the SafeRoom MDM profile:</p>
  <pre>&lt;key&gt;ListURL&lt;/key&gt;
&lt;string&gt;${esc(base)}/list.txt&lt;/string&gt;
&lt;key&gt;ListSHA256URL&lt;/key&gt;
&lt;string&gt;${esc(base)}/list.txt.sha256&lt;/string&gt;</pre>
  <p>Any blocker that reads one domain per line can use the list too. Lines that start with <code>#</code> are comments, and lines with a <code>/</code> are address ranges.</p>
  <p class="note">This list is for testing and for people who want a free starting point. It has no warranty. Feeds sometimes list legitimate sites that were compromised. Before you put a fleet on this list, read the sources, and set an allowlist.</p>

  <h2>Sources</h2>
  <div class="table"><table>
    <thead><tr><th>Source</th><th class="num">Domains</th><th class="num">Ranges</th><th>Status</th><th>License</th></tr></thead>
    <tbody>
${rows}
    </tbody>
  </table></div>
  <p><small>fresh: downloaded this build. held: the source changed size suddenly, so its previous copy is used for up to 48 hours. fallback: the download failed, so the last published copy was used. failed: no recent copy was available.</small></p>

  <footer>
    Source code: <a href="https://github.com/just-an-oldsalt/cookbook">github.com/just-an-oldsalt/cookbook</a>.
    Named after the Dungeon Anarchist's Cookbook: what past crawlers learned, passed to the next ones.
  </footer>
</main>
</body>
</html>
`;
}
