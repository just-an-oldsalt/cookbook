// Builds the merged list into dist/.
//
//   node build/build.ts
//
// Environment:
//   COOKBOOK_URL          where the current list is published; used for the
//                         previous stats and for per-source fallbacks
//                         (default https://cookbook.oldsalt.zone)
//   COOKBOOK_ALLOW_SHRINK set to 1 to publish even if the list shrinks by
//                         more than half (after a deliberate source removal)

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Format, collapseSubdomains, isUnder, normalizeDomain, parse } from "./parse.ts";
import { renderIndex } from "./page.ts";

interface Source {
  id: string;
  name: string;
  homepage: string;
  url: string;
  format: Format;
  license: string;
  licenseUrl: string;
  /** A line the merged list's header must carry, for licenses that require credit. */
  notice?: string;
  /** Copy the source's own comment header into its published copy (Spamhaus requires its date and (c) lines). */
  keepHeader?: boolean;
  enabled: boolean;
}

interface Config {
  sources: Source[];
  popular: { name: string; homepage: string; url: string; license: string; licenseUrl: string; top: number };
}

export interface SourceStats {
  id: string;
  name: string;
  homepage: string;
  license: string;
  licenseUrl: string;
  status: "fresh" | "fallback" | "failed";
  detail?: string;
  domains: number;
  cidrs: number;
  invalid: number;
}

export interface Stats {
  builtAt: string;
  domains: number;
  cidrs: number;
  removedPopular: number;
  removedAllow: number;
  collapsed: number;
  sha256: string;
  sources: SourceStats[];
}

const ROOT = new URL("..", import.meta.url).pathname;
const DIST = join(ROOT, "dist");
const BASE = (process.env.COOKBOOK_URL ?? "https://cookbook.oldsalt.zone").replace(/\/$/, "");
const UA = `cookbook-builder (+${BASE})`;
const MAX_BYTES = 100 << 20;

/** Names never published, whatever a feed says. Same set as SafeRoom's built-in never-block list. */
const NEVER_BLOCK = [
  "apple.com", "icloud.com", "mzstatic.com", "apple-cloudkit.com", "cdn-apple.com",
  "jamf.com", "jamfcloud.com", "okta.com", "oktacdn.com", "okta-emea.com", "oktapreview.com",
];

async function download(url: string): Promise<Buffer> {
  const response = await fetch(url, {
    headers: { "user-agent": UA },
    signal: AbortSignal.timeout(120_000),
    redirect: "follow",
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const body = Buffer.from(await response.arrayBuffer());
  if (body.length > MAX_BYTES) throw new Error(`${body.length} bytes, over the limit`);
  return body;
}

async function previousStats(): Promise<Stats | undefined> {
  try {
    return JSON.parse((await download(`${BASE}/stats.json`)).toString("utf8")) as Stats;
  } catch {
    return undefined; // first build, or the site is down
  }
}

/** Top-N popular registrable domains, from a CSV of "rank,domain". */
async function popularDomains(config: Config["popular"]): Promise<Set<string>> {
  let body = await download(config.url);
  if (body.subarray(0, 2).toString("latin1") === "PK") {
    // A zip with one CSV inside. The runner and macOS both have unzip.
    const zip = join(tmpdir(), `popular-${process.pid}.zip`);
    writeFileSync(zip, body);
    body = execFileSync("unzip", ["-p", zip], { maxBuffer: MAX_BYTES });
    rmSync(zip);
  }
  const out = new Set<string>();
  for (const line of body.toString("utf8").split(/\r?\n/)) {
    const domain = normalizeDomain(line.split(",")[1] ?? "");
    if (domain) out.add(domain);
    if (out.size >= config.top) break;
  }
  if (out.size < config.top / 2) throw new Error(`popular list has only ${out.size} names`);
  return out;
}

async function loadSource(source: Source, previous?: SourceStats) {
  const stats: SourceStats = {
    id: source.id, name: source.name, homepage: source.homepage,
    license: source.license, licenseUrl: source.licenseUrl,
    status: "fresh", domains: 0, cidrs: 0, invalid: 0,
  };
  let parsed;
  let header: string[] = [];
  try {
    const text = (await download(source.url)).toString("utf8");
    parsed = parse(text, source.format);
    if (source.keepHeader) {
      header = text.split(/\r?\n/).slice(0, 20)
        .filter((l) => /^[;#]/.test(l)).map((l) => l.replace(/^[;#]\s?/, ""));
    }
    const count = parsed.domains.size + parsed.cidrs.size;
    const before = (previous?.domains ?? 0) + (previous?.cidrs ?? 0);
    // A feed that suddenly loses most entries is more likely broken than
    // cleaned up. Use the last published copy instead.
    if (count === 0 || (before >= 100 && count < before / 2)) {
      throw new Error(`${count} entries, previously ${before}`);
    }
  } catch (error) {
    stats.detail = String((error as Error).message ?? error);
    try {
      // Published copies are already normalized, in SafeRoom format.
      const text = (await download(`${BASE}/sources/${source.id}.txt`)).toString("utf8");
      // Our published copy starts with our own two lines, then the source's header.
      if (source.keepHeader) header = text.split("\n").filter((l) => l.startsWith("# ")).slice(2).map((l) => l.slice(2));
      const domains = parse(text, "domains");
      const cidrs = parse(text, "cidr");
      parsed = { domains: domains.domains, cidrs: cidrs.cidrs, invalid: 0 };
      stats.status = "fallback";
    } catch {
      stats.status = "failed";
      return { stats, header, domains: new Set<string>(), cidrs: new Set<string>() };
    }
  }
  stats.domains = parsed.domains.size;
  stats.cidrs = parsed.cidrs.size;
  stats.invalid = parsed.invalid;
  return { stats, header, domains: parsed.domains, cidrs: parsed.cidrs };
}

function lines(header: string[], entries: Iterable<string>): string {
  return [...header.map((h) => `# ${h}`), ...entries, ""].join("\n");
}

async function main() {
  const config = JSON.parse(readFileSync(join(ROOT, "sources.json"), "utf8")) as Config;
  const allow = parse(readFileSync(join(ROOT, "allow.txt"), "utf8"), "domains").domains;
  const previous = await previousStats();
  const builtAt = new Date().toISOString();

  rmSync(DIST, { recursive: true, force: true });
  mkdirSync(join(DIST, "sources"), { recursive: true });

  const enabled = config.sources.filter((s) => s.enabled);
  const results = await Promise.all(
    enabled.map((s) => loadSource(s, previous?.sources.find((p) => p.id === s.id))),
  );

  const domains = new Set<string>();
  const cidrs = new Set<string>();
  for (const [i, r] of results.entries()) {
    const id = enabled[i].id;
    r.domains.forEach((d) => domains.add(d));
    r.cidrs.forEach((c) => cidrs.add(c));
    if (r.stats.status !== "failed") {
      writeFileSync(
        join(DIST, "sources", `${id}.txt`),
        lines([`${enabled[i].name}, normalized by cookbook, ${builtAt}`, `License: ${enabled[i].license} ${enabled[i].licenseUrl}`, ...r.header],
          [...[...r.domains].sort(), ...[...r.cidrs].sort()]),
      );
    }
    console.log(`${id}: ${r.stats.status} ${r.stats.domains} domains ${r.stats.cidrs} cidrs${r.stats.detail ? ` (${r.stats.detail})` : ""}`);
  }

  // Popular names: only exact matches go. A listed subdomain of a hosting
  // platform (bad.github.io) is a real threat and stays.
  const popular = await popularDomains(config.popular);
  const removedPopularNames: string[] = [];
  for (const d of [...domains]) {
    if (popular.has(d)) {
      domains.delete(d);
      removedPopularNames.push(d);
    }
  }
  const removedPopular = removedPopularNames.length;
  // Never-block and the manual allowlist: the name and everything under it.
  const protectedNames = [...NEVER_BLOCK, ...allow];
  let removedAllow = 0;
  for (const d of [...domains]) {
    if (protectedNames.some((p) => isUnder(d, p))) {
      domains.delete(d);
      removedAllow++;
    }
  }

  const finalDomains = collapseSubdomains(domains);
  const finalCIDRs = [...cidrs].sort();
  const total = finalDomains.length + finalCIDRs.length;
  const previousTotal = (previous?.domains ?? 0) + (previous?.cidrs ?? 0);
  if (previousTotal > 0 && total < previousTotal / 2 && process.env.COOKBOOK_ALLOW_SHRINK !== "1") {
    throw new Error(`refusing to publish: ${total} entries, previously ${previousTotal}. Set COOKBOOK_ALLOW_SHRINK=1 if this is intended.`);
  }

  const list = lines(
    [
      "cookbook: merged open threat-intelligence blocklist",
      `Built ${builtAt} from ${enabled.length} sources. ${finalDomains.length} domains, ${finalCIDRs.length} address ranges.`,
      `Format: SafeRoom list format. Sources and licenses: ${BASE}/attribution.txt`,
      "For testing. No warranty: check entries before you rely on them.",
      ...enabled.flatMap((s) => (s.notice ? [`Includes ${s.notice}`] : [])),
    ],
    [...finalDomains, ...finalCIDRs],
  );
  const sha256 = createHash("sha256").update(list).digest("hex");
  const stats: Stats = {
    builtAt, domains: finalDomains.length, cidrs: finalCIDRs.length,
    removedPopular, removedAllow, collapsed: domains.size - finalDomains.length,
    sha256, sources: results.map((r) => r.stats),
  };

  writeFileSync(join(DIST, "list.txt"), list);
  writeFileSync(join(DIST, "list.txt.sha256"), `${sha256}  list.txt\n`);
  writeFileSync(join(DIST, "stats.json"), JSON.stringify(stats, null, 2) + "\n");
  writeFileSync(join(DIST, "attribution.txt"), attribution(enabled, config.popular));
  // Transparency: which feed entries were dropped as popular sites. Most are
  // compromised-once sites that feeds never removed; some may be real threats.
  writeFileSync(
    join(DIST, "removed-popular.txt"),
    lines([`Feed entries removed because they are in the Tranco top ${config.popular.top}. ${builtAt}`], removedPopularNames.sort()),
  );
  writeFileSync(join(DIST, "index.html"), renderIndex(stats, BASE));
  writeFileSync(join(DIST, "404.html"), "<!doctype html><title>Not found</title><p>Not found. The list is at <a href=\"/list.txt\">/list.txt</a>.</p>\n");
  writeFileSync(join(DIST, "_headers"), HEADERS);
  console.log(`published ${finalDomains.length} domains, ${finalCIDRs.length} cidrs; removed ${removedPopular} popular, ${removedAllow} allowlisted; sha256 ${sha256}`);
}

function attribution(sources: Source[], popular: Config["popular"]): string {
  const parts = [
    "cookbook merges these sources. Each keeps its own license; the merged",
    "list is published under the terms below for each part.",
    "",
    ...sources.flatMap((s) => [`${s.name}`, `  ${s.homepage}`, `  License: ${s.license} (${s.licenseUrl})`, ""]),
    "Popular domains removed from the list come from:",
    `${popular.name}`, `  ${popular.homepage}`, `  License: ${popular.license} (${popular.licenseUrl})`, "",
  ];
  return parts.join("\n");
}

const HEADERS = `/*
  X-Content-Type-Options: nosniff
  Strict-Transport-Security: max-age=31536000
  Access-Control-Allow-Origin: *

/*.txt
  Content-Type: text/plain; charset=utf-8
  Cache-Control: public, max-age=300

/*.sha256
  Content-Type: text/plain; charset=utf-8
  Cache-Control: public, max-age=300

/stats.json
  Cache-Control: public, max-age=300
`;

await main();
