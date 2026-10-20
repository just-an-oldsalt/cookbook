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
| `/removed-popular.txt` | Feed entries left out because they are popular sites. |
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
2. It removes every domain in the Tranco top 100,000. Feeds often keep legitimate sites that were compromised once. A listed subdomain of a hosting platform, such as `bad.pages.dev`, stays in the list.
3. It removes the names in [allow.txt](allow.txt) and the SafeRoom never-block names (Apple, Jamf, Okta), with all names under them.
4. It drops each domain whose parent is also listed. `a.evil.com` adds nothing when `evil.com` is listed.
5. It refuses to publish a list with less than half the entries of the last list. The last list then stays online.

If one source fails, or loses more than half of its entries, the builder uses the last published copy of that source.

## Build it yourself

You need Node 24 or later.

```sh
npm ci
npm test
npm run build   # writes dist/
```

The workflow in `.github/workflows/build.yml` runs the build every 6 hours and deploys `dist/` as static assets on Cloudflare Workers. Static asset requests are free and have no daily limit. The workflow needs the repository secrets `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`.

## License

The code is under the Apache License 2.0. Each part of the list keeps the license of its source. See `/attribution.txt`.
