# cookbook

cookbook merges open threat-intelligence blocklists into one list of malicious domains and address ranges. It publishes the list at https://cookbook.oldsalt.zone/list.txt. A new list is built every 6 hours.

The list uses the [SafeRoom](https://github.com/just-an-oldsalt/saferoom) list format. Any DNS blocker that reads one domain per line can also use it.

The name comes from Dungeon Crawler Carl. The Dungeon Anarchist's Cookbook holds what past crawlers learned, passed on to the next ones.

This list is for testing and for people who want a free starting point. It has no warranty. Read [the sources](#sources) before you rely on it.

## Files

| Path | Content |
|---|---|
| `/list.txt` | The merged list. |
| `/list.txt.sha256` | The SHA-256 of `list.txt`. |
| `/stats.json` | Counts, and the status of each source. |
| `/attribution.txt` | Each source and its license. |
| `/removed.txt` | Feed entries left out for safety, each with the reason. |
| `/sources/<id>.txt` | Each source on its own, normalized. |

## Sources

A source is in the list only if its license allows redistribution. The sources are in [sources.json](sources.json).

| Source | Content | License |
|---|---|---|
| [CERT Polska warning list](https://cert.pl/en/warning-list/) | Phishing and fraud domains | Free for any use |
| [Spamhaus DROP](https://www.spamhaus.org/blocklists/do-not-route-or-peer/) | Hijacked and criminal address ranges | Free with credit to Spamhaus |
| [The Block List Project](https://github.com/blocklistproject/Lists): phishing, ransomware, scam | Domains | Unlicense |

These feeds are not in the list:

- URLhaus and ThreatFox (abuse.ch). The current abuse.ch terms do not allow derivative works without consent.
- OpenPhish and Phishing Army. The OpenPhish terms forbid redistribution, and Phishing Army includes OpenPhish data.
- HaGeZi Threat Intelligence Feeds. Its GPL-3.0 license would apply to the whole published list. It is in `sources.json`, but turned off.
- The Block List Project malware list. Its 2.6 million entries were over the 25 MiB file limit of the old static-asset hosting. R2 has no such limit, so this list can be added later.

## How a list is built

1. The builder downloads each source and keeps the valid domains and address ranges.
2. It leaves out every entry that could break the web for everyone who uses the list. Each one goes to `removed.txt` with the reason:
   - A public suffix from the [Public Suffix List](https://publicsuffix.org/), for example `co.uk`, `github.io`, or `s3.amazonaws.com`. Nobody owns these names, and one of them would block every site under it.
   - A site in the Tranco top 100,000.
   - A name under a site in the Tranco top 10,000, for example `www.google.com`. Customer sites under known hosting platforms, for example `bad.weebly.com`, stay in the list. The platforms are in `HOSTING_PLATFORMS` in `build/safety.ts`.
   - A shared service apex, or a parent of one, for example `cloudfront.net` or `amazonaws.com`. Customer names under them stay.
   - An address range that overlaps private space, a public DNS resolver, or the core ranges of Apple, Cloudflare, Google, Akamai, or Fastly.
3. It removes the names in [allow.txt](allow.txt) and the SafeRoom never-block names (Apple, Jamf, Okta), with all names under them.
4. It drops each domain whose parent is also listed. `a.evil.com` adds nothing when `evil.com` is listed.
5. It refuses to publish a list with less than half the entries of the last list. The last list then stays online. To publish a smaller list on purpose, see [Manual builds](#manual-builds).

If a source fails, its last published copy is used for up to 48 hours. If a source suddenly halves or more than doubles, its previous copy is held for up to 48 hours. A sudden change is more often a broken or compromised feed than a real one. After 48 hours, the new data is used, so a real change is delayed but never blocked. Each fallback or hold shows as a warning in the Worker logs and on the index page.

## Build it yourself

You need Node 24 or later.

```sh
npm ci
npm test
npm run build   # writes dist/
```

`npm run build` reads the previous build from the live site, because the guards compare against it. It writes the files to `dist/` and publishes nothing.

## How the list is published

One Worker, `cookbook` in `src/worker.ts`, does all the work. It runs on the Cloudflare Workers Paid plan.

- Its cron trigger runs the build every 6 hours. The build stores the files in the R2 bucket `cookbook`. A build takes about 2 seconds of CPU time.
- Its fetch handler serves the files from the bucket at `cookbook.oldsalt.zone`.

The Worker reads and writes the bucket through its binding, so no API token is needed. The builder in `build/core.ts` uses only web-standard APIs, so the Worker and `npm run build` run the same code.

A list update changes only the files in the bucket. It never deploys the Worker. A code change deploys the Worker through Workers Builds, on each push to `main`. Workers Builds runs `npm ci --ignore-scripts && npm test` and then `npx wrangler deploy`, with the build variable `SKIP_DEPENDENCY_INSTALL` = `1`. These settings are in the Cloudflare dashboard, under Workers & Pages, cookbook, Settings, Build.

### Manual builds

The scheduled build refuses to publish when the guards fail. To publish from your own machine, log in with `npx wrangler login`, then run one of these commands:

```sh
npm run publish                            # build and upload to the bucket
node build/cli.ts --publish --allow-shrink # publish a list with less than half the entries of the last list
node build/cli.ts --publish --first-build  # the first build of a new bucket, without a previous stats.json
```

To test a change to the Worker, run `npx wrangler dev --test-scheduled`, then open `http://localhost:8787/__scheduled`. The local run uses a local copy of the bucket. Upload `stats.json` and `sources/` into it first with `npx wrangler r2 object put --local`.

## License

The code is under the Apache License 2.0. Each part of the list keeps the license of its source. See `/attribution.txt`.
