export const TOP_LEVEL_HELP = `google-analytics-axi - GA4 reporting and Google Tag Manager for agents (AXI)

Run with no arguments for the home view: cached defaults and suggested next
steps.

commands[6]{command,what}:
  whoami,Credentials in use, quota project, and OAuth scopes (alias: auth status)
  ga,GA4 (read only): accounts, use, report, realtime, dims
  gtm,Tag Manager: use, accounts, containers, workspaces, tags, triggers, variables, status, diffed writes, version create
  setup,Install SessionStart hooks for Claude Code, Codex and OpenCode
  update,Self-update to the latest release
  <cmd> <sub> --help,Per-subcommand usage, e.g. \`ga report --help\`

Flags:
  --help                 This index; \`google-analytics-axi <command> [sub] --help\` for details
  -v, --version          Print the version

Examples:
  google-analytics-axi ga report --property 123456789 --metrics sessions,totalUsers --dims sessionDefaultChannelGroup --range 28d
  google-analytics-axi gtm use "https://tagmanager.google.com/#/container/accounts/<a>/containers/<c>/workspaces/<w>"
  google-analytics-axi gtm tag update "GA4 - purchase" --param eventName=purchase --dry-run

Notes:
  Auth is Google Application Default Credentials (gcloud user login); no
  separate OAuth setup. \`ga use\` and \`gtm use\` cache defaults for
  --property and --account/--container/--workspace. GTM writes print a
  before/after diff and accept --dry-run. There is deliberately no GTM
  publish command: \`gtm version create\` stops short, and a human publishes
  in the GTM UI.

Exit codes:
  0 success (including no-ops)  1 error  2 usage error

Env:
  GOOGLE_APPLICATION_CREDENTIALS  Credentials file (default: ~/.config/gcloud/application_default_credentials.json)
  GOOGLE_CLOUD_QUOTA_PROJECT      Override the file's quota_project_id (sent as x-goog-user-project)
  XDG_CACHE_HOME                  Where cached defaults live (default: ~/.cache/google-analytics-axi)`;
