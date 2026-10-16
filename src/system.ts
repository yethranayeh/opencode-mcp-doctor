/* Diagnostics and the identity of the running OpenCode service. */

import { appendFileSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Opt-in trace, because a plugin runs silently inside the host process.
 * Set `MCP_DOCTOR_DEBUG` to a file path to append one JSON line per decision.
 */
export function trace(entry: Record<string, unknown>): void {
	const path = process.env.MCP_DOCTOR_DEBUG;
	if (!path) {
		return;
	}
	try {
		appendFileSync(path, `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`);
	} catch {
		/* diagnostics must never break the host */
	}
}

/** pid of the shared background service, when one is registered. */
export function registeredServicePid(): number | null {
	const root = process.env.XDG_STATE_HOME ?? join(homedir(), ".local", "state");
	try {
		const text = readFileSync(join(root, "opencode", "service.json"), "utf8");
		const value: unknown = JSON.parse(text);
		if (typeof value === "object" && value !== null && "pid" in value) {
			const pid = (value as { pid?: unknown }).pid;
			return typeof pid === "number" ? pid : null;
		}
	} catch {
		/* no running service */
	}
	return null;
}

/**
 * The process whose own chains should be treated as expected.
 *
 * A plugin runs inside the server that loaded it, so its own pid is the right
 * answer there, including for a private (`--standalone`) server that is not the
 * registered one. The CLI has to ask the service registry instead.
 */
export function selfPid(): number {
	return registeredServicePid() ?? process.pid;
}
