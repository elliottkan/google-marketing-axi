import { list, one, parseFlags, positiveInt } from "../flags.js";
import { ADMIN_API, DATA_API, listAll, request } from "../google.js";
import { parseGaProperty, readDefaults, writeDefaults } from "../defaults.js";
import { FILTER_SYNTAX, parseFilters, parseOrder, parseRange, shapeReport } from "../report.js";
import { expectNoArgs, usageError } from "../usage.js";

const BIN = "google-analytics-axi";

export const GA_HELP: Record<string, string> = {
  "": `${BIN} ga <accounts|use|report|realtime|dims> [flags]

GA4 reporting (read only) via the Analytics Admin and Data APIs.

subcommands[5]{command,what}:
  accounts,Every account and GA4 property you can read
  use <property>,Cache a default property for --property
  report,Run a report (runReport) and print compact rows
  realtime,Run a realtime report (last 30 minutes)
  dims,Search the dimensions and metrics a property offers, custom ones included

Examples:
  ${BIN} ga accounts
  ${BIN} ga use 123456789
  ${BIN} ga report --metrics sessions,totalUsers --dims sessionDefaultChannelGroup --range 28d`,
  accounts: `${BIN} ga accounts

List every GA4 account and property the signed-in user can read.

Examples:
  ${BIN} ga accounts`,
  use: `${BIN} ga use <property>

Cache a default GA4 property so --property can be omitted. Accepts a bare
ID, properties/<id>, or an analytics.google.com URL (#/p<id>/...).
With no argument, prints the current default.

Examples:
  ${BIN} ga use 123456789
  ${BIN} ga use "https://analytics.google.com/analytics/web/#/p123456789/reports/intelligenthome"`,
  report: `${BIN} ga report --metrics <a,b> [flags]

Run a GA4 report and print one row per dimension combination, plus totals.

Flags:
  --property <id>      GA4 property (default: \`ga use\` cache)
  --metrics <a,b>      Required. Metric API names (see \`ga dims\`)
  --dims <x,y>         Dimension API names (alias --dimensions)
  --range <range>      7d | 28d | 90d | today | yesterday | YYYY-MM-DD:YYYY-MM-DD (default: 28d)
                       Nd = the last N complete days, ending yesterday
  --filter <expr>      Repeatable, ANDed. ${FILTER_SYNTAX}
  --order <fields>     Comma list, "-" prefix = descending (default: first time dim ascending, else -firstMetric)
  --limit <n>          Max rows (default: 100)

Examples:
  ${BIN} ga report --metrics sessions,totalUsers --dims sessionDefaultChannelGroup --range 28d
  ${BIN} ga report --metrics eventCount --dims eventName --filter "eventName=~^(purchase|add_to_cart)$" --range 7d
  ${BIN} ga report --metrics sessions --dims date --range 2026-09-01:2026-09-15`,
  realtime: `${BIN} ga realtime [flags]

Run a realtime report over the last N minutes (standard properties: max 30).

Flags:
  --property <id>      GA4 property (default: \`ga use\` cache)
  --metrics <a,b>      Metric API names (default: activeUsers)
  --dims <x,y>         Realtime dimensions, e.g. country, unifiedScreenName, eventName, deviceCategory
  --minutes <n>        Look-back window in minutes (default: 30)
  --filter <expr>      Repeatable, ANDed. ${FILTER_SYNTAX}
  --order <fields>     Comma list, "-" prefix = descending
  --limit <n>          Max rows (default: 100)

Examples:
  ${BIN} ga realtime
  ${BIN} ga realtime --dims eventName --metrics eventCount --minutes 5`,
  dims: `${BIN} ga dims [query] [flags]

Search the dimensions and metrics a property accepts in \`ga report\`.
With no query, lists only the property's custom definitions plus totals.

Flags:
  --property <id>      GA4 property (default: \`ga use\` cache)
  --all                List every dimension and metric (long)

Examples:
  ${BIN} ga dims
  ${BIN} ga dims session
  ${BIN} ga dims --all`,
};

function property(flags: ReturnType<typeof parseFlags>): string {
  const explicit = one(flags, "property");
  if (explicit) return parseGaProperty(explicit);
  const cached = readDefaults().gaProperty;
  if (cached) return cached;
  throw usageError("No GA4 property - pass --property <id> or cache one", [`${BIN} ga accounts  # find the ID`, `${BIN} ga use <property>`]);
}

interface AccountSummary {
  account: string;
  displayName: string;
  propertySummaries?: Array<{ property: string; displayName: string; propertyType?: string }>;
}

async function accountsCommand(args: string[]): Promise<Record<string, unknown>> {
  expectNoArgs("ga accounts", parseFlags(args, {}).positionals);
  const summaries = await listAll<AccountSummary>(`${ADMIN_API}/accountSummaries?pageSize=200`, "accountSummaries");
  const rows = summaries.flatMap((a) => {
    const account = a.account.replace("accounts/", "");
    const props = a.propertySummaries ?? [];
    if (props.length === 0) return [{ account, accountName: a.displayName, property: "", propertyName: "(no properties)" }];
    return props.map((p) => ({ account, accountName: a.displayName, property: p.property.replace("properties/", ""), propertyName: p.displayName }));
  });
  if (rows.length === 0) return { accounts: "0 GA4 accounts visible to the signed-in user" };
  const current = readDefaults().gaProperty;
  return {
    count: `${summaries.length} accounts, ${rows.filter((r) => r.property).length} properties`,
    properties: rows,
    ...(current ? { default: current } : {}),
    help: [`${BIN} ga use <property>`, `${BIN} ga report --property <property> --metrics sessions --dims sessionDefaultChannelGroup`],
  };
}

function useCommand(args: string[]): Record<string, unknown> {
  const flags = parseFlags(args, {});
  const [input, ...extra] = flags.positionals;
  if (extra.length) throw usageError("ga use takes one property", [`${BIN} ga use 123456789`]);
  if (!input) {
    const current = readDefaults().gaProperty;
    return current ? { gaProperty: current } : { gaProperty: "none cached", help: [`${BIN} ga use <property>`] };
  }
  const gaProperty = parseGaProperty(input);
  writeDefaults({ gaProperty });
  return { gaProperty, cached: "default for --property", help: [`${BIN} ga report --metrics sessions --dims date --range 7d`] };
}

const REPORT_FLAGS = { value: ["property", "metrics", "dims", "dimensions", "range", "filter", "order", "limit", "minutes"], alias: { dimensions: "dims" } };

async function runReport(args: string[], realtime: boolean): Promise<Record<string, unknown>> {
  const flags = parseFlags(args, {
    value: REPORT_FLAGS.value.filter((f) => (realtime ? f !== "range" : f !== "minutes")),
    alias: REPORT_FLAGS.alias,
  });
  const name = realtime ? "ga realtime" : "ga report";
  expectNoArgs(name, flags.positionals);
  const metrics = list(flags, "metrics");
  if (metrics.length === 0 && !realtime) throw usageError("ga report requires --metrics", [`${BIN} ga report --metrics sessions --dims date --range 7d`, `${BIN} ga dims  # find metric names`]);
  if (metrics.length === 0) metrics.push("activeUsers");
  const dims = list(flags, "dims");
  const limit = positiveInt(flags, "limit") ?? 100;
  const minutes = positiveInt(flags, "minutes") ?? 30;
  const rangeInput = one(flags, "range") ?? "28d";
  const range = realtime ? undefined : parseRange(rangeInput);
  const filters = parseFilters(flags.values.filter ?? [], metrics);
  const orderBys = parseOrder(list(flags, "order"), metrics, dims);
  const id = property(flags);

  const body = {
    ...(range ? { dateRanges: [range] } : { minuteRanges: [{ startMinutesAgo: minutes - 1, endMinutesAgo: 0 }] }),
    metrics: metrics.map((m) => ({ name: m })),
    dimensions: dims.map((d) => ({ name: d })),
    ...filters,
    orderBys,
    limit,
    metricAggregations: ["TOTAL"],
  };
  const response = await request(`${DATA_API}/properties/${id}:${realtime ? "runRealtimeReport" : "runReport"}`, { method: "POST", body });
  const shaped = shapeReport(response as Parameters<typeof shapeReport>[0]);

  const window = range ? `${range.startDate}..${range.endDate}` : `last ${minutes} minutes`;
  const out: Record<string, unknown> = { property: id, [realtime ? "window" : "range"]: window };
  if (shaped.rows.length === 0) {
    out.rows = `0 rows - no ${metrics.join(",")} data${dims.length ? ` by ${dims.join(",")}` : ""} in ${window}${filters.dimensionFilter || filters.metricFilter ? " matching the filters" : ""}`;
    return out;
  }
  out.count = shaped.rowCount > shaped.rows.length ? `${shaped.rows.length} of ${shaped.rowCount} rows` : shaped.rows.length;
  out.rows = shaped.rows;
  if (shaped.totals && dims.length > 0) out.totals = shaped.totals;
  if (shaped.notes.length) out.notes = shaped.notes;
  if (shaped.rowCount > shaped.rows.length) out.help = [`Rerun with --limit ${shaped.rowCount} for all rows`];
  return out;
}

interface Metadata {
  dimensions?: Array<{ apiName: string; uiName: string; category?: string; customDefinition?: boolean }>;
  metrics?: Array<{ apiName: string; uiName: string; category?: string; customDefinition?: boolean }>;
}

async function dimsCommand(args: string[]): Promise<Record<string, unknown>> {
  const flags = parseFlags(args, { value: ["property"], boolean: ["all"] });
  const query = flags.positionals.join(" ").trim().toLowerCase();
  const id = property(flags);
  const meta = (await request(`${DATA_API}/properties/${id}/metadata`)) as Metadata;
  const all = flags.booleans.has("all");
  const pick = (items: Metadata["dimensions"] = []) =>
    items
      .filter((i) => (all ? true : query ? `${i.apiName} ${i.uiName}`.toLowerCase().includes(query) : i.customDefinition))
      .map((i) => ({ apiName: i.apiName, uiName: i.uiName, category: i.category ?? "" }));
  const dimensions = pick(meta.dimensions);
  const metrics = pick(meta.metrics);
  const scope = all ? "all" : query ? `matching "${query}"` : "custom";
  return {
    property: id,
    available: `${meta.dimensions?.length ?? 0} dimensions, ${meta.metrics?.length ?? 0} metrics`,
    dimensions: dimensions.length ? dimensions : `0 ${scope} dimensions`,
    metrics: metrics.length ? metrics : `0 ${scope} metrics`,
    ...(all ? {} : { help: [`${BIN} ga dims <query>  # search by name`, `${BIN} ga dims --all`] }),
  };
}

export async function gaCommand(args: string[]): Promise<Record<string, unknown> | string> {
  const [sub, ...rest] = args;
  if (sub === undefined || sub === "--help") return GA_HELP[""]!;
  if (rest.includes("--help") && GA_HELP[sub]) return GA_HELP[sub]!;
  if (sub === "accounts") return accountsCommand(rest);
  if (sub === "use") return useCommand(rest);
  if (sub === "report") return runReport(rest, false);
  if (sub === "realtime") return runReport(rest, true);
  if (sub === "dims") return dimsCommand(rest);
  throw usageError(`Unknown ga subcommand "${sub}"`, ["Valid: accounts, use, report, realtime, dims", `Run \`${BIN} ga --help\``]);
}
