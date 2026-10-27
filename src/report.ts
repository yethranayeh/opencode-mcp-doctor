/* Formats scan results for the CLI and for the plugin message. */

import { conflicts, orphans, type Instance } from "./detect.ts";

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
 * Exit code for a scan. Precedence: an orphan is actionable, so it wins over competition; otherwise
 * `strict` turns competing live chains into a failure. A table that could not be read is decided
 * before this runs, so 3 never appears here.
 */
export function exitStatus(instances: readonly Instance[], strict: boolean): number {
	if (orphans(instances).length > 0) {
		return 1;
	}
	if (strict && competingChains(instances) !== null) {
		return 4;
	}
	return 0;
}

/**
 * Session note for a server the caller is about to use: leftover chains it can reclaim, and live
 * chains that compete with the new one.
 *
 * Competition is counted with `conflicts()`, which includes chains this host launched. A single
 * host can spawn several copies of one server, and those copies contend exactly like chains from
 * different hosts, so they are reported too. A lone chain owned by the caller's own host is the
 * expected case and stays silent. Null means there is nothing worth saying.
 */
export function notice(
	target: { name: string },
	instances: readonly Instance[],
	platform: string = process.platform,
): string | null {
	if (instances.length === 0) {
		return null;
	}

	const live = conflicts(instances);
	const orphaned = orphans(instances);
	if (orphaned.length === 0 && live.length === 1 && live[0]!.owner === "self") {
		return null;
	}

	const own = live.filter((instance) => instance.owner === "self");
	const count = instances.length;
	const parts = [
		`mcp-doctor: ${count} ${target.name} instance${count === 1 ? "" : "s"} ${count === 1 ? "is" : "are"} already running before you use it in this session.`,
	];
	if (own.length > 0) {
		const host = own[0]!.ownerName;
		parts[0] += ` This host (${host}) owns ${own.length} of them.`;
	}

	for (const instance of instances) {
		const pids = instance.pids.join(",");
		parts.push(
			instance.owner === "orphan"
				? `  orphaned: pids ${pids} (their launcher exited; reclaim with \`${reclaimCommand(instance, platform)}\`)`
				: `  in use:   pids ${pids} (owned by ${instance.ownerName} pid ${instance.ownerPid})`,
		);
	}

	const note = conflictNote(instances);
	if (note) {
		parts.push(`  ${note}`);
	}
	return parts.join("\n");
}

/**
 * The live chains of one server that compete with each other, or null when no server has two.
 * Competition is per server: two different servers each running one chain do not contend, even
 * though both are live. The busiest server wins, so the note names the case worth acting on.
 */
function competingChains(instances: readonly Instance[]): Instance[] | null {
	const groups = new Map<string, Instance[]>();
	for (const instance of conflicts(instances)) {
		const group = groups.get(instance.key);
		if (group) {
			group.push(instance);
		} else {
			groups.set(instance.key, [instance]);
		}
	}

	let worst: Instance[] | null = null;
	for (const group of groups.values()) {
		if (group.length > 1 && (!worst || group.length > worst.length)) {
			worst = group;
		}
	}
	return worst;
}

/**
 * Short note for a server with more than one live chain, naming the remedy for the common case.
 * Chains are counted with `conflicts()`, so the note and detection agree on what competes.
 */
export function conflictNote(instances: readonly Instance[]): string | null {
	const live = competingChains(instances);
	if (!live) {
		return null;
	}
	const names = [...new Set(live.map((instance) => instance.ownerName))].join(", ");
	const note =
		`${live.length} live instances of ${live[0]?.server} are running (${names}). ` +
		`A new instance may fail to start while they hold the same resources.`;
	if (live[0]?.key.includes("chrome-devtools")) {
		return `${note} chrome-devtools-mcp shares one Chrome profile by default, so a second instance usually fails with "browser is already running".`;
	}
	return note;
}
