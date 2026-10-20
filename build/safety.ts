// Guards that keep one bad feed from breaking the web for everyone who uses
// the list. A compromised feed controls every byte it serves; these rules
// decide what it can never publish, whatever it says.

import { isIP } from "node:net";

// MARK: - Public suffixes and registrable domains

/**
 * The Public Suffix List as three sets. Used only inside the build; it is
 * never republished. https://publicsuffix.org/
 */
export interface SuffixList {
  rules: Set<string>; //      "co.uk", "github.io"
  wildcards: Set<string>; //  "*.ck"  stored as "ck"
  exceptions: Set<string>; // "!www.ck" stored as "www.ck"
}

export function parseSuffixList(text: string): SuffixList {
  const list: SuffixList = { rules: new Set(), wildcards: new Set(), exceptions: new Set() };
  // Rules are written in Unicode; feeds are normalized to punycode.
  const ascii = (name: string) => new URL(`http://${name}/`).hostname;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim().split(/\s/)[0];
    if (!line || line.startsWith("//")) continue;
    if (line.startsWith("!")) list.exceptions.add(ascii(line.slice(1)));
    else if (line.startsWith("*.")) list.wildcards.add(ascii(line.slice(2)));
    else list.rules.add(ascii(line));
  }
  return list;
}

/** True if `name` is itself a public suffix: nobody can own it. */
export function isPublicSuffix(name: string, psl: SuffixList): boolean {
  if (psl.exceptions.has(name)) return false;
  if (psl.rules.has(name)) return true;
  const dot = name.indexOf(".");
  return dot > 0 && psl.wildcards.has(name.slice(dot + 1));
}

/**
 * The registrable domain (public suffix plus one label), or null when the
 * name is itself a suffix. Names with no known suffix use the last label.
 */
export function registrableDomain(name: string, psl: SuffixList): string | null {
  const labels = name.split(".");
  for (let i = 0; i < labels.length; i++) {
    const candidate = labels.slice(i).join(".");
    if (psl.exceptions.has(candidate)) return candidate;
    if (isPublicSuffix(candidate, psl)) return i === 0 ? null : labels.slice(i - 1).join(".");
  }
  return labels.length >= 2 ? labels.slice(-2).join(".") : null;
}

/**
 * Names whose loss would be an outage, whatever a feed claims. Each one is
 * protected with everything under it. Kept short and obvious on purpose;
 * popular sites in general are handled by the Tranco rule.
 */
export const CRITICAL_NAMES = [
  // Shared hosting and object storage: listing the apex blocks every customer.
  "storage.googleapis.com", "googleusercontent.com", "s3.amazonaws.com", "cloudfront.net",
  "blob.core.windows.net", "web.core.windows.net", "raw.githubusercontent.com",
  "objects.githubusercontent.com", "akamaized.net", "akamaihd.net", "fastly.net",
  // Certificate revocation and timestamping: TLS breaks without them.
  "ocsp.digicert.com", "crl.digicert.com", "ocsp.sectigo.com", "ocsp.globalsign.com",
  "lencr.org", "pki.goog", "ocsp.pki.goog",
];

/**
 * Popular registrable domains whose subdomains belong to customers, not to
 * the company: site builders, hosted forms, tenant subdomains, link tracking.
 * Feeds list thousands of phishing sites under them, each blocking only one
 * customer. These are exempt from the "under a popular site" rule, except
 * for the apex itself and its www name.
 *
 * Not on the Public Suffix List, which would handle them automatically.
 * Add one only with evidence that its subdomains are customer content.
 */
export const HOSTING_PLATFORMS = new Set([
  "godaddysites.com", "weebly.com", "webnode.com", "sharepoint.com", "beget.tech", "tumblr.com",
  "home.pl", "tripod.com", "webs.com", "secureserver.net", "b-cdn.net", "typeform.com",
  "netlify.com", "webhostbox.net", "sendgrid.net", "wixsite.com", "jimdosite.com", "site123.me",
  "square.site", "mystrikingly.com", "wordpress.com", "blogspot.com", "firebaseapp.com",
  "web.app", "glitch.me", "replit.app", "vercel.app", "onrender.com", "herokuapp.com",
]);

// MARK: - Address ranges

interface Range {
  family: 4 | 6;
  start: bigint;
  end: bigint;
}

function toBigInt(address: string, family: 4 | 6): bigint {
  if (family === 4) {
    return address.split(".").reduce((acc, part) => (acc << 8n) | BigInt(Number(part)), 0n);
  }
  // Expand "::" and any trailing dotted IPv4 part.
  let text = address;
  const v4 = /(\d+\.\d+\.\d+\.\d+)$/.exec(text);
  if (v4) {
    const n = toBigInt(v4[1], 4);
    text = text.slice(0, -v4[1].length) + `${(n >> 16n).toString(16)}:${(n & 0xffffn).toString(16)}`;
  }
  const [head, tail] = text.split("::");
  const headParts = head ? head.split(":") : [];
  const tailParts = tail !== undefined && tail !== "" ? tail.split(":") : [];
  const fill = tail === undefined ? [] : Array(8 - headParts.length - tailParts.length).fill("0");
  return [...headParts, ...fill, ...tailParts].reduce((acc, part) => (acc << 16n) | BigInt(parseInt(part, 16)), 0n);
}

function fromBigInt(value: bigint, family: 4 | 6): string {
  if (family === 4) {
    return [24n, 16n, 8n, 0n].map((s) => ((value >> s) & 0xffn).toString()).join(".");
  }
  const groups = Array.from({ length: 8 }, (_, i) => ((value >> BigInt(112 - 16 * i)) & 0xffffn).toString(16));
  // Longest run of zero groups becomes "::".
  let best = -1, bestLen = 0;
  for (let i = 0; i < 8; ) {
    if (groups[i] !== "0") { i++; continue; }
    let j = i;
    while (j < 8 && groups[j] === "0") j++;
    if (j - i > bestLen && j - i > 1) { best = i; bestLen = j - i; }
    i = j;
  }
  if (best < 0) return groups.join(":");
  return `${groups.slice(0, best).join(":")}::${groups.slice(best + bestLen).join(":")}`;
}

/** Parses "a.b.c.d/n" or "x::/n" into an inclusive range. Null if invalid. */
export function cidrRange(cidr: string): Range | null {
  const [address, prefixText] = cidr.split("/");
  const family = isIP(address);
  if (family !== 4 && family !== 6 || prefixText === undefined || !/^\d{1,3}$/.test(prefixText)) return null;
  const bits = family === 4 ? 32 : 128;
  const prefix = Number(prefixText);
  if (prefix > bits) return null;
  const hostBits = BigInt(bits - prefix);
  const value = toBigInt(address, family);
  const start = (value >> hostBits) << hostBits;
  return { family, start, end: start | ((1n << hostBits) - 1n) };
}

/** The canonical form: host bits cleared, shortest address text. */
export function canonicalCIDR(cidr: string): string | null {
  const range = cidrRange(cidr);
  if (!range) return null;
  const prefix = cidr.split("/")[1];
  return `${fromBigInt(range.start, range.family)}/${Number(prefix)}`;
}

/**
 * Ranges a feed may never touch. Blocking any address in them would break
 * local networks, DNS resolvers, or a large share of the web, so a feed
 * range that overlaps one is refused whole.
 */
export const PROTECTED_CIDRS = [
  // Private, local, and special-use space.
  "0.0.0.0/8", "10.0.0.0/8", "100.64.0.0/10", "127.0.0.0/8", "169.254.0.0/16",
  "172.16.0.0/12", "192.168.0.0/16", "224.0.0.0/3",
  "::/96", "::1/128", "::ffff:0:0/96", "64:ff9b::/96", "fc00::/7", "fe80::/10", "ff00::/8",
  // Public DNS resolvers.
  "1.1.1.0/24", "1.0.0.0/24", "8.8.8.0/24", "8.8.4.0/24", "9.9.9.0/24", "149.112.112.0/24",
  "208.67.222.0/24", "208.67.220.0/24", "2606:4700:4700::/48", "2001:4860:4860::/48", "2620:fe::/48",
  // Apple, Cloudflare, Google, Akamai, and Fastly core space.
  "17.0.0.0/8", "2620:149::/32",
  "104.16.0.0/12", "172.64.0.0/13", "162.158.0.0/15", "2606:4700::/32",
  "142.250.0.0/15", "172.217.0.0/16", "216.58.192.0/19", "2607:f8b0::/32",
  "23.32.0.0/11", "2.16.0.0/13", "151.101.0.0/16", "2a04:4e40::/32",
];

const PROTECTED_RANGES = PROTECTED_CIDRS.map((c) => cidrRange(c)!);

/** The protected range that `cidr` overlaps, or null. */
export function overlapsProtected(cidr: string): string | null {
  const range = cidrRange(cidr);
  if (!range) return "invalid";
  const i = PROTECTED_RANGES.findIndex(
    (p) => p.family === range.family && range.start <= p.end && p.start <= range.end,
  );
  return i >= 0 ? PROTECTED_CIDRS[i] : null;
}
