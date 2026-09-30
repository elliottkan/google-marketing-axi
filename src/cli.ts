import { existsSync } from "node:fs";
import { installSessionStartHooks, runAxiCli } from "axi-sdk-js";
import { credentialsPath, loadCredentials } from "./auth.js";
import { gaCommand } from "./commands/ga.js";
import { gtmCommand } from "./commands/gtm.js";
import { WHOAMI_HELP, whoamiCommand } from "./commands/whoami.js";
import { readDefaults } from "./defaults.js";
import { TOP_LEVEL_HELP } from "./help.js";
import { usageError } from "./usage.js";
import { VERSION } from "./version.js";

const DESCRIPTION = "Run GA4 reports and inspect or edit Google Tag Manager containers for agents";

const SETUP_HELP = `google-marketing-axi setup hooks

Install a SessionStart hook for Claude Code, Codex and OpenCode so every agent
session starts with the cached GA property and GTM container in context.

Examples:
  google-marketing-axi setup hooks`;

const AUTH_HELP = WHOAMI_HELP.replace("google-marketing-axi whoami\n", "google-marketing-axi auth status\n");

/** Offline on purpose: the home view runs on every session start, so it reads local state only. */
function homeOutput(): Record<string, unknown> {
  const defaults = readDefaults();
  let credentials: string;
  try {
    const creds = loadCredentials();
    credentials = `${creds.type}, quota project ${creds.quotaProject ?? "none"}`;
  } catch {
    credentials = existsSync(credentialsPath()) ? "unreadable" : "none - run `google-marketing-axi whoami` for the login command";
  }
  const gtm = defaults.gtm;
  return {
    credentials,
    gaProperty: defaults.gaProperty ?? "none - run `google-marketing-axi ga use <property>`",
    gtm: gtm ? `accounts/${gtm.account}/containers/${gtm.container}${gtm.workspace ? `/workspaces/${gtm.workspace}` : ""}` : "none - run `google-marketing-axi gtm use <gtm-url>`",
    help: [
      defaults.gaProperty ? "google-marketing-axi ga report --metrics sessions --dims sessionDefaultChannelGroup --range 28d" : "google-marketing-axi ga accounts",
      gtm?.workspace ? "google-marketing-axi gtm tags" : "google-marketing-axi gtm accounts",
      "google-marketing-axi whoami",
      "google-marketing-axi --help",
    ],
  };
}

const COMMAND_HELP: Record<string, string> = {
  whoami: WHOAMI_HELP,
  auth: AUTH_HELP,
  setup: SETUP_HELP,
};

export async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
  await runAxiCli({
    description: DESCRIPTION,
    version: VERSION,
    argv,
    topLevelHelp: TOP_LEVEL_HELP,
    // ga and gtm answer --help themselves so each subcommand gets its own page.
    getCommandHelp: (command) => COMMAND_HELP[command],
    home: () => homeOutput(),
    commands: {
      whoami: (args) => whoamiCommand(args),
      auth: (args) => {
        if (args[0] !== "status") throw usageError(`Unknown auth target "${args[0] ?? ""}"`, ["Run `google-marketing-axi auth status`"]);
        return whoamiCommand(args.slice(1));
      },
      ga: (args) => gaCommand(args),
      gtm: (args) => gtmCommand(args),
      setup: async (args) => {
        if (args.length !== 1 || args[0] !== "hooks") {
          throw usageError(`Unknown setup target "${args[0] ?? ""}"`, ["Run `google-marketing-axi setup hooks`"]);
        }
        await installSessionStartHooks({ marker: "google-marketing-axi", binaryNames: ["google-marketing-axi"] });
        return {
          setup: "hooks installed or already up to date",
          help: ["Restart your agent session for the hook to take effect"],
        };
      },
    },
  });
}
