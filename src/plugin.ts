/* OpenCode plugin entry point.
 *
 * On the first tool call that belongs to a local MCP server in a session, it looks for
 * other instances of that server: leftovers whose launcher exited, and live chains that
 * compete with the new one, including several chains launched by this same host. It
 * reports them once per session, and never kills anything.
 */

import { join } from "node:path";
import { Plugin } from "@opencode/plugin";
import { globalConfigPaths, readTargets } from "./config.ts";
import { findInstances } from "./detect.ts";
import { snapshot } from "./process.ts";
import { notice } from "./report.ts";
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

				const instances = findInstances([target], result.table, self);
				trace({ step: "scan", tool: event.tool, others: instances.map((instance) => instance.rootPid) });
				const text = notice(target, instances);
				if (!text) {
					return;
				}

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
