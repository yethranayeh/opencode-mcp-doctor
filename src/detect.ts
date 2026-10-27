/* Core detection: which MCP server processes are running, and who owns them.
 *
 * The unit of interest is a "launch chain": the top-level launcher (npx, bunx, node)
 * plus every descendant that still carries the server package in its command line.
 * The process that launched that chain decides what it is for us:
 *
 *   - no launcher left (see the table's orphan rule)   -> orphan, safe to reclaim
 *   - a live host (OpenCode, Claude, an IDE)           -> in use by that host
 */

import type { ProcessRow, ProcessTable } from "./process.ts";

export interface ServerTarget {
	/** Server name, as written in configuration. */
	name: string;
	/** Launch command from configuration. */
	command: string[];
}

export type OwnerKind = "self" | "opencode" | "app" | "orphan";

export interface Instance {
	server: string;
	/** Package name the chain was matched on. */
	key: string;
	/** Topmost process of the chain; the one that was launched. */
	rootPid: number;
	/** Chain pids, parents before children, so reversing them ends children first. */
	pids: number[];
	owner: OwnerKind;
	ownerPid: number | null;
	ownerName: string;
}

/** Hosts we name explicitly instead of showing as a bare executable. */
const HOST_NAMES: Array<[RegExp, string]> = [
	[/^opencode(-cli)?$/, "opencode"],
	[/^claude$/, "claude"],
	[/^codex$/, "codex"],
];

/** Executables that take a package to run, so their first positional argument names the server. */
const RUNNERS = new Set(["npx", "npm", "pnpm", "yarn", "bun", "bunx", "dlx", "deno", "uv", "uvx", "pipx"]);

/**
 * The searchable name of an MCP server command: its package argument when it has
 * one, otherwise the executable. `npx -y chrome-devtools-mcp@latest` -> `chrome-devtools-mcp`.
 */
export function packageKey(command: readonly string[]): string | null {
	const executable = commandName(command[0] ?? "");
	if (!executable) {
		return null;
	}
	const positionals = command.slice(1).filter((arg) => !arg.startsWith("-"));
	const runner = RUNNERS.has(commandStem(command[0] ?? ""));
	for (let i = positionals.length - 1; i >= 0; i--) {
		const arg = positionals[i]!;
		if (!/[A-Za-z]/.test(arg)) {
			continue;
		}
		if (runner || arg.includes("/") || arg.includes("-") || arg.includes(".") || arg.startsWith("@")) {
			return stripVersion(arg);
		}
	}
	return stripVersion(executable);
}

/**
 * Executable name from a command line or a configured command argument. Handles a leading quoted
 * path, as Windows command lines use, and both path separators.
 */
export function commandName(value: string): string {
	const trimmed = value.trim();
	let token = trimmed.split(" ")[0] ?? trimmed;
	if (trimmed.startsWith('"')) {
		const end = trimmed.indexOf('"', 1);
		if (end > 1) {
			token = trimmed.slice(1, end);
		}
	}
	return token.split(/[\\/]/).pop() ?? token;
}

/** The same name folded for comparison: lowercase, without a Windows executable suffix. */
export function commandStem(value: string): string {
	return commandName(value)
		.toLowerCase()
		.replace(/\.(exe|cmd|bat|com)$/, "");
}

/** Drops a trailing `@version`, leaving scoped names such as `@scope/name` and paths intact. */
function stripVersion(spec: string): string {
	const at = spec.lastIndexOf("@");
	if (at <= 0) {
		return spec;
	}
	const version = spec.slice(at + 1);
	if (version.includes("/")) {
		return spec;
	}
	return spec.slice(0, at);
}

/**
 * Groups matched processes into launch chains and classifies each chain.
 * `selfPid` is the process the caller runs in, so it can recognise its own chains.
 */
export function findInstances(
	targets: readonly ServerTarget[],
	table: ProcessTable,
	selfPid: number,
): Instance[] {
	const rows = table.rows;
	const byPid = new Map<number, ProcessRow>();
	const children = new Map<number, ProcessRow[]>();
	for (const row of rows) {
		byPid.set(row.pid, row);
		const siblings = children.get(row.ppid);
		if (siblings) {
			siblings.push(row);
		} else {
			children.set(row.ppid, [row]);
		}
	}

	const matches = (row: ProcessRow, key: string) => {
		if (table.foldCase) {
			return row.command.toLowerCase().includes(key.toLowerCase());
		}
		return row.command.includes(key);
	};

	const instances: Instance[] = [];
	const seen = new Set<number>();

	for (const target of targets) {
		const key = packageKey(target.command);
		if (!key) {
			continue;
		}

		// Every matched process belongs to the chain of its topmost matching ancestor.
		const tops = new Map<number, ProcessRow>();
		for (const row of rows) {
			if (!matches(row, key)) {
				continue;
			}
			let top = row;
			for (;;) {
				const parent = byPid.get(top.ppid);
				if (!parent || !matches(parent, key)) {
					break;
				}
				top = parent;
			}
			tops.set(top.pid, top);
		}

		for (const top of tops.values()) {
			if (seen.has(top.pid)) {
				continue;
			}
			seen.add(top.pid);

			const pids = [top.pid];
			const queue = [top.pid];
			while (queue.length > 0) {
				const pid = queue.pop()!;
				for (const child of children.get(pid) ?? []) {
					if (matches(child, key)) {
						pids.push(child.pid);
						queue.push(child.pid);
					}
				}
			}

			const host = byPid.get(top.ppid);
			instances.push({
				server: target.name,
				key,
				rootPid: top.pid,
				pids,
				...classify(host, top, selfPid, table.isOrphanParent),
			});
		}
	}

	return instances.sort((a, b) => a.server.localeCompare(b.server) || a.rootPid - b.rootPid);
}

function classify(
	host: ProcessRow | undefined,
	child: ProcessRow,
	selfPid: number,
	isOrphanParent: (parent: ProcessRow | undefined, child: ProcessRow) => boolean,
): Pick<Instance, "owner" | "ownerPid" | "ownerName"> {
	if (!host || isOrphanParent(host, child)) {
		return { owner: "orphan", ownerPid: null, ownerName: "no parent" };
	}
	if (host.pid === selfPid) {
		return { owner: "self", ownerPid: host.pid, ownerName: "opencode" };
	}

	const name = commandStem(host.name ?? host.command) || "unknown";
	for (const [pattern, label] of HOST_NAMES) {
		if (pattern.test(name)) {
			return { owner: label === "opencode" ? "opencode" : "app", ownerPid: host.pid, ownerName: label };
		}
	}
	return { owner: "app", ownerPid: host.pid, ownerName: name };
}

/**
 * Instances that compete for a server's resources: every live chain, including one owned by the
 * caller's own host. Orphans are left out, because they are reported for reclaiming instead.
 */
export function conflicts(instances: readonly Instance[]): Instance[] {
	return instances.filter((instance) => instance.owner !== "orphan");
}

export function orphans(instances: readonly Instance[]): Instance[] {
	return instances.filter((instance) => instance.owner === "orphan");
}
