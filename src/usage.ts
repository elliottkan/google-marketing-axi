import { AxiError } from "axi-sdk-js";

/**
 * Usage errors - a bad flag, a missing argument, an unknown subcommand - must
 * exit 2, which the SDK keys off the `VALIDATION_ERROR` code. Everything else
 * (an unreachable server, a failed API call, missing credentials) exits 1.
 */
export function usageError(message: string, suggestions: string[] = []): AxiError {
  return new AxiError(message, "VALIDATION_ERROR", suggestions);
}

/** Rejects leftover arguments on commands that take none. */
export function expectNoArgs(command: string, args: string[]): void {
  if (args.length > 0) {
    throw usageError(`${command} takes no arguments, got "${args.join(" ")}"`, [`Run \`google-marketing-axi ${command}\``]);
  }
}
