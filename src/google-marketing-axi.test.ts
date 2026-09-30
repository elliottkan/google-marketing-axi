import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AxiError } from "axi-sdk-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { accessToken, RELOGIN_COMMAND, resetTokenCache } from "./auth.js";
import { main } from "./cli.js";
import { parseGaProperty, parseGtmUrl } from "./defaults.js";
import { list, parseFlags } from "./flags.js";
import { request } from "./google.js";
import { diff, merge, paramFlags, readable, resolve } from "./gtm.js";
import { parseFilters, parseOrder, parseRange, shapeReport } from "./report.js";

type Handler = (url: string, init: RequestInit) => { status?: number; body: unknown };

let calls: Array<{ url: string; method: string; body?: string; headers: Record<string, string> }>;

function mockFetch(handler: Handler): void {
  vi.stubGlobal("fetch", async (url: string, init: RequestInit = {}) => {
    calls.push({ url, method: init.method ?? "GET", body: init.body as string | undefined, headers: (init.headers ?? {}) as Record<string, string> });
    if (url === "https://oauth2.googleapis.com/token") return Response.json({ access_token: "ya29.test", expires_in: 3600 });
    const { status = 200, body } = handler(url, init);
    return new Response(JSON.stringify(body), { status });
  });
}

async function run(argv: string[]): Promise<{ out: string; code: number }> {
  let out = "";
  const spy = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
    out += String(chunk);
    return true;
  });
  process.exitCode = 0;
  try {
    await main(argv);
  } finally {
    spy.mockRestore();
  }
  const code = Number(process.exitCode ?? 0);
  process.exitCode = 0;
  return { out, code };
}

beforeEach(() => {
  calls = [];
  resetTokenCache();
  const dir = mkdtempSync(join(tmpdir(), "ga-axi-"));
  const creds = join(dir, "adc.json");
  writeFileSync(creds, JSON.stringify({ type: "authorized_user", client_id: "cid", client_secret: "secret", refresh_token: "rt", quota_project_id: "quota-1" }));
  vi.stubEnv("GOOGLE_APPLICATION_CREDENTIALS", creds);
  vi.stubEnv("GOOGLE_CLOUD_QUOTA_PROJECT", undefined as unknown as string);
  vi.stubEnv("XDG_CACHE_HOME", dir);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("flags", () => {
  it("rejects unknown flags and splits comma lists", () => {
    expect(() => parseFlags(["--nope"], { value: ["metrics"] })).toThrow(/Unknown flag/);
    expect(list(parseFlags(["--metrics", "a,b", "--metrics", "c"], { value: ["metrics"] }), "metrics")).toEqual(["a", "b", "c"]);
  });
});

describe("auth", () => {
  it("refreshes once, then sends the bearer token and quota project on every call", async () => {
    mockFetch(() => ({ body: { ok: true } }));
    await request("https://example.test/a");
    await request("https://example.test/b");
    const refreshes = calls.filter((c) => c.url.includes("oauth2"));
    expect(refreshes).toHaveLength(1);
    expect(refreshes[0]!.body).toContain("grant_type=refresh_token");
    expect(refreshes[0]!.body).toContain("refresh_token=rt");
    const api = calls.filter((c) => c.url.startsWith("https://example.test"));
    expect(api.map((c) => c.headers.authorization)).toEqual(["Bearer ya29.test", "Bearer ya29.test"]);
    expect(api[0]!.headers["x-goog-user-project"]).toBe("quota-1");
  });

  it("maps invalid_grant to the re-login command", async () => {
    vi.stubGlobal("fetch", async () => Response.json({ error: "invalid_grant", error_description: "Token has been expired or revoked." }, { status: 400 }));
    const error = (await accessToken().catch((e) => e)) as AxiError;
    expect(error.code).toBe("auth_failed");
    expect(error.suggestions[0]).toContain(RELOGIN_COMMAND);
    expect(error.suggestions[1]).toContain('"quota_project_id": "quota-1"');
  });

  it("maps 401 and insufficient-scope 403 to the re-login command", async () => {
    mockFetch(() => ({ status: 401, body: { error: { message: "Request had invalid authentication credentials." } } }));
    expect(((await request("https://example.test").catch((e) => e)) as AxiError).code).toBe("auth_failed");

    mockFetch(() => ({
      status: 403,
      body: { error: { message: "Request had insufficient authentication scopes.", details: [{ reason: "ACCESS_TOKEN_SCOPE_INSUFFICIENT" }] } },
    }));
    const scope = (await request("https://example.test").catch((e) => e)) as AxiError;
    expect(scope.code).toBe("insufficient_scope");
    expect(scope.suggestions.join("\n")).toContain("tagmanager.edit.containers");
  });

  it("points a disabled API at its activation URL", async () => {
    mockFetch(() => ({
      status: 403,
      body: { error: { message: "API has not been used in project quota-1", details: [{ reason: "SERVICE_DISABLED", metadata: { activationUrl: "https://console.example/enable" } }] } },
    }));
    const error = (await request("https://example.test").catch((e) => e)) as AxiError;
    expect(error.code).toBe("api_disabled");
    expect(error.suggestions[0]).toContain("https://console.example/enable");
  });
});

describe("defaults parsing", () => {
  it("parses GTM URLs and API paths", () => {
    expect(parseGtmUrl("https://tagmanager.google.com/#/container/accounts/111/containers/222/workspaces/33")).toEqual({ account: "111", container: "222", workspace: "33" });
    expect(parseGtmUrl("accounts/1/containers/2")).toEqual({ account: "1", container: "2" });
    expect(() => parseGtmUrl("https://tagmanager.google.com/#/home")).toThrow(/Could not find/);
  });

  it("parses GA property IDs and URLs", () => {
    expect(parseGaProperty("123")).toBe("123");
    expect(parseGaProperty("properties/123")).toBe("123");
    expect(parseGaProperty("https://analytics.google.com/analytics/web/#/p456/reports/intelligenthome")).toBe("456");
    expect(parseGaProperty("https://analytics.google.com/analytics/web/#/a1w2p789/")).toBe("789");
    expect(() => parseGaProperty("G-ABC123")).toThrow(/not a GA4 property/);
  });
});

describe("report shaping", () => {
  it("parses ranges", () => {
    expect(parseRange("7d")).toEqual({ startDate: "7daysAgo", endDate: "yesterday" });
    expect(parseRange("today")).toEqual({ startDate: "today", endDate: "today" });
    expect(parseRange("2026-09-01:2026-09-15")).toEqual({ startDate: "2026-09-01", endDate: "2026-09-15" });
    expect(() => parseRange("2026-09-15:2026-09-01")).toThrow(/after end/);
    expect(() => parseRange("week")).toThrow(/Unknown --range/);
  });

  it("splits filters into dimension and metric expressions", () => {
    const { dimensionFilter, metricFilter } = parseFilters(["eventName==purchase", "pagePath!@/admin", "sessions>=10"], ["sessions"]);
    expect(dimensionFilter).toEqual({
      andGroup: {
        expressions: [
          { filter: { fieldName: "eventName", stringFilter: { matchType: "EXACT", value: "purchase" } } },
          { notExpression: { filter: { fieldName: "pagePath", stringFilter: { matchType: "CONTAINS", value: "/admin" } } } },
        ],
      },
    });
    expect(metricFilter).toEqual({ filter: { fieldName: "sessions", numericFilter: { operation: "GREATER_THAN_OR_EQUAL", value: { doubleValue: 10 } } } });
    expect(parseFilters(["customEvent:type=~^a"], []).dimensionFilter).toEqual({
      filter: { fieldName: "customEvent:type", stringFilter: { matchType: "FULL_REGEXP", value: "^a" } },
    });
    expect(() => parseFilters(["pagePath>3"], [])).toThrow(/only works on metrics/);
  });

  it("orders by first metric desc, or chronologically for time dimensions", () => {
    expect(parseOrder([], ["sessions"], ["country"])).toEqual([{ metric: { metricName: "sessions" }, desc: true }]);
    expect(parseOrder([], ["sessions"], ["date"])).toEqual([{ dimension: { dimensionName: "date" }, desc: false }]);
    expect(parseOrder(["-country"], ["sessions"], ["country"])).toEqual([{ dimension: { dimensionName: "country" }, desc: true }]);
    expect(() => parseOrder(["nope"], ["sessions"], [])).toThrow(/not in --metrics/);
  });

  it("turns GA's header/row arrays into keyed rows with numbers", () => {
    const shaped = shapeReport({
      dimensionHeaders: [{ name: "date" }, { name: "country" }],
      metricHeaders: [{ name: "sessions" }, { name: "engagementRate" }],
      rows: [{ dimensionValues: [{ value: "20260901" }, { value: "Australia" }], metricValues: [{ value: "12" }, { value: "0.123456789" }] }],
      totals: [{ metricValues: [{ value: "12" }, { value: "0.123456789" }] }],
      rowCount: 40,
      metadata: { subjectToThresholding: true },
    });
    expect(shaped.rows).toEqual([{ date: "2026-09-01", country: "Australia", sessions: 12, engagementRate: 0.1235 }]);
    expect(shaped.totals).toEqual({ sessions: 12, engagementRate: 0.1235 });
    expect(shaped.rowCount).toBe(40);
    expect(shaped.notes[0]).toMatch(/thresholding/);
  });
});

const TAG = {
  path: "accounts/1/containers/2/workspaces/3/tags/10",
  accountId: "1",
  containerId: "2",
  workspaceId: "3",
  tagId: "10",
  name: "GA4 - purchase",
  type: "gaawe",
  fingerprint: "fp-1",
  firingTriggerId: ["20"],
  parameter: [
    { type: "template", key: "eventName", value: "purchase" },
    { type: "boolean", key: "sendEcommerceData", value: "true" },
  ],
};
const TRIGGERS = [{ triggerId: "20", name: "Event - purchase", type: "customEvent", path: "accounts/1/containers/2/workspaces/3/triggers/20" }];
const CTX = ["--account", "1", "--container", "2", "--workspace", "3"];

describe("gtm shaping", () => {
  it("flattens parameters and names triggers", () => {
    const view = readable(TAG, new Map([["20", "Event - purchase"]]));
    expect(view.parameters).toEqual({ eventName: "purchase", sendEcommerceData: "true" });
    expect(view.firing).toEqual(["Event - purchase"]);
    expect(view).not.toHaveProperty("fingerprint");
  });

  it("merges parameters by key and diffs only what changed", () => {
    const patch = { parameter: paramFlags(["sendEcommerceData=false", "newKey=x"], TAG.parameter) };
    expect(patch.parameter[0]!.type).toBe("boolean");
    const next = merge(TAG, patch);
    expect((next.parameter as unknown[]).length).toBe(3);
    expect(diff(TAG, next)).toEqual([
      { field: "parameters.newKey", before: "(unset)", after: "x" },
      { field: "parameters.sendEcommerceData", before: "true", after: "false" },
    ]);
    expect(diff(TAG, merge(TAG, { name: TAG.name }))).toEqual([]);
  });

  it("resolves by ID, then exact name, then case-insensitive name", () => {
    const items = [TAG, { ...TAG, tagId: "11", name: "Other" }];
    expect(resolve("tag", items, "11")?.name).toBe("Other");
    expect(resolve("tag", items, "ga4 - PURCHASE")?.tagId).toBe("10");
    expect(resolve("tag", items, "missing")).toBeUndefined();
  });
});

function gtmApi(url: string, init: RequestInit): { status?: number; body: unknown } {
  if (url.endsWith("/workspaces/3/tags") && (init.method ?? "GET") === "GET") return { body: { tag: [TAG] } };
  if (url.endsWith("/workspaces/3/triggers")) return { body: { trigger: TRIGGERS } };
  if (url.endsWith("/workspaces/3/status")) return { body: { workspaceChange: [{ changeStatus: "updated", tag: TAG }] } };
  if (init.method === "PUT") return { body: { ...TAG, ...JSON.parse(String(init.body)), fingerprint: "fp-2" } };
  if (init.method === "POST") return { body: { ...JSON.parse(String(init.body)), tagId: "99" } };
  return { status: 404, body: { error: { message: "unexpected " + url } } };
}

describe("gtm writes", () => {
  it("--dry-run prints the diff and sends nothing", async () => {
    mockFetch(gtmApi);
    const { out, code } = await run(["gtm", "tag", "update", "GA4 - purchase", "--param", "eventName=purchase_v2", "--dry-run", ...CTX]);
    expect(code).toBe(0);
    expect(out).toContain("dry-run - nothing sent");
    expect(out).toContain("parameters.eventName,purchase,purchase_v2");
    expect(calls.filter((c) => c.method !== "GET" && !c.url.includes("oauth2"))).toEqual([]);
  });

  it("update sends the merged resource with its fingerprint", async () => {
    mockFetch(gtmApi);
    const { out, code } = await run(["gtm", "tag", "update", "10", "--paused", "--firing", "All Pages", ...CTX]);
    expect(code).toBe(0);
    const put = calls.find((c) => c.method === "PUT")!;
    expect(put.url).toBe("https://tagmanager.googleapis.com/tagmanager/v2/accounts/1/containers/2/workspaces/3/tags/10?fingerprint=fp-1");
    const body = JSON.parse(put.body!);
    expect(body.paused).toBe(true);
    expect(body.firingTriggerId).toEqual(["2147479553"]);
    expect(body.parameter).toHaveLength(2);
    expect(out).toContain('"firing[0]",Event - purchase,All Pages');
  });

  it("update with no effective change is a no-op", async () => {
    mockFetch(gtmApi);
    const { out, code } = await run(["gtm", "tag", "update", "10", "--param", "eventName=purchase", ...CTX]);
    expect(code).toBe(0);
    expect(out).toContain("already matches (no-op)");
    expect(calls.some((c) => c.method === "PUT")).toBe(false);
  });

  it("create posts the body, and deleting something absent is a no-op", async () => {
    mockFetch(gtmApi);
    const created = await run(["gtm", "tag", "create", "--name", "New tag", "--type", "html", "--param", "html=<p>", "--firing", "Event - purchase", ...CTX]);
    expect(created.code).toBe(0);
    const post = JSON.parse(calls.find((c) => c.method === "POST" && c.url.includes("tagmanager"))!.body!);
    expect(post).toMatchObject({ name: "New tag", type: "html", firingTriggerId: ["20"], parameter: [{ type: "template", key: "html", value: "<p>" }] });

    const deleted = await run(["gtm", "tag", "delete", "Ghost", ...CTX]);
    expect(deleted.code).toBe(0);
    expect(deleted.out).toContain("already deleted (no-op)");
    expect(calls.some((c) => c.method === "DELETE")).toBe(false);
  });

  it("version create --dry-run lists the pending changes without creating", async () => {
    mockFetch(gtmApi);
    const { out, code } = await run(["gtm", "version", "create", "--name", "v1", "--dry-run", ...CTX]);
    expect(code).toBe(0);
    expect(out).toContain("updated,tag,\"10\",GA4 - purchase");
    expect(calls.some((c) => c.url.includes("create_version"))).toBe(false);
  });

  it("rejects an unknown trigger name with exit 2", async () => {
    mockFetch(gtmApi);
    const { out, code } = await run(["gtm", "tag", "update", "10", "--firing", "Nope", "--dry-run", ...CTX]);
    expect(code).toBe(2);
    expect(out).toContain('No trigger \\"Nope\\"');
  });

  it("rejects usage mistakes with exit 2 before any request", async () => {
    mockFetch(gtmApi);
    for (const argv of [
      ["gtm", "tag", "create", "--name", "No type"],
      ["gtm", "tag", "update", "10"],
      ["gtm", "tag", "update"],
      ["gtm", "tag", "update", "10", "--paused", "--unpause"],
    ]) {
      expect((await run([...argv, ...CTX])).code).toBe(2);
    }
    expect(calls).toEqual([]);
  });
});
