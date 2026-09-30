# google-marketing-axi

Google marketing products (GA4 and Google Tag Manager) for agents, built to the [AXI](https://axi.md) conventions.

Wraps the [GA4 Data API](https://developers.google.com/analytics/devguides/reporting/data/v1), the [GA4 Admin API](https://developers.google.com/analytics/devguides/config/admin/v1) and the [Tag Manager API v2](https://developers.google.com/tag-platform/tag-manager/api/v2) with TOON output, cached defaults, diffed writes and exit codes you can gate on.

## Why

| Raw Google APIs | google-marketing-axi |
| --- | --- |
| Reports return parallel header/value arrays with every metric as a string | Keyed rows, real numbers, ISO dates, totals, and a "5 of 1163 rows" count |
| Filters are nested `FilterExpression` JSON | `--filter "sessions>10" --filter "pagePath=@/products"` |
| GTM lists return trigger IDs, nested `parameter` trees and API plumbing | Firing triggers by name, flattened parameters, conditions as sentences |
| GTM updates need the full resource plus its fingerprint | `update` fetches, merges your patch, shows a before/after diff and sends the fingerprint |
| Every call needs account/container/workspace IDs | `gtm use <url>` caches them from any GTM UI link |
| Auth is a separate OAuth client per tool | Google Application Default Credentials, nothing extra to set up |
| No exit codes - just HTTP status | Exit `0` success, `1` error, `2` usage error |

There is deliberately no GTM publish command.
`gtm version create` snapshots the workspace, and a human publishes it in the GTM UI.

## Install

```sh
npm install -g google-marketing-axi
```

Or run it with no install at all: `npx -y google-marketing-axi`.

Install the skill so agents reach for it on their own:

```sh
npx skills add ./skills/google-marketing-axi -g
```

Optional ambient context in every agent session:

```sh
google-marketing-axi setup hooks
```

## Auth

Sign in once with gcloud Application Default Credentials, requesting the GA and GTM scopes:

```sh
gcloud auth application-default login \
  --client-id-file=<oauth-client.json> \
  --scopes=https://www.googleapis.com/auth/analytics.readonly,https://www.googleapis.com/auth/tagmanager.edit.containers,https://www.googleapis.com/auth/tagmanager.edit.containerversions,https://www.googleapis.com/auth/cloud-platform
```

Every request is billed to the credentials file's `quota_project_id` (sent as `x-goog-user-project`).
If `gcloud auth application-default set-quota-project` fails (it needs the Cloud Resource Manager API), add `"quota_project_id": "<project>"` to the credentials file by hand, or set `GOOGLE_CLOUD_QUOTA_PROJECT`.
`google-marketing-axi whoami` shows the scopes and quota project in use without printing any secret.

## Usage

```sh
google-marketing-axi                                   # home: credentials and cached defaults
google-marketing-axi whoami                            # scopes, quota project, what each command can do
google-marketing-axi ga accounts                       # accounts and GA4 properties
google-marketing-axi ga use 123456789                  # cache the default --property
google-marketing-axi ga report --metrics sessions,totalUsers --dims sessionDefaultChannelGroup --range 28d
google-marketing-axi ga report --metrics screenPageViews --dims pagePath --filter "pagePath=@/products" --limit 20
google-marketing-axi ga realtime --dims country
google-marketing-axi ga dims purchase                  # search dimensions and metrics
google-marketing-axi gtm use "https://tagmanager.google.com/#/container/accounts/<a>/containers/<c>/workspaces/<w>"
google-marketing-axi gtm tags purchase                 # compact list, firing triggers by name
google-marketing-axi gtm tag "GA4 - purchase"          # full detail
google-marketing-axi gtm variable "DLV - value"        # detail plus what references it
google-marketing-axi gtm tag update "GA4 - purchase" --param eventName=purchase --dry-run
google-marketing-axi gtm tag create --file tag.json --dry-run
google-marketing-axi gtm status                        # pending workspace changes and conflicts
google-marketing-axi gtm version create --name "Purchase fixes" --notes "..." --dry-run
google-marketing-axi update --check
```

Every GTM write prints a before/after diff, and `--dry-run` stops before anything is sent.
Writes that would change nothing are reported as no-ops and exit `0`.

## AXI compliance

Exit codes follow the spec: `0` success, `1` error, `2` usage error.

## Environment

| Variable | Effect |
| --- | --- |
| `GOOGLE_APPLICATION_CREDENTIALS` | Credentials file (default `~/.config/gcloud/application_default_credentials.json`) |
| `CLOUDSDK_CONFIG` | gcloud config directory, used when `GOOGLE_APPLICATION_CREDENTIALS` is unset |
| `GOOGLE_CLOUD_QUOTA_PROJECT` | Override the file's `quota_project_id` |
| `XDG_CACHE_HOME` | Where cached defaults are stored (default `~/.cache/google-marketing-axi`) |

## Development

```sh
npm install
npm test
npm run build
npm run dev -- gtm status
```

## License

MIT
