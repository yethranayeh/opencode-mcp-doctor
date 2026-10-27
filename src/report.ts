/* Formats scan results for the CLI and for the plugin message. */

import { conflicts, type Instance } from "./detect.ts";

export function toJson(instances: readonly Instance[]): string {
	return JSON.stringify(
		instances.map((instance) => ({
			server: instance.server,
			key: instance.key,
			pids: listedPids(instance),
			owner: instance.owner,
			ownerPid: instance.ownerPid,
			ownerName: instance.ownerName,
		})),
		null,
		2,
	);
}

/**
 * Command that ends a chain. Windows needs the whole tree, because terminating a process does not
 * terminate its descendants. On macOS and Linux the pids go children-first for the same reason.
 */
export function reclaimCommand(instance: Instance, platform: string = process.platform): string {
	if (platform === "win32") {
		return `taskkill /PID ${instance.rootPid} /T /F`;
	}
	return `kill ${[...instance.pids].reverse().join(" ")}`;
}

/** One line per chain, grouped by server. Empty when nothing is running. */
export function formatReport(
	instances: readonly Instance[],
	platform: string = process.platform,
): string {
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
		lines.push(`  ${label(instance)}  pids ${listedPids(instance).join(",")}`);
		if (instance.owner === "orphan") {
			lines.push(`    reclaim: ${reclaimCommand(instance, platform)}`);
		}
	}
	return lines.join("\n");
}

function label(instance: Instance): string {
	if (instance.owner === "orphan") {
		return "orphaned  (launcher gone)";
	}
	return `in use    (${instance.ownerName} pid ${instance.ownerPid})`;
}

function listedPids(instance: Instance): number[] {
	return [...instance.pids].sort((a, b) => a - b);
}

/**
 * Short note for a server with more than one live chain, naming the remedy for the common case.
 * Chains are counted with `conflicts()`, so the note and detection agree on what competes.
 */
export function conflictNote(instances: readonly Instance[]): string | null {
	const live = conflicts(instances);
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
