/* Reads local MCP server commands from OpenCode configuration. */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ServerTarget } from "./detect.ts";

/** Global configuration files, in the order OpenCode prefers them. */
export function globalConfigPaths(): string[] {
  const root = process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config");
  return [join(root, "opencode", "opencode.jsonc"), join(root, "opencode", "opencode.json")];
}

export function readTargets(paths: readonly string[] = globalConfigPaths()): ServerTarget[] {
  const targets = new Map<string, ServerTarget>();
  for (const path of paths) {
    for (const target of targetsFromFile(path)) {
      targets.set(target.name, target);
    }
  }

  return [...targets.values()];
}

export function targetsFromFile(path: string): ServerTarget[] {
  let text: string;

  try {
    text = readFileSync(path, "utf8");
  } catch {
    return [];
  }

  let config: unknown;
  try {
    config = JSON.parse(text);
  } catch {
    config = parseJsonc(text);
  }

  return targetsFromConfig(config);
}

export function targetsFromConfig(config: unknown): ServerTarget[] {
  if (!isRecord(config) || !isRecord(config.mcp)) {
    return [];
  }

  // V2 keeps servers under `mcp.servers`; older files put them directly under `mcp`.
  const servers = isRecord(config.mcp.servers) ? config.mcp.servers : config.mcp;
  const targets: ServerTarget[] = [];

  for (const [name, value] of Object.entries(servers)) {
    if (name === "servers" || !isRecord(value)) {
      continue;
    }
    // `disabled` is the current field; older configuration files use `enabled: false`.
		if (value.type !== "local" || value.disabled === true || value.enabled === false) {
      continue;
    }

    const command = value.command;
    if (
      Array.isArray(command) &&
      command.every((part) => typeof part === "string") &&
      command.length > 0
    ) {
      targets.push({ name, command });
    }
  }
  return targets;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Minimal JSONC support for config files that use comments or trailing commas.
 * String-aware, so `//` inside a value such as a URL survives.
 */
function parseJsonc(text: string): unknown {
  let out = "";
  let inString = false;
  let escaped = false;

  for (let i = 0; i < text.length; i++) {
    const char = text[i]!;
    if (inString) {
      out += char;
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
      out += char;
      continue;
    }

    if (char === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") {
        i++;
      }
      out += "\n";
      continue;
    }

    if (char === "/" && text[i + 1] === "*") {
      i += 2;
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) {
        i++;
      }
      i++;
      continue;
    }

    out += char;
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, "$1"));
}
