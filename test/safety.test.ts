import assert from "node:assert/strict";
import { test } from "node:test";
import { normalizeCIDR, normalizeDomain } from "../build/parse.ts";
import {
  canonicalCIDR, cidrRange, isPublicSuffix, overlapsProtected, parseSuffixList, registrableDomain,
} from "../build/safety.ts";

// A slice of the real Public Suffix List, including both sections and the
// wildcard and exception forms.
const psl = parseSuffixList(`
// ===BEGIN ICANN DOMAINS===
com
uk
co.uk
com.au
*.ck
!www.ck
рф
// ===BEGIN PRIVATE DOMAINS===
github.io
pages.dev
s3.amazonaws.com
`);

test("public suffixes", () => {
  for (const s of ["co.uk", "com.au", "github.io", "pages.dev", "s3.amazonaws.com", "anything.ck", "xn--p1ai"]) {
    assert.ok(isPublicSuffix(s, psl), s);
  }
  for (const s of ["www.ck", "bbc.co.uk", "bad.github.io", "evil.com"]) {
    assert.ok(!isPublicSuffix(s, psl), s);
  }
});

test("registrable domains", () => {
  assert.equal(registrableDomain("www.google.com", psl), "google.com");
  assert.equal(registrableDomain("a.b.bbc.co.uk", psl), "bbc.co.uk");
  assert.equal(registrableDomain("bad.github.io", psl), "bad.github.io");
  assert.equal(registrableDomain("x.bad.github.io", psl), "bad.github.io");
  assert.equal(registrableDomain("bucket.s3.amazonaws.com", psl), "bucket.s3.amazonaws.com");
  assert.equal(registrableDomain("co.uk", psl), null);
  assert.equal(registrableDomain("www.ck", psl), "www.ck");
});

test("canonical CIDRs", () => {
  assert.equal(canonicalCIDR("1.2.3.4/8"), "1.0.0.0/8");
  assert.equal(canonicalCIDR("2001:DB8:0:0:1::5/32"), "2001:db8::/32");
  assert.equal(canonicalCIDR("2001:db8::1/128"), "2001:db8::1/128");
  assert.equal(canonicalCIDR("::ffff:1.2.3.4/128"), "::ffff:102:304/128");
  assert.deepEqual(cidrRange("10.0.0.0/8"), { family: 4, start: 0x0a000000n, end: 0x0affffffn });
});

test("protected ranges", () => {
  assert.equal(overlapsProtected("104.0.0.0/8"), "104.16.0.0/12");
  assert.equal(overlapsProtected("1.1.1.1/32"), "1.1.1.0/24");
  assert.equal(overlapsProtected("::ffff:0:0/96"), "::ffff:0:0/96");
  assert.equal(overlapsProtected("192.168.1.0/24"), "192.168.0.0/16");
  assert.equal(overlapsProtected("17.253.144.10/32"), "17.0.0.0/8");
  assert.equal(overlapsProtected("2606:4700::1/128"), "2606:4700::/32");
  assert.equal(overlapsProtected("1.10.16.0/20"), null); // a real Spamhaus DROP entry
  assert.equal(overlapsProtected("203.0.113.0/24"), null);
});

test("parser rejects the review's crafted inputs", () => {
  assert.equal(normalizeDomain("１.１.１.１"), null); // full-width digits
  assert.equal(normalizeDomain("127.1"), null);
  assert.equal(normalizeDomain("0x7f.1"), null);
  assert.equal(normalizeDomain("evil.com%eth0"), null);
  assert.equal(normalizeCIDR("fe80::1%eth0"), null);
  assert.equal(normalizeCIDR("1.1.1.1/008"), null);
  assert.equal(normalizeCIDR("1.2.3.4/8"), "1.0.0.0/8");
  assert.equal(normalizeCIDR("2a00::/16"), null); // shorter than /24
});

test("critical apexes and their parents are protected, customer hosts are not", async () => {
  const { CRITICAL_NAMES } = await import("../build/safety.ts");
  const { isUnder } = await import("../build/parse.ts");
  const protectedName = (d: string) => CRITICAL_NAMES.some((c) => isUnder(c, d));
  assert.ok(protectedName("cloudfront.net"));
  assert.ok(protectedName("amazonaws.com")); // parent of s3.amazonaws.com
  assert.ok(protectedName("s3.amazonaws.com"));
  assert.ok(!protectedName("d1xkyo9j4r7vnn.cloudfront.net"));
  assert.ok(!protectedName("jnswire.s3.amazonaws.com"));
});
