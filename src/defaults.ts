import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { usageError } from "./usage.js";

export interface GtmContext {
  account: string;
  container: string;
  workspace?: string;
}

export interface Defaults {
  gaProperty?: string;
  gtm?: GtmContext;
  updatedAt?: string;
}

export function defaultsPath(): string {
  const base = process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache");
  return join(base, "google-analytics-axi", "defaults.json");
}

export function readDefaults(): Defaults {
  try {
    return JSON.parse(readFileSync(defaultsPath(), "utf8")) as Defaults;
  } catch {
    return {}; // no defaults yet, or an unreadable file - both mean "none"
  }
}

export function writeDefaults(patch: Partial<Defaults>): Defaults {
  const next = { ...readDefaults(), ...patch, updatedAt: new Date().toISOString() };
  const path = defaultsPath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  return next;
}

/**
 * Accepts anything that identifies a GTM container: a tagmanager.google.com
 * URL (the `#/container/accounts/.../containers/.../workspaces/...` fragment),
 * or an API path `accounts/1/containers/2[/workspaces/3]`.
 */
export function parseGtmUrl(input: string): GtmContext {
  const match = /accounts\/(\d+)\/containers\/(\d+)(?:\/workspaces\/(\d+))?/.exec(input);
  if (!match) {
    throw usageError(`Could not find accounts/<id>/containers/<id> in "${input}"`, [
      "google-analytics-axi gtm use https://tagmanager.google.com/#/container/accounts/<account>/containers/<container>/workspaces/<workspace>",
    ]);
  }
  return { account: match[1]!, container: match[2]!, ...(match[3] ? { workspace: match[3] } : {}) };
}

/**
 * Accepts `123`, `properties/123`, or an analytics.google.com URL whose
 * fragment carries `p123` (`#/p123/reports/...` or the older `a1w2p123/`).
 */
export function parseGaProperty(input: string): string {
  const bare = /^(?:properties\/)?(\d+)$/.exec(input.trim());
  if (bare) return bare[1]!;
  const inUrl = /p(\d+)(?:\/|$)/.exec(input);
  if (inUrl && input.includes("analytics.google.com")) return inUrl[1]!;
  throw usageError(`"${input}" is not a GA4 property ID`, ["google-analytics-axi ga accounts  # lists every property ID"]);
}
