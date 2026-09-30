import { usageError } from "./usage.js";

export interface DateRange {
  startDate: string;
  endDate: string;
}

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * `7d` means the last 7 complete days (7daysAgo..yesterday), matching GA's own
 * "Last 7 days". `today`/`yesterday` are single days. `A:B` is an explicit span.
 */
export function parseRange(range: string): DateRange {
  const days = /^(\d+)d$/.exec(range);
  if (days) {
    const n = Number(days[1]);
    if (n < 1) throw usageError("--range must be at least 1d");
    return { startDate: `${n}daysAgo`, endDate: "yesterday" };
  }
  if (range === "today" || range === "yesterday") return { startDate: range, endDate: range };
  const [start, end, extra] = range.split(":");
  if (start && end && extra === undefined && ISO_DAY.test(start) && ISO_DAY.test(end)) {
    if (start > end) throw usageError(`--range start ${start} is after end ${end}`);
    return { startDate: start, endDate: end };
  }
  throw usageError(`Unknown --range value "${range}"`, ["Valid forms: 7d, 28d, 90d, today, yesterday, 2026-09-01:2026-09-15"]);
}

const FILTER = /^([A-Za-z0-9_:.]+?)\s*(==|!=|=~|!~|=@|!@|>=|<=|>|<)\s*(.*)$/;
const STRING_MATCH: Record<string, string> = { "==": "EXACT", "=~": "FULL_REGEXP", "=@": "CONTAINS" };
const NUMERIC_OP: Record<string, string> = { "==": "EQUAL", ">": "GREATER_THAN", ">=": "GREATER_THAN_OR_EQUAL", "<": "LESS_THAN", "<=": "LESS_THAN_OR_EQUAL" };
const NEGATED: Record<string, string> = { "!=": "==", "!~": "=~", "!@": "=@" };

export const FILTER_SYNTAX = "field==value, field!=value, field=~regex, field!~regex, field=@substring, field!@substring, metric>N (>=, <, <=, ==)";

type Expression = Record<string, unknown>;

function combine(expressions: Expression[]): Expression | undefined {
  if (expressions.length === 0) return undefined;
  if (expressions.length === 1) return expressions[0];
  return { andGroup: { expressions } };
}

/**
 * Turns `--filter` strings into GA's FilterExpression. A field named in
 * `--metrics` becomes a metric filter (numeric compare); anything else is a
 * dimension filter (string match). Multiple filters are ANDed.
 */
export function parseFilters(filters: string[], metrics: string[]): { dimensionFilter?: Expression; metricFilter?: Expression } {
  const dims: Expression[] = [];
  const mets: Expression[] = [];
  for (const raw of filters) {
    const match = FILTER.exec(raw);
    if (!match) throw usageError(`Could not parse --filter "${raw}"`, [`Syntax: ${FILTER_SYNTAX}`]);
    const [, field, op, value] = match as unknown as [string, string, string, string];
    const negated = op in NEGATED;
    const base = NEGATED[op] ?? op;

    let expression: Expression;
    if (metrics.includes(field)) {
      if (!(base in NUMERIC_OP)) throw usageError(`--filter on metric ${field} needs a numeric compare`, [`e.g. --filter "${field}>100"`]);
      const n = Number(value);
      if (value === "" || Number.isNaN(n)) throw usageError(`--filter "${raw}": "${value}" is not a number`);
      expression = { filter: { fieldName: field, numericFilter: { operation: NUMERIC_OP[base], value: { doubleValue: n } } } };
    } else {
      if (!(base in STRING_MATCH)) throw usageError(`--filter "${raw}": ${op} only works on metrics named in --metrics`, [`Syntax: ${FILTER_SYNTAX}`]);
      expression = { filter: { fieldName: field, stringFilter: { matchType: STRING_MATCH[base], value } } };
    }
    (metrics.includes(field) ? mets : dims).push(negated ? { notExpression: expression } : expression);
  }
  const dimensionFilter = combine(dims);
  const metricFilter = combine(mets);
  return { ...(dimensionFilter ? { dimensionFilter } : {}), ...(metricFilter ? { metricFilter } : {}) };
}

const TIME_DIMENSION = /^(date|year|month|week|day|hour|isoYear|isoWeek|nth|minutesAgo)/;

/**
 * `--order -sessions,date` sorts sessions descending, then date ascending.
 * With no `--order`, a time dimension listed first sorts chronologically;
 * otherwise the first metric sorts descending.
 */
export function parseOrder(order: string[], metrics: string[], dims: string[]): Expression[] {
  const specs = order.length > 0 ? order : TIME_DIMENSION.test(dims[0] ?? "") ? [dims[0]!] : metrics[0] ? [`-${metrics[0]}`] : [];
  return specs.map((spec) => {
    const desc = spec.startsWith("-");
    const name = desc ? spec.slice(1) : spec;
    if (metrics.includes(name)) return { metric: { metricName: name }, desc };
    if (dims.includes(name)) return { dimension: { dimensionName: name }, desc };
    throw usageError(`--order field "${name}" is not in --metrics or --dims`, [`Order by one of: ${[...metrics, ...dims].join(", ")}`]);
  });
}

interface ReportResponse {
  dimensionHeaders?: Array<{ name: string }>;
  metricHeaders?: Array<{ name: string; type?: string }>;
  rows?: Array<{ dimensionValues?: Array<{ value?: string }>; metricValues?: Array<{ value?: string }> }>;
  totals?: Array<{ metricValues?: Array<{ value?: string }> }>;
  rowCount?: number;
  metadata?: { currencyCode?: string; timeZone?: string; subjectToThresholding?: boolean; samplingMetadatas?: unknown[] };
}

/** GA sends every metric as a string; ratios come back with 15+ decimals. */
function metricNumber(value: string | undefined): number {
  const n = Number(value ?? 0);
  return Number.isInteger(n) ? n : Math.round(n * 10_000) / 10_000;
}

/** GA's `date` dimension is YYYYMMDD; ISO dates are what every other tool expects. */
function dimensionValue(name: string, value: string): string {
  return name === "date" && /^\d{8}$/.test(value) ? `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6)}` : value;
}

export function shapeReport(response: ReportResponse): {
  rows: Array<Record<string, string | number>>;
  totals?: Record<string, number>;
  rowCount: number;
  notes: string[];
} {
  const dims = (response.dimensionHeaders ?? []).map((h) => h.name);
  const mets = (response.metricHeaders ?? []).map((h) => h.name);
  const rows = (response.rows ?? []).map((row) => {
    const out: Record<string, string | number> = {};
    dims.forEach((name, i) => (out[name] = dimensionValue(name, row.dimensionValues?.[i]?.value ?? "")));
    mets.forEach((name, i) => (out[name] = metricNumber(row.metricValues?.[i]?.value)));
    return out;
  });
  const totalsRow = response.totals?.[0];
  const totals = totalsRow ? Object.fromEntries(mets.map((name, i) => [name, metricNumber(totalsRow.metricValues?.[i]?.value)])) : undefined;
  const notes: string[] = [];
  if (response.metadata?.subjectToThresholding) notes.push("GA applied thresholding - small rows may be withheld");
  if (response.metadata?.samplingMetadatas?.length) notes.push("GA sampled this report");
  return { rows, ...(totals ? { totals } : {}), rowCount: response.rowCount ?? rows.length, notes };
}
