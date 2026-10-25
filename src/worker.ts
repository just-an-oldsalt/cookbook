// The cookbook Worker. Every 6 hours it builds the list and stores the files
// in the R2 bucket. Between builds it serves those files at
// cookbook.oldsalt.zone. Code changes deploy through Workers Builds; list
// updates never deploy anything.

import config from "../sources.json";
import allow from "../allow.txt";
import { type Config, type Stats, buildList } from "../build/core.ts";

interface Env {
  LIST: R2Bucket;
  /** Where the list is published. */
  BASE: string;
}

export default {
  async scheduled(_controller: ScheduledController, env: Env): Promise<void> {
    await publish(env);
  },

  async fetch(request: Request, env: Env): Promise<Response> {
    return serve(request, env);
  },
};

async function publish(env: Env): Promise<void> {
  // Without the previous stats every guard compares against zero and is off.
  // The first build, and builds the guards refuse, run from build/cli.ts.
  const stored = await env.LIST.get("stats.json");
  if (!stored) throw new Error("no stats.json in the bucket; refusing to build without the guards. Publish the first build with build/cli.ts --first-build.");
  const previous = (await stored.json()) as Stats;

  const { files } = await buildList({
    config: config as Config,
    allow,
    previous,
    previousSource: async (id) => (await env.LIST.get(`sources/${id}.txt`))?.text() ?? null,
    allowShrink: false,
    base: env.BASE,
  });

  // In the returned order: the list and its checksum come last.
  for (const [path, content] of files) await env.LIST.put(path, content);

  // A source that was turned off leaves no stale copy behind.
  const current = new Set(files.map(([path]) => path));
  const listed = await env.LIST.list({ prefix: "sources/" });
  const stale = listed.objects.map((o) => o.key).filter((key) => !current.has(key));
  if (stale.length) await env.LIST.delete(stale);
  console.log(`published ${files.length} files${stale.length ? `, deleted ${stale.join(", ")}` : ""}`);
}

const PAGE_CSP = "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
const NOT_FOUND = "<!doctype html><title>Not found</title><p>Not found. The list is at <a href=\"/list.txt\">/list.txt</a>.</p>\n";
/** Published paths: lowercase names, one optional directory. Anything else is not found. */
const KEY = /^(?:[a-z0-9-]+\/)?[a-z0-9-]+(?:\.[a-z0-9]+)+$/;

async function serve(request: Request, env: Env): Promise<Response> {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return new Response("Method not allowed\n", { status: 405, headers: { allow: "GET, HEAD" } });
  }
  const path = new URL(request.url).pathname;
  const key = path === "/" ? "index.html" : path.slice(1);
  const object = KEY.test(key) ? await env.LIST.get(key, { onlyIf: request.headers }) : null;

  const headers = new Headers({
    "x-content-type-options": "nosniff",
    "strict-transport-security": "max-age=31536000",
    "access-control-allow-origin": "*",
  });
  if (!object) {
    headers.set("content-type", "text/html; charset=utf-8");
    headers.set("content-security-policy", PAGE_CSP);
    return new Response(request.method === "HEAD" ? null : NOT_FOUND, { status: 404, headers });
  }

  headers.set("content-type", contentType(key));
  headers.set("cache-control", "public, max-age=300");
  headers.set("etag", object.httpEtag);
  headers.set("last-modified", object.uploaded.toUTCString());
  if (key.endsWith(".html")) headers.set("content-security-policy", PAGE_CSP);
  // A failed If-None-Match or If-Modified-Since check returns the object without a body.
  if (!("body" in object)) return new Response(null, { status: 304, headers });
  headers.set("content-length", String(object.size));
  return new Response(request.method === "HEAD" ? null : object.body, { headers });
}

function contentType(key: string): string {
  if (key.endsWith(".html")) return "text/html; charset=utf-8";
  if (key.endsWith(".json")) return "application/json";
  return "text/plain; charset=utf-8";
}
