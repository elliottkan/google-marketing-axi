import { AxiError } from "axi-sdk-js";
import { accessToken, loadCredentials, reloginSuggestions, SCOPES } from "../auth.js";
import { parseFlags } from "../flags.js";
import { expectNoArgs } from "../usage.js";

export const WHOAMI_HELP = `google-analytics-axi whoami

Show which credentials are in use, their quota project, the OAuth scopes the
current access token carries, and what that lets each command do. Never
prints token or secret values. \`auth status\` is an alias.

Examples:
  google-analytics-axi whoami
  google-analytics-axi auth status`;

export async function whoamiCommand(args: string[]): Promise<Record<string, unknown>> {
  expectNoArgs("whoami", parseFlags(args, {}).positionals);
  const creds = loadCredentials();
  const token = await accessToken();
  // POST keeps the token out of the URL.
  const response = await fetch("https://oauth2.googleapis.com/tokeninfo", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ access_token: token }).toString(),
  }).catch((error: Error) => {
    throw new AxiError(`Could not reach Google's tokeninfo endpoint: ${error.message}`, "api_unavailable", ["Check your network connection"]);
  });
  const info = (await response.json().catch(() => ({}))) as { scope?: string; expires_in?: string; email?: string; error_description?: string };
  if (!response.ok) throw new AxiError(`tokeninfo rejected the token: ${info.error_description ?? response.status}`, "auth_failed", reloginSuggestions(creds.quotaProject));

  const scopes = (info.scope ?? "").split(" ").filter(Boolean);
  const has = (...wanted: string[]) => wanted.some((s) => scopes.includes(s));
  const gtmEdit = has(SCOPES.gtmEdit);
  const gtmVersion = has(SCOPES.gtmVersion);
  const out: Record<string, unknown> = {
    credentials: creds.path,
    type: creds.type,
    ...(info.email ? { email: info.email } : {}),
    quotaProject: creds.quotaProject ?? "none - add quota_project_id to the credentials file",
    expiresInSeconds: Number(info.expires_in ?? 0),
    scopes: scopes.map((s) => s.replace("https://www.googleapis.com/auth/", "")),
    can: {
      gaRead: has(SCOPES.analytics, "https://www.googleapis.com/auth/analytics", "https://www.googleapis.com/auth/analytics.edit"),
      gtmRead: has(SCOPES.gtmRead, SCOPES.gtmEdit),
      gtmWrite: gtmEdit,
      gtmVersion,
    },
  };
  if (!gtmEdit || !gtmVersion || !creds.quotaProject) out.help = reloginSuggestions(creds.quotaProject);
  return out;
}
