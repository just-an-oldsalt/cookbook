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
- The Block List Project malware list. Its 2.6 million entries would make the file larger than the 25 MiB limit for one file.

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
5. It refuses to publish a list with less than half the entries of the last list. The last list then stays online. To publish a smaller list on purpose, run the workflow by hand with "allow shrink".

If a source fails, its last published copy is used for up to 48 hours. If a source suddenly halves or more than doubles, its previous copy is held for up to 48 hours. A sudden change is more often a broken or compromised feed than a real one. After 48 hours, the new data is used, so a real change is delayed but never blocked. Each fallback or hold shows as a warning on the workflow run and on the index page.

## Build it yourself

You need Node 24 or later.

```sh
npm ci
npm test
npm run build   # writes dist/
```

The workflow in `.github/workflows/build.yml` runs the build every 6 hours and deploys `dist/` as static assets on Cloudflare Workers. Static asset requests are free and have no daily limit.

The workflow has two jobs. The build job reads the feeds. It has no secrets and installs no packages. The deploy job holds the Cloudflare token. It runs only from `main`, in the `production` environment, with npm install scripts turned off. Each action is pinned to a commit SHA.

The `production` environment needs two secrets: `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN`. Give the token the smallest scope that deploys: a custom token with "Workers Scripts: Edit" on the account and "Workers Routes: Edit" on the zone, with an expiry date. The "Edit Cloudflare Workers" template also grants KV, R2, and Pages, which the deploy does not need.

For the first build of a new site, run the workflow by hand with "first build". Every later build needs the published `stats.json`, because the safety rules compare against it.

## License

The code is under the Apache License 2.0. Each part of the list keeps the license of its source. See `/attribution.txt`.
