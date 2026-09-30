import { AxiError } from "axi-sdk-js";
import { accessToken, loadCredentials, reloginSuggestions } from "./auth.js";

export const ADMIN_API = "https://analyticsadmin.googleapis.com/v1beta";
export const DATA_API = "https://analyticsdata.googleapis.com/v1beta";
export const GTM_API = "https://tagmanager.googleapis.com/tagmanager/v2";

interface GoogleErrorBody {
  error?: {
    code?: number;
    message?: string;
    status?: string;
    details?: Array<{ reason?: string; metadata?: Record<string, string> }>;
  };
}

/** Maps a Google API error response to an AxiError with a next step an agent can run. */
export function googleError(status: number, body: GoogleErrorBody | undefined, quotaProject?: string): AxiError {
  const err = body?.error;
  const message = err?.message ?? `HTTP ${status}`;
  const reasons = (err?.details ?? []).map((d) => d.reason ?? "");

  if (status === 401) {
    return new AxiError(`Google rejected the credentials: ${message}`, "auth_failed", reloginSuggestions(quotaProject));
  }
  if (status === 403 && (reasons.includes("ACCESS_TOKEN_SCOPE_INSUFFICIENT") || /insufficient (authentication )?scopes/i.test(message))) {
    return new AxiError("The signed-in credentials lack the OAuth scope this command needs", "insufficient_scope", reloginSuggestions(quotaProject));
  }
  if (status === 403 && (reasons.includes("SERVICE_DISABLED") || /has not been used in project|is disabled/i.test(message))) {
    const activation = err?.details?.find((d) => d.metadata?.activationUrl)?.metadata?.activationUrl;
    return new AxiError(`The API is disabled for quota project ${quotaProject ?? "(none)"}`, "api_disabled", [
      activation ? `Enable it: ${activation}` : "Enable the API in the Google Cloud console for the quota project",
    ]);
  }
  if (status === 403 && reasons.includes("USER_PROJECT_DENIED")) {
    return new AxiError(`Quota project ${quotaProject ?? "(none)"} rejected: ${message}`, "quota_project_denied", reloginSuggestions(quotaProject));
  }
  if (status === 403) {
    return new AxiError(`Permission denied: ${message}`, "permission_denied", ["Check the signed-in Google account has access to this property/container"]);
  }
  if (status === 404) return new AxiError(`Not found: ${message}`, "not_found");
  if (status === 429) return new AxiError(`Rate limited: ${message}`, "rate_limited", ["Wait a minute and retry"]);
  if (status === 400) {
    const field = /Field (\S+) is not a valid (metric|dimension)/.exec(message);
    return new AxiError(`Google rejected the request: ${message.trim()}`, "bad_request", field ? [`google-analytics-axi ga dims ${field[1]}  # search valid ${field[2]}s`] : []);
  }
  return new AxiError(message, "api_error");
}

export async function request(url: string, init: { method?: string; body?: unknown } = {}): Promise<unknown> {
  const token = await accessToken();
  const { quotaProject } = loadCredentials();
  let response: Response;
  try {
    response = await fetch(url, {
      method: init.method ?? "GET",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        ...(quotaProject ? { "x-goog-user-project": quotaProject } : {}),
      },
      ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
    });
  } catch (error) {
    throw new AxiError(`Could not reach Google: ${(error as Error).message}`, "api_unavailable", ["Check your network connection"]);
  }

  const text = await response.text();
  let body: unknown;
  try {
    body = text ? JSON.parse(text) : undefined;
  } catch {
    body = undefined;
  }
  if (!response.ok) throw googleError(response.status, body as GoogleErrorBody | undefined, quotaProject);
  return body;
}

/** Follows `nextPageToken` until exhausted and concatenates the `key` array of every page. */
export async function listAll<T>(url: string, key: string): Promise<T[]> {
  const items: T[] = [];
  let pageToken: string | undefined;
  do {
    const sep = url.includes("?") ? "&" : "?";
    const page = (await request(pageToken ? `${url}${sep}pageToken=${encodeURIComponent(pageToken)}` : url)) as Record<string, unknown> | undefined;
    items.push(...(((page?.[key] as T[] | undefined) ?? [])));
    pageToken = page?.nextPageToken as string | undefined;
  } while (pageToken);
  return items;
}
