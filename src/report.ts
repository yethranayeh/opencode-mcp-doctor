/* Formats scan results for the CLI and for the plugin message. */

import type { Instance } from "./detect.ts";

export function toJson(instances: readonly Instance[]): string {
  return JSON.stringify(
    instances.map((instance) => ({
      server: instance.server,
      key: instance.key,
      pids: instance.pids,
      owner: instance.owner,
      ownerPid: instance.ownerPid,
      ownerName: instance.ownerName,
    })),
    null,
    2,
  );
}

/** One line per chain, grouped by server. Empty when nothing is running. */
export function formatReport(instances: readonly Instance[]): string {
  if (instances.length === 0) {
    return "No local MCP server processes found.";
  }

  const lines: string[] = [];
  let server = "";
  for (const instance of instances) {
    if (instance.server !== server) {
      server = instance.server;
      lines.push(`${server} (${instance.key})`);
    }
    lines.push(`  ${label(instance)}  pids ${instance.pids.join(",")}`);
  }
  return lines.join("\n");
}

function label(instance: Instance): string {
  if (instance.owner === "orphan") {
    return "orphaned  (launcher gone)";
  }
  return `in use    (${instance.ownerName} pid ${instance.ownerPid})`;
}

/** Short note for a server with more than one live process, naming the remedy for the common case. */
export function conflictNote(instances: readonly Instance[]): string | null {
  const live = instances.filter((instance) => instance.owner !== "orphan");
  if (live.length < 2) {
    return null;
  }
  const names = [...new Set(live.map((instance) => instance.ownerName))].join(", ");
  const note =
    `${live.length} live instances of ${instances[0]?.server} are running (${names}). ` +
    `A new instance may fail to start while they hold the same resources.`;
  if (instances[0]?.key.includes("chrome-devtools")) {
    return `${note} chrome-devtools-mcp shares one Chrome profile, so a second instance usually fails with "browser is already running".`;
  }
  return note;
}
