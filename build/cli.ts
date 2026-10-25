// Builds the list on this machine, into dist/. With --publish, also uploads
// the files to the R2 bucket, the same way the Worker's scheduled build does.
// Use it to test a change, or to publish a build the guards would refuse.
//
//   node build/cli.ts [--publish] [--allow-shrink] [--first-build]
//
//   --publish       upload dist/ to the R2 bucket (needs `wrangler login`)
//   --allow-shrink  publish even if the list shrinks by more than half
//                   (after a deliberate source removal)
//   --first-build   build without the previous stats.json (only for the
//                   very first build)
//
// Environment:
//   COOKBOOK_URL  where the current list is published; used for the
//                 previous stats and for per-source fallbacks
//                 (default https://cookbook.oldsalt.zone)

import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { type Config, type Stats, buildList } from "./core.ts";

const BUCKET = "cookbook";
const ROOT = new URL("..", import.meta.url).pathname;
const DIST = join(ROOT, "dist");
const BASE = (process.env.COOKBOOK_URL ?? "https://cookbook.oldsalt.zone").replace(/\/$/, "");
const args = new Set(process.argv.slice(2));

async function published(path: string): Promise<string | null> {
  const response = await fetch(`${BASE}/${path}`, { signal: AbortSignal.timeout(60_000) });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`${path}: HTTP ${response.status}`);
  return response.text();
}

async function previousStats(): Promise<Stats | undefined> {
  if (args.has("--first-build")) return undefined;
  const text = await published("stats.json").catch((error) => { throw new Error(`cannot read the previous stats.json (${error.message})`); });
  if (text === null) throw new Error("no published stats.json; refusing to build without the guards. Use --first-build only for a first build.");
  return JSON.parse(text) as Stats;
}

const { files } = await buildList({
  config: JSON.parse(readFileSync(join(ROOT, "sources.json"), "utf8")) as Config,
  allow: readFileSync(join(ROOT, "allow.txt"), "utf8"),
  previous: await previousStats(),
  previousSource: (id) => published(`sources/${id}.txt`),
  allowShrink: args.has("--allow-shrink"),
  base: BASE,
});

rmSync(DIST, { recursive: true, force: true });
for (const [path, content] of files) {
  mkdirSync(dirname(join(DIST, path)), { recursive: true });
  writeFileSync(join(DIST, path), content);
}
console.log(`wrote ${files.length} files to dist/`);

if (args.has("--publish")) {
  for (const [path] of files) {
    execFileSync("npx", ["wrangler", "r2", "object", "put", `${BUCKET}/${path}`, "--file", join(DIST, path), "--remote"], { stdio: "inherit" });
  }
  console.log(`published ${files.length} files to r2://${BUCKET}`);
}
