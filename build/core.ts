// Builds the merged list. Uses only web-standard APIs (fetch, streams,
// crypto.subtle), so the same code runs in the Worker (src/worker.ts) and in
// Node (build/cli.ts). The caller supplies the previous build and stores the
// files this returns.

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

export interface Config {
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

export interface BuildInput {
  config: Config;
  /** The text of allow.txt. */
  allow: string;
  /**
   * The published stats. Required: without them every guard below compares
   * against zero and is off. Undefined only for the very first build.
   */
  previous: Stats | undefined;
  /** The published copy of one source, or null if there is none. */
  previousSource: (id: string) => Promise<string | null>;
  /** Publish even if the list shrinks by more than half (after a deliberate source removal). */
  allowShrink: boolean;
  /** Where the list is published, for the list header and the index page. */
  base: string;
}

export interface BuildOutput {
  /**
   * Published path and content, in the order to store them: list.txt and
   * its checksum come after the files they describe, so a reader never sees
   * a checksum for a list that is not there yet.
   */
  files: [string, string][];
  stats: Stats;
}

const MAX_BYTES = 100 << 20;
/** One source may not publish more than this. */
const MAX_SOURCE_ENTRIES = 1_500_000;
/** A sanity limit. It began as the 25 MiB file limit of Workers static assets; R2 has no such limit. */
const MAX_LIST_BYTES = 24 << 20;
/** A fallback copy older than this is not reused. */
const MAX_FALLBACK_AGE_MS = 48 * 3600 * 1000;

/** A warning line in the build log. */
function warn(text: string) {
  console.log(`warning: ${text}`);
}

/** Names never published, whatever a feed says. Same set as SafeRoom's built-in never-block list. */
const NEVER_BLOCK = [
  "apple.com", "icloud.com", "mzstatic.com", "apple-cloudkit.com", "cdn-apple.com",
  "jamf.com", "jamfcloud.com", "okta.com", "oktacdn.com", "okta-emea.com", "oktapreview.com",
];

async function fetchOK(url: string, base: string): Promise<Response> {
  const response = await fetch(url, {
    headers: { "user-agent": `cookbook-builder (+${base})` },
    signal: AbortSignal.timeout(120_000),
    redirect: "follow",
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response;
}

/** Wraps a byte stream so it errors past the limit: a huge or endless body cannot exhaust memory. */
function limited(body: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
  let size = 0;
  return body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      size += chunk.length;
      if (size > MAX_BYTES) controller.error(new Error(`over ${MAX_BYTES} bytes`));
      else controller.enqueue(chunk);
    },
  }));
}

async function downloadText(url: string, base: string): Promise<string> {
  const response = await fetchOK(url, base);
  return new Response(limited(response.body!)).text();
}

/**
 * The bytes after a zip's first local file header, inflated. Tranco ships one
 * CSV per zip, stored with deflate.
 */
async function unzipFirst(body: ReadableStream<Uint8Array>): Promise<ReadableStream<Uint8Array>> {
  const reader = body.getReader();
  let head = new Uint8Array(0);
  const need = (n: number) => head.length >= n;
  while (!need(30) || !need(30 + u16(head, 26) + u16(head, 28))) {
    const { done, value } = await reader.read();
    if (done) throw new Error("zip ends inside its header");
    const next = new Uint8Array(head.length + value.length);
    next.set(head);
    next.set(value, head.length);
    head = next;
  }
  if (u16(head, 0) !== 0x4b50 || u16(head, 2) !== 0x0403) throw new Error("not a zip local file header");
  if (u16(head, 8) !== 8) throw new Error(`zip compression method ${u16(head, 8)}, expected deflate`);
  const rest = head.subarray(30 + u16(head, 26) + u16(head, 28));
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      if (rest.length) controller.enqueue(rest);
    },
    async pull(controller) {
      const { done, value } = await reader.read();
      if (done) controller.close();
      else controller.enqueue(value);
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });
  return stream.pipeThrough(new DecompressionStream("deflate-raw"));
}

function u16(bytes: Uint8Array, at: number): number {
  return bytes[at] | (bytes[at + 1] << 8);
}

/**
 * Popular domains in rank order, from a CSV of "rank,domain", plain or
 * zipped. Reads only as many lines as it needs, so the full million-line list
 * is never held in memory.
 */
async function popularDomains(config: Config["popular"], base: string): Promise<string[]> {
  const response = await fetchOK(config.url, base);
  let bytes = limited(response.body!);
  if (new URL(config.url).pathname.endsWith(".zip")) bytes = await unzipFirst(bytes);
  const reader = bytes.pipeThrough(new TextDecoderStream()).getReader();
  const out: string[] = [];
  let partial = "";
  try {
    while (out.length < config.top) {
      const { done, value } = await reader.read();
      const text = partial + (value ?? "");
      const lines = text.split(/\r?\n/);
      partial = done ? "" : lines.pop()!;
      for (const line of lines) {
        const domain = normalizeDomain(line.split(",")[1] ?? "");
        if (domain) out.push(domain);
        if (out.length >= config.top) break;
      }
      if (done) break;
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  if (out.length < config.top / 2) throw new Error(`popular list has only ${out.length} names`);
  return out;
}

async function loadSource(source: Source, input: BuildInput, previous?: SourceStats) {
  const stats: SourceStats = {
    id: source.id, name: source.name, homepage: source.homepage,
    license: source.license, licenseUrl: source.licenseUrl,
    status: "fresh", domains: 0, cidrs: 0, invalid: 0,
  };
  let parsed;
  let header: string[] = [];
  try {
    const text = await downloadText(source.url, input.base);
    parsed = parse(text, source.format);
    if (source.keepHeader) {
      header = text.split(/\r?\n/, 20)
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
    // Published copies are already normalized, in SafeRoom format.
    const text = await input.previousSource(source.id).catch(() => null);
    if (text === null) {
      stats.status = "failed";
      return { stats, header, domains: new Set<string>(), cidrs: new Set<string>() };
    }
    // Our published copy starts with our own two lines, then the source's header.
    if (source.keepHeader) header = text.split("\n").filter((l) => l.startsWith("# ")).slice(2).map((l) => l.slice(2));
    const domains = parse(text, "domains");
    const cidrs = parse(text, "cidr");
    parsed = { domains: domains.domains, cidrs: cidrs.cidrs, invalid: 0 };
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

export async function buildList(input: BuildInput): Promise<BuildOutput> {
  const { config, previous, base } = input;
  const allow = parse(input.allow, "domains").domains;
  const builtAt = new Date().toISOString();
  const files: [string, string][] = [];

  const enabled = config.sources.filter((s) => s.enabled);
  const results = await Promise.all(
    enabled.map((s) => loadSource(s, input, previous?.sources.find((p) => p.id === s.id))),
  );

  const domains = new Set<string>();
  const cidrs = new Set<string>();
  for (const [i, r] of results.entries()) {
    const id = enabled[i].id;
    r.domains.forEach((d) => domains.add(d));
    r.cidrs.forEach((c) => cidrs.add(c));
    if (r.stats.status !== "failed") {
      files.push([
        `sources/${id}.txt`,
        lines([`${enabled[i].name}, normalized by cookbook, ${builtAt}`, `License: ${enabled[i].license} ${enabled[i].licenseUrl}`, ...r.header],
          [...[...r.domains].sort(), ...[...r.cidrs].sort()]),
      ]);
    }
    console.log(`${id}: ${r.stats.status} ${r.stats.domains} domains ${r.stats.cidrs} cidrs${r.stats.detail ? ` (${r.stats.detail})` : ""}`);
  }

  const ranked = await popularDomains(config.popular, base);
  const popular = new Set(ranked);
  const topRegistrable = new Set(ranked.slice(0, config.popular.topRegistrable));
  const psl = parseSuffixList(await downloadText(config.suffixList.url, base));
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
  if (previousTotal > 0 && total < previousTotal / 2 && !input.allowShrink) {
    throw new Error(`refusing to publish: ${total} entries, previously ${previousTotal}. Publish with "allow shrink" if this is intended (see the README).`);
  }

  const list = lines(
    [
      "cookbook: merged open threat-intelligence blocklist",
      `Built ${builtAt} from ${enabled.length} sources. ${finalDomains.length} domains, ${finalCIDRs.length} address ranges.`,
      `Format: SafeRoom list format. Sources and licenses: ${base}/attribution.txt`,
      "For testing. No warranty: check entries before you rely on them.",
      ...enabled.flatMap((s) => (s.notice ? [`Includes ${s.notice}`] : [])),
    ],
    [...finalDomains, ...finalCIDRs],
  );
  const listBytes = new TextEncoder().encode(list);
  if (listBytes.length > MAX_LIST_BYTES) {
    throw new Error(`list is ${listBytes.length} bytes, over the ${MAX_LIST_BYTES}-byte limit`);
  }
  const sha256 = [...new Uint8Array(await crypto.subtle.digest("SHA-256", listBytes))]
    .map((b) => b.toString(16).padStart(2, "0")).join("");
  const stats: Stats = {
    builtAt, domains: finalDomains.length, cidrs: finalCIDRs.length,
    removedPopular, removedAllow, removedProtected, collapsed: domains.size - finalDomains.length,
    sha256, sources: results.map((r) => r.stats),
  };

  files.push(["attribution.txt", attribution(enabled, config.popular)]);
  // Transparency: every feed entry that was left out, with the reason.
  files.push(["removed.txt", lines([`Feed entries left out of list.txt, with the reason. ${builtAt}`], removed.sort())]);
  files.push(["list.txt", list]);
  files.push(["list.txt.sha256", `${sha256}  list.txt\n`]);
  files.push(["stats.json", JSON.stringify(stats, null, 2) + "\n"]);
  files.push(["index.html", renderIndex(stats, base)]);
  console.log(`built ${finalDomains.length} domains, ${finalCIDRs.length} cidrs; removed ${removedPopular} popular, ${removedAllow} allowlisted; sha256 ${sha256}`);
  return { files, stats };
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
