import { describe, expect, test } from "bun:test";
import { parseCim, parsePs, posixTable, snapshot, win32Table } from "../src/process.ts";
import type { ProcessRow } from "../src/process.ts";

describe("parsePs", () => {
	test("reads pid, ppid and the full command", () => {
		const rows = parsePs(" 100 1 npm exec chrome-devtools-mcp\n 101   100 node build/index.js\n");
		expect(rows).toEqual<ProcessRow[]>([
			{ pid: 100, ppid: 1, command: "npm exec chrome-devtools-mcp" },
			{ pid: 101, ppid: 100, command: "node build/index.js" },
		]);
	});

	test("ignores a header and blank lines", () => {
		expect(parsePs("  PID  PPID COMMAND\n\n")).toEqual([]);
	});
});

describe("parseCim", () => {
	// Shapes captured from Windows 11, with the command lines trimmed to the parts that matter.
	const captured = [
		{
			ProcessId: 17072,
			ParentProcessId: 8680,
			Name: "cmd.exe",
			CommandLine: '"C:\\WINDOWS\\system32\\cmd.exe" /c npx -y http-server -p 8099',
			Created: 1760000000000,
		},
		{
			ProcessId: 25820,
			ParentProcessId: 17072,
			Name: "node.exe",
			CommandLine:
				'"C:\\nvm4w\\nodejs\\node.exe" "C:\\nvm4w\\nodejs\\node_modules\\npm\\bin\\npx-cli.js" -y http-server -p 8099',
			Created: 1760000000100,
		},
	];

	test("reads the projection the enumeration script emits", () => {
		expect(parseCim(JSON.stringify(captured))).toEqual<ProcessRow[]>([
			{
				pid: 17072,
				ppid: 8680,
				command: captured[0]!.CommandLine,
				name: "cmd.exe",
				created: 1760000000000,
			},
			{
				pid: 25820,
				ppid: 17072,
				command: captured[1]!.CommandLine,
				name: "node.exe",
				created: 1760000000100,
			},
		]);
	});

	test("accepts the single object ConvertTo-Json emits for one row", () => {
		const json = JSON.stringify({ ProcessId: 5, ParentProcessId: 1, Name: "x.exe", CommandLine: "x.exe" });
		expect(parseCim(json)).toEqual<ProcessRow[]>([{ pid: 5, ppid: 1, command: "x.exe", name: "x.exe" }]);
	});

	test("keeps a row whose command line is not reported", () => {
		// The pid has to stay in the table, or a live parent would look like a dead one.
		const json = JSON.stringify({ ProcessId: 4, ParentProcessId: 0, Name: "System", CommandLine: null });
		expect(parseCim(json)).toEqual<ProcessRow[]>([{ pid: 4, ppid: 0, command: "", name: "System" }]);
	});

	test("drops rows without a pid", () => {
		expect(parseCim(JSON.stringify([{ ParentProcessId: 1 }, null, 7]))).toEqual([]);
	});

	test("survives a byte-order mark", () => {
		expect(parseCim(`\uFEFF${JSON.stringify(captured)}`).length).toBe(2);
	});
});

describe("orphan rules", () => {
	const launcher: ProcessRow = { pid: 5, ppid: 1, command: "opencode serve --service", created: 50 };
	const launched: ProcessRow = { pid: 10, ppid: 5, command: "npm exec a-mcp", created: 100 };
	const init: ProcessRow = { pid: 1, ppid: 0, command: "/sbin/launchd" };

	test("POSIX: a chain whose parent is init, or absent, lost its launcher", () => {
		const table = posixTable([]);
		expect(table.isOrphanParent(undefined, launched)).toBe(true);
		expect(table.isOrphanParent(init, launched)).toBe(true);
		expect(table.isOrphanParent(launcher, launched)).toBe(false);
	});

	test("Windows: a parent pid that is absent from the table lost its launcher", () => {
		const table = win32Table([]);
		expect(table.isOrphanParent(undefined, launched)).toBe(true);
		expect(table.isOrphanParent(launcher, launched)).toBe(false);
	});

	test("Windows: pid 0 and a reused pid are both orphans", () => {
		const table = win32Table([]);
		expect(table.isOrphanParent(undefined, { ...launched, ppid: 0 })).toBe(true);
		// The pid now belongs to a process that started after the child did.
		expect(table.isOrphanParent({ ...launcher, created: 200 }, launched)).toBe(true);
	});

	test("POSIX does not read a live parent as reused", () => {
		expect(posixTable([]).isOrphanParent({ ...launcher, created: 200 }, launched)).toBe(false);
	});
});

describe("snapshot", () => {
	test("reads this machine's process table", () => {
		const result = snapshot();
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.table.rows.length).toBeGreaterThan(10);
			expect(result.table.rows.some((row) => row.pid === process.pid)).toBe(true);
		}
	});
});
