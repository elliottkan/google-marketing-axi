import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { AxiError } from "axi-sdk-js";

export const SCOPES = {
  analytics: "https://www.googleapis.com/auth/analytics.readonly",
  gtmRead: "https://www.googleapis.com/auth/tagmanager.readonly",
  gtmEdit: "https://www.googleapis.com/auth/tagmanager.edit.containers",
  gtmVersion: "https://www.googleapis.com/auth/tagmanager.edit.containerversions",
};

export const RELOGIN_COMMAND =
  "gcloud auth application-default login --client-id-file=$HOME/.config/harvey-sheets/oauth-client.json --scopes=https://www.googleapis.com/auth/analytics.readonly,https://www.googleapis.com/auth/tagmanager.edit.containers,https://www.googleapis.com/auth/tagmanager.edit.containerversions,https://www.googleapis.com/auth/cloud-platform";

interface AuthorizedUser {
  type: string;
  client_id?: string;
  client_secret?: string;
  refresh_token?: string;
  quota_project_id?: string;
}

export interface Credentials {
  path: string;
  type: string;
  quotaProject?: string;
}

export function credentialsPath(): string {
  return (
    process.env.GOOGLE_APPLICATION_CREDENTIALS ??
    join(process.env.CLOUDSDK_CONFIG ?? join(homedir(), ".config", "gcloud"), "application_default_credentials.json")
  );
}

/** Every auth failure points at the same fix: re-run the login, then restore the quota project. */
export function reloginSuggestions(quotaProject = "<quota-project>"): string[] {
  return [
    `Re-login: ${RELOGIN_COMMAND}`,
    `Then re-add "quota_project_id": "${quotaProject}" to ${credentialsPath()} by hand (\`gcloud auth application-default set-quota-project\` fails because the Cloud Resource Manager API is disabled)`,
    "Check the result with `google-marketing-axi whoami`",
  ];
}

function readCredentialsFile(): AuthorizedUser & { path: string } {
  const path = credentialsPath();
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    throw new AxiError(`No Google credentials at ${path}`, "missing_credentials", reloginSuggestions());
  }
  try {
    return { ...(JSON.parse(raw) as AuthorizedUser), path };
  } catch {
    throw new AxiError(`Google credentials at ${path} are not valid JSON`, "missing_credentials", reloginSuggestions());
  }
}

export function loadCredentials(): Credentials {
  const file = readCredentialsFile();
  return { path: file.path, type: file.type, quotaProject: process.env.GOOGLE_CLOUD_QUOTA_PROJECT ?? file.quota_project_id };
}

let cached: { token: string; expiresAt: number } | undefined;

/** Test hook - drops the in-memory token so the next call refreshes. */
export function resetTokenCache(): void {
  cached = undefined;
}

/**
 * Exchanges the ADC refresh token for an access token. The token lives in
 * memory only, so each CLI invocation pays one refresh round trip.
 * ponytail: no on-disk token cache; add one if the refresh latency starts to matter.
 */
export async function accessToken(): Promise<string> {
  if (cached && cached.expiresAt > Date.now() + 60_000) return cached.token;

  const file = readCredentialsFile();
  const quota = process.env.GOOGLE_CLOUD_QUOTA_PROJECT ?? file.quota_project_id;
  if (file.type !== "authorized_user") {
    throw new AxiError(
      `Credentials type "${file.type}" is not supported - only gcloud user credentials (authorized_user) are`,
      "unsupported_credentials",
      reloginSuggestions(quota),
    );
  }
  if (!file.refresh_token || !file.client_id || !file.client_secret) {
    throw new AxiError(`Credentials at ${file.path} are missing refresh_token, client_id or client_secret`, "missing_credentials", reloginSuggestions(quota));
  }

  let response: Response;
  try {
    response = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: file.refresh_token,
        client_id: file.client_id,
        client_secret: file.client_secret,
      }).toString(),
    });
  } catch (error) {
    throw new AxiError(`Could not reach Google's token endpoint: ${(error as Error).message}`, "api_unavailable", ["Check your network connection"]);
  }

  const body = (await response.json().catch(() => ({}))) as { access_token?: string; expires_in?: number; error?: string; error_description?: string };
  if (!response.ok || !body.access_token) {
    const reason = body.error_description ?? body.error ?? `HTTP ${response.status}`;
    throw new AxiError(`Google refused to refresh the access token: ${reason}`, "auth_failed", reloginSuggestions(quota));
  }
  cached = { token: body.access_token, expiresAt: Date.now() + (body.expires_in ?? 3600) * 1000 };
  return body.access_token;
}
