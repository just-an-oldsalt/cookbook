import assert from "node:assert/strict";
import { test } from "node:test";
import { collapseSubdomains, isUnder, normalizeCIDR, normalizeDomain, parse } from "../build/parse.ts";

test("normalizeDomain", () => {
  assert.equal(normalizeDomain("  Evil.COM. "), "evil.com");
  assert.equal(normalizeDomain("*.evil.com"), "evil.com");
  assert.equal(normalizeDomain(".evil.com"), "evil.com");
  assert.equal(normalizeDomain("_dmarc.evil.com"), "_dmarc.evil.com");
  assert.equal(normalizeDomain("bücher.example"), "xn--bcher-kva.example");
  for (const bad of ["com", "evil..com", "-", "1.2.3.4", "ev!l.com", "-evil.com", ""]) {
    assert.equal(normalizeDomain(bad), null, bad);
  }
});

test("normalizeCIDR", () => {
  assert.equal(normalizeCIDR("203.0.113.9"), "203.0.113.9/32");
  assert.equal(normalizeCIDR("198.51.100.0/24"), "198.51.100.0/24");
  assert.equal(normalizeCIDR("2001:DB8::/32"), "2001:db8::/32");
  for (const bad of ["1.2.3.0/33", "0.0.0.0/0", "10.0.0.0/7", "::/8", "1.2.3", "x/24", "1.2.3.0/24/1"]) {
    assert.equal(normalizeCIDR(bad), null, bad);
  }
});

test("domains format", () => {
  const p = parse("# header\nevil.com\nEVIL.com # dup\nbad..name\n\nb.net extra-field\n", "domains");
  assert.deepEqual([...p.domains].sort(), ["b.net", "evil.com"]);
  assert.equal(p.invalid, 1);
});

test("hosts format", () => {
  const p = parse("127.0.0.1 localhost\n0.0.0.0 a.com b.com\n:: c.org\nnot-hosts.com\n", "hosts");
  assert.deepEqual([...p.domains].sort(), ["a.com", "b.com", "c.org"]);
  assert.equal(p.invalid, 1);
});

test("adblock format", () => {
  const p = parse("! comment\n||evil.com^\n||x.org^$third-party\n@@||good.com^\n", "adblock");
  assert.deepEqual([...p.domains], ["evil.com"]);
  assert.equal(p.invalid, 2);
});

test("urls format", () => {
  const p = parse("http://Evil.com:8080/x.exe\nhttps://203.0.113.5/a\nhttps://[2001:db8::1]/b\nnot a url\n", "urls");
  assert.deepEqual([...p.domains], ["evil.com"]);
  assert.deepEqual([...p.cidrs].sort(), ["2001:db8::1/128", "203.0.113.5/32"]);
  assert.equal(p.invalid, 1);
});

test("cidr format with Spamhaus comments", () => {
  const p = parse("; Spamhaus DROP\n1.10.16.0/20 ; SBL256894\n203.0.113.9\n", "cidr");
  assert.deepEqual([...p.cidrs].sort(), ["1.10.16.0/20", "203.0.113.9/32"]);
});

test("collapseSubdomains", () => {
  assert.deepEqual(
    collapseSubdomains(["a.evil.com", "evil.com", "b.c.evil.com", "notevil.com", "x.other.org"]),
    ["evil.com", "notevil.com", "x.other.org"],
  );
});

test("isUnder", () => {
  assert.ok(isUnder("a.apple.com", "apple.com"));
  assert.ok(isUnder("apple.com", "apple.com"));
  assert.ok(!isUnder("notapple.com", "apple.com"));
});
