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
import { CRITICAL_NAMES, HOSTING_PLATFORMS, isPublicSuffix, overlapsProtected, parseSuffixList, registrableDomain } from "./safety.ts";
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
  popular: {
    name: string; homepage: string; url: string; license: string; licenseUrl: string;
    /** Exact matches in this many top sites are removed. */
    top: number;
    /** Any entry under a registrable domain in this many top sites is removed. */
    topRegistrable: number;
  };
  suffixList: { url: string };
}

export interface SourceStats {
  id: string;
  name: string;
  homepage: string;
  license: string;
  licenseUrl: string;
  status: "fresh" | "fallback" | "held" | "failed";
  detail?: string;
  /** When this source's data was last downloaded fresh. */
  fetchedAt?: string;
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
  removedProtected: number;
  collapsed: number;
  sha256: string;
  sources: SourceStats[];
}

const ROOT = new URL("..", import.meta.url).pathname;
const DIST = join(ROOT, "dist");
const BASE = (process.env.COOKBOOK_URL ?? "https://cookbook.oldsalt.zone").replace(/\/$/, "");
const UA = `cookbook-builder (+${BASE})`;
const MAX_BYTES = 100 << 20;
/** One source may not publish more than this. */
const MAX_SOURCE_ENTRIES = 1_500_000;
/** Cloudflare serves static files up to 25 MiB. */
const MAX_LIST_BYTES = 24 << 20;
/** A fallback copy older than this is not reused. */
const MAX_FALLBACK_AGE_MS = 48 * 3600 * 1000;

/** A GitHub Actions annotation: shows on the run's summary page. */
function warn(text: string) {
  console.log(process.env.GITHUB_ACTIONS ? `::warning::${text}` : `warning: ${text}`);
}

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
  // Stream and stop at the limit, so a huge or endless body cannot exhaust
  // the runner's memory.
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of response.body as AsyncIterable<Uint8Array>) {
    size += chunk.length;
    if (size > MAX_BYTES) throw new Error(`over ${MAX_BYTES} bytes`);
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

/**
 * The published stats. Required: without them every guard below compares
 * against zero and is off. Set COOKBOOK_FIRST_BUILD=1 for the very first
 * build only.
 */
async function previousStats(): Promise<Stats | undefined> {
  if (process.env.COOKBOOK_FIRST_BUILD === "1") return undefined;
  try {
    return JSON.parse((await download(`${BASE}/stats.json`)).toString("utf8")) as Stats;
  } catch (error) {
    throw new Error(`cannot read the previous stats.json (${(error as Error).message}); refusing to build without the guards. Set COOKBOOK_FIRST_BUILD=1 only for a first build.`);
  }
}

/** Popular domains in rank order, from a CSV of "rank,domain". */
async function popularDomains(config: Config["popular"]): Promise<string[]> {
  let body = await download(config.url);
  if (body.subarray(0, 2).toString("latin1") === "PK") {
    // A zip with one CSV inside. The runner and macOS both have unzip.
    const zip = join(tmpdir(), `popular-${process.pid}.zip`);
    writeFileSync(zip, body);
    body = execFileSync("unzip", ["-p", zip], { maxBuffer: MAX_BYTES });
    rmSync(zip);
  }
  const out: string[] = [];
  for (const line of body.toString("utf8").split(/\r?\n/)) {
    const domain = normalizeDomain(line.split(",")[1] ?? "");
    if (domain) out.push(domain);
    if (out.length >= config.top) break;
  }
  if (out.length < config.top / 2) throw new Error(`popular list has only ${out.length} names`);
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
    if (count === 0) throw new Error("no entries");
    if (count > MAX_SOURCE_ENTRIES) throw new Error(`${count} entries, over the per-source limit`);
    // A sudden large change is more likely a broken or compromised feed than
    // a real one. Hold the previous copy while it is recent; after that, the
    // new data is accepted, so a real change is delayed but never blocked
    // forever.
    const sudden = before >= 100 && (count < before / 2 || count > before * 2 + 50_000);
    if (sudden && previousIsRecent(previous)) {
      stats.status = "held";
      throw new Error(`${count} entries, previously ${before}; holding the previous copy`);
    }
    stats.fetchedAt = new Date().toISOString();
  } catch (error) {
    stats.detail = String((error as Error).message ?? error);
    if (stats.status !== "held") stats.status = "fallback";
    if (!previousIsRecent(previous)) {
      stats.status = "failed";
      stats.detail += "; no recent copy to fall back to";
      warn(`${source.id}: ${stats.detail}`);
      return { stats, header, domains: new Set<string>(), cidrs: new Set<string>() };
    }
    stats.fetchedAt = previous!.fetchedAt;
    warn(`${source.id}: ${stats.detail}`);
    try {
      // Published copies are already normalized, in SafeRoom format.
      const text = (await download(`${BASE}/sources/${source.id}.txt`)).toString("utf8");
      // Our published copy starts with our own two lines, then the source's header.
      if (source.keepHeader) header = text.split("\n").filter((l) => l.startsWith("# ")).slice(2).map((l) => l.slice(2));
      const domains = parse(text, "domains");
      const cidrs = parse(text, "cidr");
      parsed = { domains: domains.domains, cidrs: cidrs.cidrs, invalid: 0 };
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

/** True if the previous build had fresh data for this source within the fallback window. */
function previousIsRecent(previous?: SourceStats): boolean {
  if (!previous?.fetchedAt) return false;
  return Date.now() - Date.parse(previous.fetchedAt) < MAX_FALLBACK_AGE_MS;
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

  const ranked = await popularDomains(config.popular);
  const popular = new Set(ranked);
  const topRegistrable = new Set(ranked.slice(0, config.popular.topRegistrable));
  const psl = parseSuffixList((await download(config.suffixList.url)).toString("utf8"));
  if (psl.rules.size < 5000) throw new Error(`public suffix list has only ${psl.rules.size} rules`);

  // Each removal is published in removed.txt with its reason.
  const removed: string[] = [];
  let removedPopular = 0;
  let removedProtected = 0;
  for (const d of [...domains]) {
    let reason: string | null = null;
    if (isPublicSuffix(d, psl)) {
      // co.uk, github.io, s3.amazonaws.com: nobody owns these, and listing
      // one blocks every site under it.
      reason = "public suffix";
    } else if (popular.has(d)) {
      reason = "popular site";
    } else {
      // www.google.com is not itself in the top list, but google.com is.
      // Hosting platforms on the suffix list keep their customer names
      // (bad.github.io), because their registrable domain is the name.
      const registrable = registrableDomain(d, psl);
      const customerHost = registrable !== null && HOSTING_PLATFORMS.has(registrable) && d !== `www.${registrable}`;
      if (registrable && topRegistrable.has(registrable) && !customerHost) reason = `under popular site ${registrable}`;
      // The shared apex itself, or a parent of it. Customer names under it
      // (d1x.cloudfront.net, bucket.s3.amazonaws.com) are real phishing
      // hosts and stay.
      else if (CRITICAL_NAMES.some((c) => isUnder(c, d))) reason = "critical service";
    }
    if (reason) {
      domains.delete(d);
      removed.push(`${d}  # ${reason}`);
      if (reason === "public suffix" || reason === "critical service") removedProtected++;
      else removedPopular++;
    }
  }
  for (const c of [...cidrs]) {
    const hit = overlapsProtected(c);
    if (hit) {
      cidrs.delete(c);
      removed.push(`${c}  # overlaps protected range ${hit}`);
      removedProtected++;
    }
  }
  // Never-block and the manual allowlist: the name and everything under it.
  const protectedNames = [...NEVER_BLOCK, ...allow];
  let removedAllow = 0;
  for (const d of [...domains]) {
    if (protectedNames.some((p) => isUnder(d, p))) {
      domains.delete(d);
      removedAllow++;
    }
  }

  for (const line of removed) if (!line.includes("popular site")) console.log(`removed ${line}`);
  const finalDomains = collapseSubdomains(domains);
  const finalCIDRs = [...cidrs].sort();
  const total = finalDomains.length + finalCIDRs.length;
  const previousTotal = (previous?.domains ?? 0) + (previous?.cidrs ?? 0);
  if (previousTotal > 0 && total < previousTotal / 2 && process.env.COOKBOOK_ALLOW_SHRINK !== "1") {
    throw new Error(`refusing to publish: ${total} entries, previously ${previousTotal}. Run the workflow by hand with "allow shrink" if this is intended.`);
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
  if (Buffer.byteLength(list) > MAX_LIST_BYTES) {
    throw new Error(`list is ${Buffer.byteLength(list)} bytes, over the ${MAX_LIST_BYTES}-byte limit`);
  }
  const sha256 = createHash("sha256").update(list).digest("hex");
  const stats: Stats = {
    builtAt, domains: finalDomains.length, cidrs: finalCIDRs.length,
    removedPopular, removedAllow, removedProtected, collapsed: domains.size - finalDomains.length,
    sha256, sources: results.map((r) => r.stats),
  };

  writeFileSync(join(DIST, "list.txt"), list);
  writeFileSync(join(DIST, "list.txt.sha256"), `${sha256}  list.txt\n`);
  writeFileSync(join(DIST, "stats.json"), JSON.stringify(stats, null, 2) + "\n");
  writeFileSync(join(DIST, "attribution.txt"), attribution(enabled, config.popular));
  // Transparency: every feed entry that was left out, with the reason.
  writeFileSync(
    join(DIST, "removed.txt"),
    lines([`Feed entries left out of list.txt, with the reason. ${builtAt}`], removed.sort()),
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

/
  Content-Security-Policy: default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'

/index.html
  Content-Security-Policy: default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'

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
