---
name: google-marketing-axi
description: "Query GA4 reports and inspect or edit Google Tag Manager containers through the google-marketing-axi CLI. Use whenever a task touches Google Analytics or GTM: traffic, conversion or event reports, realtime users, finding a dimension or metric, listing or reading GTM tags/triggers/variables, changing them with a diffed dry-run first, checking workspace status, or snapshotting a container version."
user-invocable: false
---

# google-marketing-axi

Agent-ergonomic wrapper around the GA4 Data/Admin APIs and the Tag Manager
API v2. Prefer it over the raw REST APIs or ad hoc scripts.

## Current guidance lives in the CLI

Do not follow command or flag details from this file - installed copies go
stale. Get the source of truth from the CLI:

- `npx -y google-marketing-axi` for the home view and cached defaults
- `npx -y google-marketing-axi --help` for the command index
- `npx -y google-marketing-axi <command> <subcommand> --help` for per-command usage

## The things that matter

- Auth is Google Application Default Credentials. If a command fails with
  an auth or scope error, it prints the exact re-login command to run.
  `whoami` shows scopes and the quota project without printing secrets.
- `ga use <property>` and `gtm use <gtm-url>` cache defaults, so later
  commands need no IDs.
- Run every GTM write with `--dry-run` first and read the diff before
  sending it. GTM containers are usually live client sites.
- There is no publish command. `gtm version create` stops short, and a
  human publishes the version in the GTM UI.
