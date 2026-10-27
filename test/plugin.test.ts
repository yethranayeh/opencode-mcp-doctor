import { afterAll, expect, test } from "bun:test";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import plugin from "../src/plugin.ts";
import { snapshotAsync } from "../src/process.ts";

/*
 * The plugin is the one piece the suite could not reach: it is loaded by the host, not imported
 * by anything we run. These tests drive its setup() with a fake context and, rather than mocking
 * the process table, spawn real chains whose command lines carry a unique package key. That keeps
 * the wiring end-to-end: configuration -> target match -> enumeration -> notice -> session note.
 */

const KEY = `mcp-doctor-fixture-${process.pid}-${Date.now()}`;
const children: ChildProcess[] = [];
const savedConfig = process.env.XDG_CONFIG_HOME;
const savedState = process.env.XDG_STATE_HOME;

afterAll(() => {
	for (const child of children) {
		child.kill();
	}
	if (savedConfig === undefined) {
		delete process.env.XDG_CONFIG_HOME;
	} else {
		process.env.XDG_CONFIG_HOME = savedConfig;
	}
	if (savedState === undefined) {
		delete process.env.XDG_STATE_HOME;
	} else {
		process.env.XDG_STATE_HOME = savedState;
	}
});

/** A project whose only server runs the fixture key, so the plugin has a target to match. */
function fixtureProject(): string {
	const directory = mkdtempSync(join(tmpdir(), "mcp-doctor-plugin-"));
	writeFileSync(
		join(directory, "opencode.json"),
		JSON.stringify({
			mcp: {
				servers: {
					fixture: { type: "local", command: [process.execPath, "-e", "setTimeout(() => {}, 30000)", KEY] },
				},
			},
		}),
	);
	return directory;
}

/** Waits until the real table shows `count` fixture chains, so the scan cannot race the spawn. */
async function waitForChains(count: number): Promise<void> {
	const deadline = Date.now() + 20_000;
	for (;;) {
		const result = await snapshotAsync();
		const seen = result.ok ? result.table.rows.filter((row) => row.command.includes(KEY)).length : 0;
		if (seen >= count) {
			return;
		}
		if (Date.now() > deadline) {
			throw new Error(`saw ${seen} of ${count} fixture chains in the process table`);
		}
		await Bun.sleep(100);
	}
}

/** The part of the plugin context this plugin actually uses: directory, tool hook and session note. */
function fakeContext(directory: string) {
	const notes: string[] = [];
	let handler: ((event: { sessionID: string; tool: string }) => Promise<void>) | undefined;
	const context = {
		location: { directory: { toString: () => directory } },
		tool: {
			hook: (_name: string, callback: typeof handler) => {
				handler = callback;
				return () => {};
			},
		},
		session: {
			synthetic: async ({ text }: { sessionID: string; text: string }) => {
				notes.push(text);
			},
		},
	};
	return { context, notes, handler: () => handler };
}

test("notes several chains the same host launched, once per session", async () => {
	const project = fixtureProject();
	// The config only reaches the plugin through these directories, never the real user config.
	process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), "mcp-doctor-config-"));
	process.env.XDG_STATE_HOME = mkdtempSync(join(tmpdir(), "mcp-doctor-state-"));

	for (let i = 0; i < 2; i++) {
		children.push(
			spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)", KEY], { stdio: "ignore" }),
		);
	}
	await waitForChains(2);

	const { context, notes, handler } = fakeContext(project);
	await plugin.setup(context as never);

	const before = handler();
	expect(typeof before).toBe("function");
	await before!({ sessionID: "session-a", tool: "fixture_click" });
	await before!({ sessionID: "session-a", tool: "fixture_click" });
	await before!({ sessionID: "session-b", tool: "fixture_click" });
	await before!({ sessionID: "session-c", tool: "unrelated_tool" });

	// Once per session, and only for tools this server owns: two notes out of four calls.
	expect(notes.length).toBe(2);
	expect(notes[0]).toContain("2 fixture instances are already running");
	expect(notes[0]).toContain("This host (opencode) owns 2 of them.");
});
