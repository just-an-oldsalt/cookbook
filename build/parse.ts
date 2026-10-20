// Parsing and normalizing feed text. Pure functions, so every rule has a test.
//
// The output is the SafeRoom list format (docs/list-format.md in the SafeRoom
// repo): a bare domain blocks that name and every name under it, and a CIDR
// blocks DNS answers in that range.

import { isIP } from "node:net";
import { canonicalCIDR } from "./safety.ts";

export type Format =
  | "domains" // one name per line
  | "hosts" //   0.0.0.0 name [name...]
  | "adblock" // ||name^
  | "urls" //    full URLs: keep the host
  | "cidr"; //   one IP or CIDR per line, ";" or "#" comments

export interface Parsed {
  domains: Set<string>;
  cidrs: Set<string>;
  invalid: number;
}

const LABEL = /^[a-z0-9_](?:[a-z0-9_-]{0,61}[a-z0-9_])?$/;

/** Names hosts files list for loopback. Never rules. */
const HOSTS_NOISE = new Set([
  "localhost", "localhost.localdomain", "local", "broadcasthost",
  "ip6-localhost", "ip6-loopback", "0.0.0.0",
]);

/**
 * Lowercase ASCII, punycode for international names, no trailing dot.
 * Returns null for anything that is not a usable multi-label domain.
 */
export function normalizeDomain(raw: string): string | null {
  let name = raw.trim().toLowerCase();
  if (name.startsWith("*.")) name = name.slice(2); // feeds mean "this and below"
  if (name.startsWith(".")) name = name.slice(1);
  if (name.endsWith(".")) name = name.slice(0, -1);
  if (!name || name.length > 253 || name.includes("%")) return null;
  if (!/^[\x00-\x7f]*$/.test(name)) {
    try {
      name = new URL(`http://${name}/`).hostname; // converts to punycode
    } catch {
      return null;
    }
  }
  // After the Unicode step: full-width digits become an IP address here.
  if (isIP(name)) return null;
  const labels = name.split(".");
  // A single label would block a whole TLD; no feed means that.
  if (labels.length < 2) return null;
  // No TLD is all digits; "127.1" and similar are IP shorthand.
  if (/^\d+$/.test(labels[labels.length - 1])) return null;
  return labels.every((l) => LABEL.test(l)) ? name : null;
}

/** An IPv4 or IPv6 address or CIDR, in canonical text, or null. */
export function normalizeCIDR(raw: string): string | null {
  const [address, prefixText, ...rest] = raw.trim().split("/");
  if (rest.length || address.includes("%")) return null; // no zone IDs
  const family = isIP(address);
  if (!family) return null;
  const max = family === 4 ? 32 : 128;
  if (prefixText === undefined) return canonicalCIDR(`${address}/${max}`);
  if (!/^(0|[1-9]\d{0,2})$/.test(prefixText)) return null; // no "/008"
  const prefix = Number(prefixText);
  if (prefix > max) return null;
  // Very short prefixes are a feed error, not a threat: /0 to /7 would
  // cover a sixteenth of the IPv4 internet or more.
  if (family === 4 && prefix < 8) return null;
  if (family === 6 && prefix < 24) return null;
  return canonicalCIDR(`${address}/${prefix}`);
}

function stripComment(line: string): string {
  const hash = line.indexOf("#");
  const cut = hash >= 0 ? line.slice(0, hash) : line;
  const semi = cut.indexOf(";"); // Spamhaus style: "1.2.3.0/24 ; SBL123"
  return (semi >= 0 ? cut.slice(0, semi) : cut).trim();
}

export function parse(text: string, format: Format): Parsed {
  const out: Parsed = { domains: new Set(), cidrs: new Set(), invalid: 0 };
  const addDomain = (raw: string) => {
    const d = normalizeDomain(raw);
    if (d) out.domains.add(d);
    else out.invalid++;
  };

  for (const rawLine of text.split(/\r?\n/)) {
    if (format === "adblock" && rawLine.trimStart().startsWith("!")) continue;
    const line = stripComment(rawLine);
    if (!line) continue;

    switch (format) {
      case "domains":
        addDomain(line.split(/\s+/)[0]);
        break;
      case "hosts": {
        const fields = line.split(/\s+/);
        if (fields.length < 2 || !isIP(fields[0])) {
          out.invalid++;
          break;
        }
        for (const name of fields.slice(1)) {
          if (!HOSTS_NOISE.has(name.toLowerCase())) addDomain(name);
        }
        break;
      }
      case "adblock": {
        const m = /^\|\|([^/^$]+)\^?(\$.*)?$/.exec(line);
        // Rules with options ($third-party and so on) are not plain blocks.
        if (m && !m[2]) addDomain(m[1]);
        else out.invalid++;
        break;
      }
      case "urls": {
        try {
          const host = new URL(line).hostname.replace(/^\[|\]$/g, "");
          if (isIP(host)) {
            const c = normalizeCIDR(host);
            if (c) out.cidrs.add(c);
          } else {
            addDomain(host);
          }
        } catch {
          out.invalid++;
        }
        break;
      }
      case "cidr": {
        const c = normalizeCIDR(line.split(/\s+/)[0]);
        if (c) out.cidrs.add(c);
        else out.invalid++;
        break;
      }
    }
  }
  return out;
}

/** True if `name` is `parent` or under it. */
export function isUnder(name: string, parent: string): boolean {
  return name === parent || name.endsWith(`.${parent}`);
}

/**
 * Drops names whose parent domain is also in the set. SafeRoom blocks a bare
 * name and everything below it, so `a.evil.com` adds nothing when `evil.com`
 * is listed.
 */
export function collapseSubdomains(domains: Iterable<string>): string[] {
  const set = new Set(domains);
  const kept: string[] = [];
  for (const name of set) {
    const labels = name.split(".");
    let covered = false;
    for (let i = 1; i < labels.length - 1; i++) {
      if (set.has(labels.slice(i).join("."))) {
        covered = true;
        break;
      }
    }
    if (!covered) kept.push(name);
  }
  return kept.sort();
}
