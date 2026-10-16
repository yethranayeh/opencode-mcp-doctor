/* OpenCode plugin entry point.
 *
 * On the first tool call that belongs to a local MCP server in a session, it looks for
 * other instances of that server: leftovers whose launcher exited, and live ones owned
 * by another host. It reports them once per session, and never kills anything.
 */

import { join } from "node:path";
import { Plugin } from "@opencode/plugin";
import { globalConfigPaths, readTargets } from "./config.ts";
import { findInstances, type Instance, type ServerTarget } from "./detect.ts";
import { snapshot } from "./process.ts";
import { conflictNote, reclaimCommand } from "./report.ts";
import { trace } from "./system.ts";

export default Plugin.define({
	id: "mcp-doctor",
	async setup(ctx) {
		const directory = String(ctx.location.directory);
		const targets = readTargets([
			...globalConfigPaths(),
			join(directory, "opencode.jsonc"),
			join(directory, "opencode.json"),
			join(directory, ".opencode", "opencode.jsonc"),
			join(directory, ".opencode", "opencode.json"),
		]);
		trace({ step: "setup", self: process.pid, directory, targets: targets.map((target) => target.name) });

		const self = process.pid;
		const checked = new Set<string>();

		await ctx.tool.hook("execute.before", async (event) => {
			if (checked.has(event.sessionID)) {
				return;
			}
			const target = targets.find((candidate) => event.tool.startsWith(`${normalize(candidate.name)}_`));
			if (!target) {
				return;
			}
			checked.add(event.sessionID);
			try {
				const result = snapshot();
				if (!result.ok) {
					trace({ step: "snapshot-failed", reason: result.reason });
					await ctx.session.synthetic({
						sessionID: event.sessionID,
						text: `mcp-doctor: could not read the process table (${result.reason}), so the leftover check did not run.`,
					});
					return;
				}

				const others = findInstances([target], result.table, self).filter(
					(instance) => instance.owner !== "self",
				);
				trace({ step: "scan", tool: event.tool, others: others.map((instance) => instance.rootPid) });
				if (others.length === 0) {
					return;
				}

				const text = message(target, others);
				await ctx.session.synthetic({ sessionID: event.sessionID, text });
				trace({ step: "notified", text });
			} catch (error) {
				trace({ step: "failed", error: error instanceof Error ? error.message : String(error) });
			}
		});
	},
});

/** Server names become tool name prefixes with the same normalization OpenCode applies. */
function normalize(name: string): string {
	return name.replace(/[^A-Za-z0-9_-]/g, "_");
}

function message(target: ServerTarget, others: readonly Instance[]): string {
	const parts = [
		`mcp-doctor: ${others.length} other ${target.name} instance(s) are running before you use it in this session.`,
	];
	for (const instance of others) {
		const pids = instance.pids.join(",");
		parts.push(
			instance.owner === "orphan"
				? `  orphaned: pids ${pids} (their launcher exited; reclaim with \`${reclaimCommand(instance)}\`)`
				: `  in use:   pids ${pids} (owned by ${instance.ownerName} pid ${instance.ownerPid})`,
		);
	}
	const note = conflictNote(others);
	if (note) {
		parts.push(`  ${note}`);
	}
	return parts.join("\n");
}
