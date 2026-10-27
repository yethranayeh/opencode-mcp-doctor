import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const cli = join(import.meta.dir, "..", "bin", "mcp-doctor.ts");

function run(args: string[], env: Record<string, string | undefined> = process.env) {
	return spawnSync(process.execPath, [cli, ...args], { encoding: "utf8", env });
}

/** A config whose only server cannot be running, so the scan finds a clean machine. */
function configWithAbsentServer(): string {
	const path = join(mkdtempSync(join(tmpdir(), "mcp-doctor-config-")), "opencode.json");
	writeFileSync(
		path,
		JSON.stringify({
			mcp: {
				servers: {
					"nothing-here": { type: "local", command: ["mcp-doctor-nothing-here"] },
				},
			},
		}),
	);
	return path;
}

describe("mcp-doctor", () => {
	test("prints help and succeeds", () => {
		const result = run(["--help"]);
		expect(result.status).toBe(0);
		expect(result.stdout.length).toBeGreaterThan(0);
		expect(result.stdout).toContain("--strict");
	});

	test("rejects an unknown argument", () => {
		expect(run(["--nope"]).status).toBe(2);
	});

	test("accepts --strict without failing a clean run", () => {
		const result = run(["--strict", "--config", configWithAbsentServer()]);
		expect(result.status).toBe(0);
	});

	test("accepts --strict alongside --quiet and --json", () => {
		const result = run(["--strict", "--quiet", "--json", "--config", configWithAbsentServer()]);
		expect(result.status).toBe(0);
		expect(result.stdout).toBe("");
	});

	// Windows resolves some executables outside PATH, so this failure is only forced on POSIX.
	test.skipIf(process.platform === "win32")(
		"reports an unreadable process table instead of a clean machine",
		() => {
			// An existing but empty directory: an empty PATH value falls back to a default search path.
			const empty = mkdtempSync(join(tmpdir(), "mcp-doctor-empty-"));
			const result = run([], { ...process.env, PATH: empty });
			expect(result.status).toBe(3);
			expect(result.stdout).toBe("");
			expect(result.stderr.length).toBeGreaterThan(0);
		},
	);
});
