import { readFileSync } from "node:fs";
import { AxiError } from "axi-sdk-js";
import { list, many, one, parseFlags, type ParsedFlags } from "../flags.js";
import { GTM_API, listAll, request } from "../google.js";
import { type GtmContext, parseGtmUrl, readDefaults, writeDefaults } from "../defaults.js";
import {
  BUILT_IN_TRIGGERS,
  diff,
  type Kind,
  KINDS,
  merge,
  type Parameter,
  paramFlags,
  readable,
  resolve,
  type Resource,
  suggestions,
  truncate,
} from "../gtm.js";
import { expectNoArgs, usageError } from "../usage.js";

const BIN = "google-marketing-axi";
const CTX_FLAGS = ["account", "container", "workspace"];
const CTX_HELP = `  --account <id>       GTM account (default: \`gtm use\` cache)
  --container <id>     GTM container (default: \`gtm use\` cache)
  --workspace <id>     GTM workspace (default: \`gtm use\` cache)`;

const WRITE_HELP = (kind: Kind) => `${BIN} gtm ${kind} <create|update|delete> [flags]

  gtm ${kind} create [flags]                  Add a ${kind} (needs name and type)
  gtm ${kind} update <name-or-id> [flags]     Fetch, merge the changes, send with its fingerprint
  gtm ${kind} delete <name-or-id>             Remove it (already gone = no-op)

Every write prints a field-by-field before/after diff. An update or create
that changes nothing is a no-op and sends nothing.

Flags:
  --file <path|->      JSON body in Tag Manager API shape (a partial ${kind}); - reads stdin.
                       "parameter" entries merge by key, other fields replace.
  --name <name>        Set the name
  --type <type>        Set the type (e.g. ${kind === "tag" ? "gaawe, html, googtag" : kind === "trigger" ? "customEvent, pageview, click" : "v, jsm, c, u"})
  --notes <text>       Set the notes
  --param <key=value>  Repeatable. Set one parameter (keeps its existing type)${
    kind === "tag"
      ? `
  --firing <trigger>   Repeatable. Replace firing triggers (name or ID; "All Pages" works)
  --blocking <trigger> Repeatable. Replace blocking (exception) triggers
  --paused / --unpause Pause or unpause the tag`
      : ""
  }
  --dry-run            Print the diff without sending anything
  --full               Do not truncate long values in the diff
${CTX_HELP}

Examples:
  ${BIN} gtm ${kind} update "${kind === "tag" ? "GA4 - purchase" : kind === "trigger" ? "CE - purchase" : "DLV - value"}" --param ${kind === "tag" ? "eventName=purchase" : "key=value"} --dry-run
  ${BIN} gtm ${kind} create --file new-${kind}.json --dry-run
  ${BIN} gtm ${kind} delete <id> --dry-run`;

export const GTM_HELP: Record<string, string> = {
  "": `${BIN} gtm <subcommand> [flags]

Google Tag Manager via the Tag Manager API v2.

subcommands[12]{command,what}:
  use <gtm-url>,Cache a default account/container/workspace from a GTM URL
  accounts,List GTM accounts
  containers,List containers in the account
  workspaces,List workspaces in the container
  tags [search],Compact tag list with firing triggers by name
  triggers [search],Compact trigger list
  variables [search],Compact variable list
  tag|trigger|variable <name-or-id>,Full detail with parameters flattened
  tag|trigger|variable create|update|delete,Diffed writes with --dry-run
  status,Pending workspace changes and merge conflicts
  version create,Snapshot the workspace as a container version
  (no publish),Publishing is done by a human in the GTM UI - deliberately not a command

Examples:
  ${BIN} gtm use "https://tagmanager.google.com/#/container/accounts/<a>/containers/<c>/workspaces/<w>"
  ${BIN} gtm tags purchase
  ${BIN} gtm tag "GA4 - purchase"`,
  use: `${BIN} gtm use [gtm-url] [flags]

Cache the default account/container/workspace every other gtm command uses.
Accepts a tagmanager.google.com URL or an accounts/<a>/containers/<c>[/workspaces/<w>]
path, or the IDs as flags. With nothing, prints the current default.

Flags:
${CTX_HELP}

Examples:
  ${BIN} gtm use "https://tagmanager.google.com/#/container/accounts/6000000000/containers/50000000/workspaces/12"
  ${BIN} gtm use --workspace 13`,
  accounts: `${BIN} gtm accounts

List every GTM account the signed-in user can see.

Examples:
  ${BIN} gtm accounts`,
  containers: `${BIN} gtm containers [--account <id>]

List containers in an account.

Examples:
  ${BIN} gtm containers
  ${BIN} gtm containers --account 6000000000`,
  workspaces: `${BIN} gtm workspaces [--account <id>] [--container <id>]

List workspaces in a container; "current" marks the cached default.

Examples:
  ${BIN} gtm workspaces`,
  status: `${BIN} gtm status [flags]

Pending changes in the workspace (what the next version would contain) and
merge conflicts with the latest container version.

Flags:
${CTX_HELP}

Examples:
  ${BIN} gtm status`,
  version: `${BIN} gtm version create --name <name> [--notes <text>] [--dry-run]

Snapshot the workspace's pending changes as a new container version. GTM then
replaces the workspace with a fresh one; the cached default follows it.
There is deliberately no publish command - a human publishes the version in
the GTM UI after reviewing it.

Flags:
  --name <name>        Required. Version name
  --notes <text>       Version description
  --dry-run            Show what would be versioned without creating it
${CTX_HELP}

Examples:
  ${BIN} gtm version create --name "Add purchase tracking" --dry-run
  ${BIN} gtm version create --name "Add purchase tracking" --notes "GA4 purchase + Ads conversion"`,
};

const EXTRA_FIELDS: Record<Kind, string[]> = {
  tag: ["blocking", "notes", "folderId"],
  trigger: ["conditions", "notes", "folderId"],
  variable: ["notes", "folderId"],
};

for (const kind of Object.keys(KINDS) as Kind[]) {
  const { plural } = KINDS[kind];
  GTM_HELP[plural] = `${BIN} gtm ${plural} [search] [flags]

List every ${kind} in the workspace (${kind === "tag" ? "id, name, type, firing trigger names, paused" : "id, name, type"}).
[search] filters by name substring.

Flags:
  --type <type>        Only this ${kind} type
  --fields <a,b>       Add columns: ${EXTRA_FIELDS[kind].join(", ")}
${CTX_HELP}

Examples:
  ${BIN} gtm ${plural}
  ${BIN} gtm ${plural} purchase
  ${BIN} gtm ${plural} --fields ${EXTRA_FIELDS[kind][0]}`;
  GTM_HELP[kind] = `${BIN} gtm ${kind} <name-or-id> [--full]

Full ${kind} detail: parameters flattened to key/value${kind === "tag" ? ", triggers by name" : kind === "trigger" ? ", conditions as text, and the tags that fire on it" : ", and every tag/trigger/variable that references it"}.
Long values are truncated to 500 chars unless --full.

${WRITE_HELP(kind)}`;
}

function context(flags: ParsedFlags, needWorkspace = true): Required<GtmContext> {
  const cached = readDefaults().gtm;
  const account = one(flags, "account") ?? cached?.account;
  const container = one(flags, "container") ?? (one(flags, "account") && one(flags, "account") !== cached?.account ? undefined : cached?.container);
  const workspace = one(flags, "workspace") ?? (container === cached?.container ? cached?.workspace : undefined);
  if (!account) throw usageError("No GTM account - pass --account or cache a default", [`${BIN} gtm use <gtm-url>`, `${BIN} gtm accounts`]);
  if (needWorkspace && !container) throw usageError("No GTM container - pass --container or cache a default", [`${BIN} gtm use <gtm-url>`, `${BIN} gtm containers`]);
  if (needWorkspace && !workspace) throw usageError("No GTM workspace - pass --workspace or cache a default", [`${BIN} gtm workspaces`, `${BIN} gtm use --workspace <id>`]);
  return { account, container: container ?? "", workspace: workspace ?? "" };
}

const containerUrl = (c: GtmContext) => `${GTM_API}/accounts/${c.account}/containers/${c.container}`;
const workspaceUrl = (c: Required<GtmContext>) => `${containerUrl(c)}/workspaces/${c.workspace}`;

async function fetchAll(ctx: Required<GtmContext>, kind: Kind): Promise<Resource[]> {
  return listAll<Resource>(`${workspaceUrl(ctx)}/${KINDS[kind].plural}`, KINDS[kind].collection);
}

function triggerNameMap(triggers: Resource[]): Map<string, string> {
  return new Map(triggers.map((t) => [String(t.triggerId), String(t.name)]));
}

async function accountsCommand(args: string[]): Promise<Record<string, unknown>> {
  expectNoArgs("gtm accounts", parseFlags(args, {}).positionals);
  const accounts = await listAll<Resource>(`${GTM_API}/accounts`, "account");
  if (accounts.length === 0) return { accounts: "0 GTM accounts visible to the signed-in user" };
  return {
    count: accounts.length,
    accounts: accounts.map((a) => ({ id: a.accountId, name: a.name })),
    help: [`${BIN} gtm containers --account <id>`],
  };
}

async function containersCommand(args: string[]): Promise<Record<string, unknown>> {
  const flags = parseFlags(args, { value: ["account"] });
  expectNoArgs("gtm containers", flags.positionals);
  const ctx = context(flags, false);
  const containers = await listAll<Resource>(`${GTM_API}/accounts/${ctx.account}/containers`, "container");
  if (containers.length === 0) return { containers: `0 containers in account ${ctx.account}` };
  return {
    account: ctx.account,
    count: containers.length,
    containers: containers.map((c) => ({ id: c.containerId, name: c.name, publicId: c.publicId, usage: ((c.usageContext as string[]) ?? []).join(",") })),
    help: [`${BIN} gtm workspaces --account ${ctx.account} --container <id>`],
  };
}

async function workspacesCommand(args: string[]): Promise<Record<string, unknown>> {
  const flags = parseFlags(args, { value: ["account", "container"] });
  expectNoArgs("gtm workspaces", flags.positionals);
  const ctx = context(flags, false);
  if (!ctx.container) throw usageError("No GTM container - pass --container or cache a default", [`${BIN} gtm containers`]);
  const workspaces = await listAll<Resource>(`${containerUrl(ctx)}/workspaces`, "workspace");
  const current = readDefaults().gtm?.workspace;
  if (workspaces.length === 0) return { workspaces: `0 workspaces in container ${ctx.container}` };
  return {
    count: workspaces.length,
    workspaces: workspaces.map((w) => ({ id: w.workspaceId, name: w.name, current: w.workspaceId === current })),
    help: [`${BIN} gtm use --account ${ctx.account} --container ${ctx.container} --workspace <id>`],
  };
}

function useCommand(args: string[]): Record<string, unknown> {
  const flags = parseFlags(args, { value: CTX_FLAGS });
  const [input, ...extra] = flags.positionals;
  if (extra.length) throw usageError("gtm use takes one URL", [`${BIN} gtm use "<gtm-url>"`]);
  const cached = readDefaults().gtm;
  if (!input && CTX_FLAGS.every((f) => !one(flags, f))) {
    return cached ? { gtm: cached } : { gtm: "none cached", help: [`${BIN} gtm use "<gtm-url>"`] };
  }
  const parsed = input ? parseGtmUrl(input) : undefined;
  const account = one(flags, "account") ?? parsed?.account ?? cached?.account;
  const container = one(flags, "container") ?? parsed?.container ?? cached?.container;
  const workspace = one(flags, "workspace") ?? parsed?.workspace ?? (parsed ? undefined : cached?.workspace);
  if (!account || !container) throw usageError("gtm use needs at least an account and container", [`${BIN} gtm use "<gtm-url>"`]);
  const gtm: GtmContext = { account, container, ...(workspace ? { workspace } : {}) };
  writeDefaults({ gtm });
  return {
    gtm,
    cached: "default for --account/--container/--workspace",
    help: workspace ? [`${BIN} gtm tags`, `${BIN} gtm status`] : [`${BIN} gtm workspaces`, `${BIN} gtm use --workspace <id>`],
  };
}

function compactRow(kind: Kind, r: Resource, names: Map<string, string>, extra: string[]): Record<string, unknown> {
  const view = readable(r, names);
  const row: Record<string, unknown> = { id: r[KINDS[kind].idKey], name: r.name, type: r.type };
  if (kind === "tag") {
    row.firing = ((view.firing as string[]) ?? []).join("; ");
    row.paused = r.paused === true;
  }
  for (const field of extra) {
    if (field === "blocking") row.blocking = ((view.blocking as string[]) ?? []).join("; ");
    else if (field === "conditions") row.conditions = ["filter", "customEventFilter", "autoEventFilter"].flatMap((f) => (view[f] as string[]) ?? []).join(" AND ");
    else if (field === "folderId") row.folderId = r.parentFolderId ?? "";
    else row[field] = truncate(String(r[field] ?? ""), 120);
  }
  return row;
}

async function listCommand(kind: Kind, args: string[]): Promise<Record<string, unknown>> {
  const flags = parseFlags(args, { value: [...CTX_FLAGS, "type", "fields"] });
  const search = flags.positionals.join(" ").trim().toLowerCase();
  const type = one(flags, "type");
  const extra = list(flags, "fields");
  const bad = extra.filter((f) => !EXTRA_FIELDS[kind].includes(f));
  if (bad.length) throw usageError(`Unknown --fields ${bad.join(", ")}`, [`Valid: ${EXTRA_FIELDS[kind].join(", ")}`]);
  const ctx = context(flags);
  const { plural } = KINDS[kind];
  const [items, triggers] = await Promise.all([fetchAll(ctx, kind), kind === "tag" ? fetchAll(ctx, "trigger") : Promise.resolve([])]);
  const names = triggerNameMap(kind === "trigger" ? items : triggers);
  const matching = items.filter((i) => (!search || String(i.name).toLowerCase().includes(search)) && (!type || i.type === type));
  const scope = [search && `matching "${search}"`, type && `of type ${type}`].filter(Boolean).join(" ");
  if (matching.length === 0) {
    return { [plural]: `0 ${plural}${scope ? ` ${scope}` : ""} in workspace ${ctx.workspace} (${items.length} total)` };
  }
  return {
    count: matching.length === items.length ? items.length : `${matching.length} of ${items.length} ${scope}`,
    [plural]: matching.map((i) => compactRow(kind, i, names, extra)),
    help: [`${BIN} gtm ${kind} <name-or-id>`],
  };
}

/** Truncates every string leaf over `max` chars; reports whether anything was cut. */
function truncateDeep(value: unknown, max: number, state: { cut: boolean }): unknown {
  if (typeof value === "string") {
    if (value.length > max) state.cut = true;
    return truncate(value, max);
  }
  if (Array.isArray(value)) return value.map((v) => truncateDeep(v, max, state));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, truncateDeep(v, max, state)]));
  return value;
}

async function detailCommand(kind: Kind, ref: string, args: string[]): Promise<Record<string, unknown>> {
  const flags = parseFlags(args, { value: CTX_FLAGS, boolean: ["full"] });
  expectNoArgs(`gtm ${kind} ${ref}`, flags.positionals);
  const ctx = context(flags);
  const [tags, triggers, variables] = await Promise.all([
    fetchAll(ctx, "tag"),
    fetchAll(ctx, "trigger"),
    kind === "variable" ? fetchAll(ctx, "variable") : Promise.resolve([]),
  ]);
  const pool = kind === "tag" ? tags : kind === "trigger" ? triggers : variables;
  const item = resolve(kind, pool, ref);
  if (!item) throw notFound(kind, pool, ref, ctx);
  const names = triggerNameMap(triggers);
  const view: Resource = { id: item[KINDS[kind].idKey], ...readable(item, names) };

  if (kind === "trigger") {
    const id = String(item.triggerId);
    const firedBy = tags.filter((t) => ((t.firingTriggerId as string[]) ?? []).includes(id)).map((t) => String(t.name));
    const blocks = tags.filter((t) => ((t.blockingTriggerId as string[]) ?? []).includes(id)).map((t) => String(t.name));
    view.firesTags = firedBy.length ? firedBy : "none";
    if (blocks.length) view.blocksTags = blocks;
  }
  if (kind === "variable") {
    const needle = `{{${item.name}}}`;
    const refs = [...tags.map((t) => ["tag", t] as const), ...triggers.map((t) => ["trigger", t] as const), ...variables.filter((v) => v !== item).map((v) => ["variable", v] as const)]
      .filter(([, r]) => JSON.stringify(r).includes(needle))
      .map(([k, r]) => `${k}: ${r.name}`);
    view.referencedBy = refs.length ? refs : "none";
  }

  const state = { cut: false };
  const shown = flags.booleans.has("full") ? view : (truncateDeep(view, 500, state) as Resource);
  return {
    [kind]: shown,
    ...(state.cut ? { help: [`${BIN} gtm ${kind} ${JSON.stringify(ref)} --full  # untruncated values`] } : {}),
  };
}

function notFound(kind: Kind, items: Resource[], ref: string, ctx: Required<GtmContext>) {
  return usageError(`No ${kind} "${ref}" in workspace ${ctx.workspace}`, suggestions(kind, items, ref));
}

interface StatusResponse {
  workspaceChange?: Array<Record<string, unknown>>;
  mergeConflict?: Array<{ entityInWorkspace?: Record<string, unknown>; entityInBaseVersion?: Record<string, unknown> }>;
}

const ENTITY_KINDS = ["tag", "trigger", "variable", "folder", "client", "transformation", "zone", "builtInVariable", "customTemplate", "gtagConfig"];

function entityRow(entity: Record<string, unknown> | undefined): { kind: string; id: string; name: string } {
  const kind = ENTITY_KINDS.find((k) => entity?.[k]) ?? "unknown";
  const inner = (entity?.[kind] ?? {}) as Record<string, unknown>;
  // builtInVariable is an array of { name, type }; every other entity is one object with <kind>Id.
  if (Array.isArray(inner)) return { kind, id: "", name: (inner as Resource[]).map((b) => b.name).join(", ") };
  return { kind, id: String(inner[`${kind}Id`] ?? ""), name: String(inner.name ?? "") };
}

async function workspaceStatus(ctx: Required<GtmContext>) {
  const status = (await request(`${workspaceUrl(ctx)}/status`)) as StatusResponse;
  const changes = (status.workspaceChange ?? []).map((c) => ({ change: String(c.changeStatus ?? ""), ...entityRow(c) }));
  const conflicts = (status.mergeConflict ?? []).map((c) => entityRow(c.entityInWorkspace ?? c.entityInBaseVersion));
  return { changes, conflicts };
}

async function statusCommand(args: string[]): Promise<Record<string, unknown>> {
  const flags = parseFlags(args, { value: CTX_FLAGS });
  expectNoArgs("gtm status", flags.positionals);
  const ctx = context(flags);
  const { changes, conflicts } = await workspaceStatus(ctx);
  return {
    workspace: ctx.workspace,
    changes: changes.length ? changes : "0 pending changes - the workspace matches the latest container version",
    conflicts: conflicts.length ? conflicts : 0,
    ...(changes.length ? { help: [`${BIN} gtm version create --name "<name>" --dry-run`] } : {}),
  };
}

function readJsonFile(path: string): Resource {
  let raw: string;
  try {
    raw = readFileSync(path === "-" ? 0 : path, "utf8");
  } catch {
    throw usageError(`Could not read --file ${path}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw usageError(`--file ${path} is not valid JSON: ${(error as Error).message}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw usageError(`--file ${path} must hold one JSON object`);
  return parsed as Resource;
}

function triggerIds(refs: string[], triggers: Resource[]): string[] {
  return refs.map((ref) => {
    const builtIn = Object.entries(BUILT_IN_TRIGGERS).find(([id, name]) => ref === id || ref.toLowerCase() === name.toLowerCase());
    if (builtIn) return builtIn[0];
    const found = resolve("trigger", triggers, ref);
    if (!found) throw usageError(`No trigger "${ref}"`, suggestions("trigger", triggers, ref));
    return String(found.triggerId);
  });
}

/** Everything a write flag set says to change, as a partial resource. */
export function buildPatch(kind: Kind, flags: ParsedFlags, current: Resource | undefined, triggers: Resource[]): Resource {
  const file = one(flags, "file");
  const patch: Resource = file ? readJsonFile(file) : {};
  for (const field of ["name", "type", "notes"]) {
    const value = one(flags, field);
    if (value !== undefined) patch[field] = value;
  }
  const params = many(flags, "param");
  if (params) {
    const base = [...((current?.parameter as Parameter[]) ?? []), ...((patch.parameter as Parameter[]) ?? [])];
    const fromFlags = paramFlags(params, base);
    const fileParams = ((patch.parameter as Parameter[]) ?? []).filter((p) => !fromFlags.some((f) => f.key === p.key));
    patch.parameter = [...fileParams, ...fromFlags];
  }
  if (kind === "tag") {
    const firing = many(flags, "firing");
    const blocking = many(flags, "blocking");
    if (firing) patch.firingTriggerId = triggerIds(firing, triggers);
    if (blocking) patch.blockingTriggerId = triggerIds(blocking, triggers);
    if (flags.booleans.has("paused")) patch.paused = true;
    if (flags.booleans.has("unpause")) patch.paused = false;
  }
  for (const key of ["accountId", "containerId", "workspaceId", "path", "fingerprint", "tagManagerUrl", KINDS[kind].idKey]) delete patch[key];
  return patch;
}

function writeFlags(kind: Kind): { value: string[]; boolean: string[] } {
  return {
    value: [...CTX_FLAGS, "file", "name", "type", "notes", "param", ...(kind === "tag" ? ["firing", "blocking"] : [])],
    boolean: ["dry-run", "full", ...(kind === "tag" ? ["paused", "unpause"] : [])],
  };
}

/** Usage mistakes that need no API data, checked before any request is sent. */
function validateWriteInput(kind: Kind, action: string, flags: ParsedFlags): void {
  const { plural } = KINDS[kind];
  if (flags.booleans.has("paused") && flags.booleans.has("unpause")) throw usageError("Pass --paused or --unpause, not both");
  if (action === "create") {
    expectNoArgs(`gtm ${kind} create`, flags.positionals);
    const file = one(flags, "file");
    const fromFile = file ? readJsonFile(file) : {};
    if (!(one(flags, "name") ?? fromFile.name) || !(one(flags, "type") ?? fromFile.type)) {
      throw usageError(`gtm ${kind} create needs a name and a type`, [`--name "<name>" --type <type>, or both in --file`]);
    }
    return;
  }
  const [ref, ...extra] = flags.positionals;
  if (!ref) throw usageError(`gtm ${kind} ${action} needs a ${kind} name or ID`, [`${BIN} gtm ${plural}  # find it`]);
  if (extra.length) throw usageError(`Unexpected arguments "${extra.join(" ")}" - quote names that contain spaces`, [`${BIN} gtm ${kind} ${action} "<name>"`]);
  if (action === "update" && !writeFlags(kind).value.some((f) => !CTX_FLAGS.includes(f) && flags.values[f]?.length) && !flags.booleans.has("paused") && !flags.booleans.has("unpause")) {
    throw usageError(`gtm ${kind} update needs something to change`, ["Pass --file, --name, --param, ..."]);
  }
}

async function writeCommand(kind: Kind, action: string, args: string[]): Promise<Record<string, unknown>> {
  const flags = parseFlags(args, action === "delete" ? { value: CTX_FLAGS, boolean: ["dry-run", "full"] } : writeFlags(kind));
  validateWriteInput(kind, action, flags);
  const dryRun = flags.booleans.has("dry-run");
  const maxValue = flags.booleans.has("full") ? Infinity : 200;
  const ctx = context(flags);
  const { plural, idKey } = KINDS[kind];
  const [items, triggers] = await Promise.all([fetchAll(ctx, kind), kind === "trigger" ? Promise.resolve(undefined) : fetchAll(ctx, "trigger")]);
  const allTriggers = triggers ?? items;
  const names = triggerNameMap(allTriggers);
  const label = dryRun ? "dry-run - nothing sent" : undefined;

  if (action === "create") {
    const desired = buildPatch(kind, flags, undefined, allTriggers);
    const existing = resolve(kind, items, String(desired.name));
    if (existing && String(existing.name) === String(desired.name)) {
      const changes = diff(existing, merge(existing, desired), names, maxValue);
      if (changes.length === 0) return { [kind]: `"${desired.name}" already exists as ${existing[idKey]} with these settings (no-op)` };
      throw usageError(`A ${kind} named "${desired.name}" already exists (${existing[idKey]}) with different settings`, [
        `${BIN} gtm ${kind} update ${existing[idKey]} ... --dry-run`,
      ]);
    }
    const changes = diff(undefined, desired, names, maxValue);
    if (dryRun) return { action: `create ${kind}`, result: label, diff: changes, help: [`Rerun without --dry-run to create it`] };
    const created = (await request(`${workspaceUrl(ctx)}/${plural}`, { method: "POST", body: desired })) as Resource;
    return { action: `created ${kind}`, id: created[idKey], name: created.name, diff: diff(undefined, created, names, maxValue), help: [`${BIN} gtm status`] };
  }

  const [ref] = flags.positionals;
  const current = resolve(kind, items, ref);

  if (action === "delete") {
    if (!current) return { [kind]: `"${ref}" is not in workspace ${ctx.workspace} - already deleted (no-op)` };
    const changes = diff(current, undefined, names, maxValue);
    const usedBy = kind === "trigger" ? await tagsUsing(ctx, String(current.triggerId)) : [];
    const warning = usedBy.length ? { warning: `Tags still reference this trigger: ${usedBy.join(", ")}` } : {};
    if (dryRun) return { action: `delete ${kind} ${current[idKey]}`, result: label, ...warning, diff: changes };
    await request(`${GTM_API}/${current.path}`, { method: "DELETE" });
    return { action: `deleted ${kind} ${current[idKey]}`, name: current.name, ...warning, diff: changes, help: [`${BIN} gtm status`] };
  }

  if (!current) throw notFound(kind, items, ref, ctx);
  const patch = buildPatch(kind, flags, current, allTriggers);
  if (Object.keys(patch).length === 0) throw usageError(`gtm ${kind} update needs something to change`, ["Pass --file, --name, --param, ..."]);
  const next = merge(current, patch);
  const changes = diff(current, next, names, maxValue);
  if (changes.length === 0) return { [kind]: `"${current.name}" (${current[idKey]}) already matches (no-op)` };
  if (dryRun) return { action: `update ${kind} ${current[idKey]}`, result: label, diff: changes, help: ["Rerun without --dry-run to send it"] };
  const updated = (await request(`${GTM_API}/${current.path}?fingerprint=${encodeURIComponent(String(current.fingerprint))}`, { method: "PUT", body: next })) as Resource;
  return { action: `updated ${kind} ${current[idKey]}`, name: updated.name, diff: diff(current, updated, names, maxValue), help: [`${BIN} gtm status`] };
}

async function tagsUsing(ctx: Required<GtmContext>, triggerId: string): Promise<string[]> {
  const tags = await fetchAll(ctx, "tag");
  return tags
    .filter((t) => [...((t.firingTriggerId as string[]) ?? []), ...((t.blockingTriggerId as string[]) ?? [])].includes(triggerId))
    .map((t) => String(t.name));
}

async function versionCommand(args: string[]): Promise<Record<string, unknown>> {
  const [sub, ...rest] = args;
  if (sub !== "create") {
    throw usageError(`Unknown gtm version target "${sub ?? ""}"`, [
      `${BIN} gtm version create --name "<name>"`,
      "Publishing is deliberately not supported - a human publishes in the GTM UI",
    ]);
  }
  const flags = parseFlags(rest, { value: [...CTX_FLAGS, "name", "notes"], boolean: ["dry-run"] });
  expectNoArgs("gtm version create", flags.positionals);
  const name = one(flags, "name");
  if (!name) throw usageError("gtm version create requires --name", [`${BIN} gtm version create --name "<name>" --notes "<what changed>"`]);
  const ctx = context(flags);
  const { changes, conflicts } = await workspaceStatus(ctx);
  if (changes.length === 0) return { version: `workspace ${ctx.workspace} has no pending changes - nothing to version (no-op)` };
  if (conflicts.length) {
    throw new AxiError(`Workspace ${ctx.workspace} has ${conflicts.length} merge conflicts`, "merge_conflict", [
      "Resolve them in the GTM UI, then rerun",
    ]);
  }
  if (flags.booleans.has("dry-run")) {
    return { action: `create version "${name}" from workspace ${ctx.workspace}`, result: "dry-run - nothing sent", changes };
  }
  const result = (await request(`${workspaceUrl(ctx)}:create_version`, { method: "POST", body: { name, ...(one(flags, "notes") ? { notes: one(flags, "notes") } : {}) } })) as {
    containerVersion?: Resource;
    compilerError?: boolean;
    newWorkspacePath?: string;
  };
  if (result.compilerError) {
    throw new AxiError("GTM reported a compiler error - no version was created", "compiler_error", [`${BIN} gtm status`]);
  }
  const version = result.containerVersion ?? {};
  const newWorkspace = /workspaces\/(\d+)/.exec(result.newWorkspacePath ?? "")?.[1];
  const cached = readDefaults().gtm;
  if (newWorkspace && cached?.account === ctx.account && cached.container === ctx.container && cached.workspace === ctx.workspace) {
    writeDefaults({ gtm: { ...cached, workspace: newWorkspace } });
  }
  return {
    version: { id: version.containerVersionId, name: version.name, changes: changes.length },
    ...(newWorkspace ? { newWorkspace } : {}),
    help: [
      `Not published. A human reviews and publishes it in the GTM UI: https://tagmanager.google.com/#/versions/accounts/${ctx.account}/containers/${ctx.container}/versions/${version.containerVersionId}`,
    ],
  };
}

export async function gtmCommand(args: string[]): Promise<Record<string, unknown> | string> {
  const [sub, ...rest] = args;
  if (sub === undefined || sub === "--help") return GTM_HELP[""]!;
  if (rest.includes("--help")) {
    if (GTM_HELP[sub]) return GTM_HELP[sub]!;
  }
  if (sub === "use") return useCommand(rest);
  if (sub === "accounts") return accountsCommand(rest);
  if (sub === "containers") return containersCommand(rest);
  if (sub === "workspaces") return workspacesCommand(rest);
  if (sub === "status") return statusCommand(rest);
  if (sub === "version") return versionCommand(rest);
  for (const kind of Object.keys(KINDS) as Kind[]) {
    if (sub === KINDS[kind].plural) return listCommand(kind, rest);
    if (sub === kind) {
      const [target, ...more] = rest;
      if (!target) throw usageError(`gtm ${kind} needs a name, ID, or create|update|delete`, [`${BIN} gtm ${KINDS[kind].plural}  # find one`, `${BIN} gtm ${kind} --help`]);
      if (target === "create" || target === "update" || target === "delete") return writeCommand(kind, target, more);
      return detailCommand(kind, target, more);
    }
  }
  throw usageError(`Unknown gtm subcommand "${sub}"`, [
    "Valid: use, accounts, containers, workspaces, tags, triggers, variables, tag, trigger, variable, status, version",
    `Run \`${BIN} gtm --help\``,
  ]);
}
