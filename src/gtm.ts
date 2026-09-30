import { usageError } from "./usage.js";

/** GTM's recursive parameter shape: a leaf value, or a list/map of parameters. */
export interface Parameter {
  type: string;
  key?: string;
  value?: string;
  list?: Parameter[];
  map?: Parameter[];
  isWeakReference?: boolean;
}

export type Resource = Record<string, unknown>;
export type Kind = "tag" | "trigger" | "variable";

export const KINDS: Record<Kind, { plural: string; idKey: string; collection: string }> = {
  tag: { plural: "tags", idKey: "tagId", collection: "tag" },
  trigger: { plural: "triggers", idKey: "triggerId", collection: "trigger" },
  variable: { plural: "variables", idKey: "variableId", collection: "variable" },
};

/** Triggers every container has that never appear in `triggers.list`. */
export const BUILT_IN_TRIGGERS: Record<string, string> = {
  "2147479553": "All Pages",
  "2147479572": "Consent Initialization - All Pages",
  "2147479573": "Initialization - All Pages",
};

const PARAMETER_KEYS = new Set(["type", "key", "value", "list", "map", "isWeakReference"]);

function isParameter(value: unknown): value is Parameter {
  return (
    typeof value === "object" && value !== null && !Array.isArray(value) &&
    typeof (value as Parameter).type === "string" &&
    Object.keys(value).every((k) => PARAMETER_KEYS.has(k))
  );
}

export function flattenParam(p: Parameter): unknown {
  if (p.type === "list" || p.list) return (p.list ?? []).map(flattenParam);
  if (p.type === "map" || p.map) return flattenParams(p.map ?? []);
  return p.value ?? "";
}

export function flattenParams(params: Parameter[]): Record<string, unknown> {
  return Object.fromEntries(params.map((p) => [p.key ?? "", flattenParam(p)]));
}

interface Condition {
  type: string;
  parameter?: Parameter[];
}

/** `{type: contains, parameter: [arg0 {{Page URL}}, arg1 /checkout]}` -> `{{Page URL}} contains /checkout`. */
export function conditionText(c: Condition): string {
  const params = flattenParams(c.parameter ?? []);
  const negate = params.negate === "true" ? "not " : "";
  const ignoreCase = params.ignore_case === "true" ? " (ignore case)" : "";
  return `${params.arg0 ?? ""} ${negate}${c.type} ${params.arg1 ?? ""}${ignoreCase}`.trim();
}

const CONDITION_FIELDS = ["filter", "customEventFilter", "autoEventFilter"];
/** Fields that identify or version the resource, not what it does - left out of readable views and diffs. */
const PLUMBING = ["accountId", "containerId", "workspaceId", "path", "fingerprint", "tagManagerUrl", "tagId", "triggerId", "variableId", "parameter", "firingTriggerId", "blockingTriggerId"];

/**
 * A resource as a human would read it in the GTM UI: parameters become a
 * key/value map, trigger conditions become sentences, trigger IDs become
 * names, and API plumbing is dropped.
 */
export function readable(resource: Resource, triggerNames: Map<string, string> = new Map()): Resource {
  const out: Resource = {};
  const name = (id: string) => triggerNames.get(id) ?? BUILT_IN_TRIGGERS[id] ?? `unknown trigger ${id}`;
  for (const [key, value] of Object.entries(resource)) {
    if (PLUMBING.includes(key)) continue;
    if (value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).length === 0) continue;
    if (CONDITION_FIELDS.includes(key) && Array.isArray(value)) out[key] = (value as Condition[]).map(conditionText);
    else if (isParameter(value)) out[key] = flattenParam(value);
    else out[key] = value;
  }
  if (Array.isArray(resource.firingTriggerId)) out.firing = (resource.firingTriggerId as string[]).map(name);
  if (Array.isArray(resource.blockingTriggerId)) out.blocking = (resource.blockingTriggerId as string[]).map(name);
  if (Array.isArray(resource.parameter)) out.parameters = flattenParams(resource.parameter as Parameter[]);
  return out;
}

/** Nested object -> `a.b[0].c: value` lines, so a diff shows exactly which leaf changed. */
export function flattenPaths(value: unknown, prefix = "", out: Record<string, string> = {}): Record<string, string> {
  if (Array.isArray(value)) {
    if (value.length === 0 && prefix) out[prefix] = "[]";
    value.forEach((v, i) => flattenPaths(v, `${prefix}[${i}]`, out));
  } else if (typeof value === "object" && value !== null) {
    const entries = Object.entries(value);
    if (entries.length === 0 && prefix) out[prefix] = "{}";
    for (const [k, v] of entries) flattenPaths(v, prefix ? `${prefix}.${k}` : k, out);
  } else if (prefix) {
    out[prefix] = typeof value === "string" ? value : JSON.stringify(value);
  }
  return out;
}

export const UNSET = "(unset)";

export interface DiffRow {
  field: string;
  before: string;
  after: string;
}

export function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}... (truncated, ${text.length} chars total)` : text;
}

export function diff(before: Resource | undefined, after: Resource | undefined, triggerNames?: Map<string, string>, maxValue = 200): DiffRow[] {
  const a = before ? flattenPaths(readable(before, triggerNames)) : {};
  const b = after ? flattenPaths(readable(after, triggerNames)) : {};
  const fields = [...new Set([...Object.keys(a), ...Object.keys(b)])].sort();
  return fields
    .filter((f) => a[f] !== b[f])
    .map((field) => ({ field, before: truncate(a[field] ?? UNSET, maxValue), after: truncate(b[field] ?? UNSET, maxValue) }));
}

/**
 * Applies a partial resource onto the current one. Top-level fields replace;
 * `parameter` entries merge by key, so a patch only needs the parameters it
 * changes.
 */
export function merge(current: Resource, patch: Resource): Resource {
  const next: Resource = { ...current, ...patch };
  if (Array.isArray(patch.parameter) && Array.isArray(current.parameter)) {
    const byKey = new Map((current.parameter as Parameter[]).map((p) => [p.key, p]));
    for (const p of patch.parameter as Parameter[]) byKey.set(p.key, p);
    next.parameter = [...byKey.values()];
  }
  return next;
}

/** `--param key=value` -> a template parameter, keeping the existing param's type (boolean, integer) if there is one. */
export function paramFlags(flags: string[], current: Parameter[] = []): Parameter[] {
  return flags.map((raw) => {
    const eq = raw.indexOf("=");
    if (eq <= 0) throw usageError(`--param "${raw}" must be key=value`, ['--param eventName=purchase']);
    const key = raw.slice(0, eq);
    const existing = current.find((p) => p.key === key);
    return { type: existing && !existing.list && !existing.map ? existing.type : "template", key, value: raw.slice(eq + 1) };
  });
}

/**
 * Finds one resource by exact ID, then exact name, then case-insensitive
 * name. Ambiguity is an error rather than a guess.
 */
export function resolve<T extends Resource>(kind: Kind, items: T[], ref: string): T | undefined {
  const { idKey } = KINDS[kind];
  const byId = items.find((i) => String(i[idKey]) === ref);
  if (byId) return byId;
  const exact = items.filter((i) => i.name === ref);
  const matches = exact.length ? exact : items.filter((i) => String(i.name).toLowerCase() === ref.toLowerCase());
  if (matches.length > 1) {
    throw usageError(`"${ref}" matches ${matches.length} ${KINDS[kind].plural}`, matches.map((m) => `Use the ID: ${m[idKey]} (${m.name})`));
  }
  return matches[0];
}

export function suggestions(kind: Kind, items: Resource[], ref: string): string[] {
  const { idKey, plural } = KINDS[kind];
  const needle = ref.toLowerCase();
  const close = items.filter((i) => String(i.name).toLowerCase().includes(needle)).slice(0, 5);
  return [...close.map((i) => `Did you mean ${i[idKey]} (${i.name})?`), `google-analytics-axi gtm ${plural} <search>`];
}
