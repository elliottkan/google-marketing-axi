import { usageError } from "./usage.js";

export interface ParsedFlags {
  positionals: string[];
  values: Record<string, string[]>;
  booleans: Set<string>;
}

export interface FlagSpec {
  /** Flags that take a value, e.g. `--property 123`. Repeatable. */
  value?: string[];
  /** Flags that stand alone, e.g. `--full`. */
  boolean?: string[];
  /** Short alias -> long name, e.g. `{ n: "limit" }`. */
  alias?: Record<string, string>;
}

/**
 * Strict parser: an unknown flag is an error rather than a silently ignored
 * argument, and a value flag with nothing after it is an error rather than an
 * empty string (AXI principle 6).
 */
export function parseFlags(args: string[], spec: FlagSpec): ParsedFlags {
  const valueFlags = new Set(spec.value ?? []);
  const booleanFlags = new Set(spec.boolean ?? []);
  const aliases = spec.alias ?? {};
  const parsed: ParsedFlags = { positionals: [], values: {}, booleans: new Set() };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--") {
      parsed.positionals.push(...args.slice(i + 1));
      break;
    }
    if (!arg.startsWith("-") || arg === "-") {
      parsed.positionals.push(arg);
      continue;
    }

    const equals = arg.indexOf("=");
    const raw = equals >= 0 ? arg.slice(0, equals) : arg;
    const inline = equals >= 0 ? arg.slice(equals + 1) : undefined;
    const name = aliases[raw.replace(/^--?/, "")] ?? raw.replace(/^--?/, "");

    if (booleanFlags.has(name)) {
      if (inline !== undefined) throw usageError(`${raw} does not take a value`);
      parsed.booleans.add(name);
      continue;
    }
    if (valueFlags.has(name)) {
      const value = inline ?? args[++i];
      if (value === undefined || value === "") {
        throw usageError(`${raw} requires a value`, [`Pass a value: ${raw} <value>`]);
      }
      (parsed.values[name] ??= []).push(value);
      continue;
    }
    throw usageError(`Unknown flag ${raw}`, [
      `Valid flags: ${[...valueFlags, ...booleanFlags].map((f) => `--${f}`).join(", ") || "none"}`,
    ]);
  }
  return parsed;
}

export function one(parsed: ParsedFlags, name: string): string | undefined {
  return parsed.values[name]?.at(-1);
}

export function positiveInt(parsed: ParsedFlags, name: string): number | undefined {
  const raw = one(parsed, name);
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw usageError(`--${name} must be a positive integer, got "${raw}"`);
  }
  return value;
}

export function many(parsed: ParsedFlags, name: string): string[] | undefined {
  return parsed.values[name];
}

/** Comma-separated list flag, e.g. `--metrics sessions,activeUsers`. Repeats are concatenated. */
export function list(parsed: ParsedFlags, name: string): string[] {
  return (parsed.values[name] ?? []).flatMap((v) => v.split(",")).map((v) => v.trim()).filter(Boolean);
}
