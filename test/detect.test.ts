import { describe, expect, test } from "bun:test";
import type { ServerTarget } from "../src/detect.ts";
import { conflicts, findInstances, orphans, packageKey } from "../src/detect.ts";
import { posixTable, win32Table } from "../src/process.ts";
import type { ProcessRow } from "../src/process.ts";

const CHROME: ServerTarget = {
	name: "chrome-devtools",
	command: ["npx", "-y", "chrome-devtools-mcp@latest", "--chrome-arg=--disable-features=MacAppCodeSignClone"],
};

const PLAYWRIGHT: ServerTarget = { name: "playwright", command: ["bunx", "@playwright/mcp"] };

describe("packageKey", () => {
	test("takes the package argument and drops its version", () => {
		expect(packageKey(CHROME.command)).toBe("chrome-devtools-mcp");
	});

	test("keeps a scoped package intact", () => {
		expect(packageKey(PLAYWRIGHT.command)).toBe("@playwright/mcp");
		expect(packageKey(["npx", "-y", "@playwright/mcp@1.2.3"])).toBe("@playwright/mcp");
	});

	test("falls back to the executable", () => {
		expect(packageKey(["/usr/local/bin/my-server", "--port", "1"])).toBe("my-server");
	});

	test("sees through a Windows launcher suffix", () => {
		expect(packageKey(["npx.cmd", "-y", "mcp"])).toBe("mcp");
		expect(packageKey(["C:\\Program Files\\nodejs\\npx.cmd", "-y", "chrome-devtools-mcp@latest"])).toBe(
			"chrome-devtools-mcp",
		);
	});
});

describe("findInstances on macOS and Linux", () => {
	// 200 launcher <- 201 server <- 202 watchdog, launched by OpenCode (10)
	// 300 launcher <- 301 server, launched by Claude (20)
	// 400 launcher <- 401 server, launcher gone
	const ps: ProcessRow[] = [
		{ pid: 1, ppid: 0, command: "/sbin/launchd" },
		{ pid: 10, ppid: 1, command: "/usr/local/bin/opencode" },
		{ pid: 20, ppid: 1, command: "claude" },
		{ pid: 200, ppid: 10, command: "npm exec chrome-devtools-mcp@latest" },
		{ pid: 201, ppid: 200, command: "chrome-devtools-mcp" },
		{ pid: 202, ppid: 201, command: "node .../chrome-devtools-mcp/build/src/telemetry/watchdog/main.js" },
		{ pid: 300, ppid: 20, command: "npm exec chrome-devtools-mcp@latest" },
		{ pid: 301, ppid: 300, command: "chrome-devtools-mcp" },
		{ pid: 400, ppid: 1, command: "npm exec chrome-devtools-mcp@latest" },
		{ pid: 401, ppid: 400, command: "chrome-devtools-mcp" },
	];
	const table = posixTable(ps);

	test("groups each launch chain once, from its topmost process", () => {
		const instances = findInstances([CHROME], table, 999);
		expect(instances.map((instance) => instance.rootPid)).toEqual([200, 300, 400]);
		expect(instances[0]!.pids).toEqual([200, 201, 202]);
	});

	test("names the host that owns the chain", () => {
		const instances = findInstances([CHROME], table, 999);
		expect(instances.map((instance) => instance.owner)).toEqual(["opencode", "app", "orphan"]);
		expect(instances[1]!.ownerName).toBe("claude");
		expect(instances[1]!.ownerPid).toBe(20);
	});

	test("recognises the caller's own chain", () => {
		expect(findInstances([CHROME], table, 10)[0]!.owner).toBe("self");
	});

	test("treats a chain launched by init as orphaned", () => {
		expect(orphans(findInstances([CHROME], table, 999)).map((instance) => instance.rootPid)).toEqual([400]);
	});

	test("reports every live chain as a conflict, including the caller's own", () => {
		const instances = findInstances([CHROME], table, 10);
		expect(conflicts(instances).map((instance) => instance.rootPid)).toEqual([200, 300]);
	});

	test("separates servers by their own package key", () => {
		const instances = findInstances([CHROME, PLAYWRIGHT], table, 999);
		expect(instances.every((instance) => instance.key === "chrome-devtools-mcp")).toBe(true);
	});

	test("finds nothing when no process matches", () => {
		expect(findInstances([PLAYWRIGHT], table, 999)).toEqual([]);
	});
});

describe("findInstances on Windows", () => {
	// One chain under OpenCode's own server, four processes deep, as npx runs on Windows.
	// One whose launcher (9999) is gone, one whose parent pid was reused, one with no parent.
	const windows: ProcessRow[] = [
		{ pid: 4836, ppid: 1, name: "opencode-cli.exe", command: "opencode-cli.exe serve --service", created: 100 },
		{
			pid: 17072,
			ppid: 4836,
			name: "cmd.exe",
			command: '"C:\\WINDOWS\\system32\\cmd.exe" /c npx -y chrome-devtools-mcp@latest',
			created: 200,
		},
		{
			pid: 25820,
			ppid: 17072,
			name: "node.exe",
			command: '"C:\\nvm4w\\nodejs\\node.exe" "C:\\nvm4w\\nodejs\\node_modules\\npm\\bin\\npx-cli.js" -y chrome-devtools-mcp@latest',
			created: 210,
		},
		{
			pid: 21080,
			ppid: 25820,
			name: "cmd.exe",
			command: "C:\\WINDOWS\\system32\\cmd.exe /d /s /c chrome-devtools-mcp",
			created: 220,
		},
		{
			pid: 25544,
			ppid: 21080,
			name: "node.exe",
			command: '"node" "C:\\npm-cache\\_npx\\e5196fa6dc3cecbc\\node_modules\\chrome-devtools-mcp\\bin\\chrome-devtools-mcp"',
			created: 230,
		},
		{
			pid: 30000,
			ppid: 9999,
			name: "cmd.exe",
			command: '"C:\\WINDOWS\\system32\\cmd.exe" /c npx -y chrome-devtools-mcp@latest',
			created: 300,
		},
		{
			pid: 30001,
			ppid: 30000,
			name: "node.exe",
			command: '"node" "C:\\npm-cache\\_npx\\bb\\node_modules\\chrome-devtools-mcp\\bin\\chrome-devtools-mcp"',
			created: 310,
		},
		{
			pid: 8888,
			ppid: 1,
			name: "unrelated.exe",
			command: "unrelated.exe --serve",
			created: 900,
		},
		{
			pid: 31000,
			ppid: 8888,
			name: "cmd.exe",
			command: '"C:\\WINDOWS\\system32\\cmd.exe" /c npx -y chrome-devtools-mcp@latest',
			created: 400,
		},
		{
			pid: 32000,
			ppid: 0,
			name: "cmd.exe",
			command: '"C:\\WINDOWS\\system32\\cmd.exe" /c npx -y chrome-devtools-mcp@latest',
			created: 500,
		},
	];
	const table = win32Table(windows);

	test("groups the four-process chain that npx produces", () => {
		const instances = findInstances([CHROME], table, 7777);
		expect(instances.map((instance) => instance.rootPid)).toEqual([17072, 30000, 31000, 32000]);
		expect(instances[0]!.pids).toEqual([17072, 25820, 21080, 25544]);
	});

	test("names the Windows hosts, case-insensitively", () => {
		const instances = findInstances([CHROME], table, 7777);
		expect(instances[0]!.owner).toBe("opencode");
		expect(instances[0]!.ownerName).toBe("opencode");
		expect(instances[0]!.ownerPid).toBe(4836);
	});

	test("calls a chain orphaned when its launcher is gone, reused or absent", () => {
		const instances = findInstances([CHROME], table, 7777);
		expect(instances.map((instance) => instance.owner)).toEqual(["opencode", "orphan", "orphan", "orphan"]);
	});

	test("recognises the caller's own chain", () => {
		expect(findInstances([CHROME], table, 4836)[0]!.owner).toBe("self");
	});

	test("finds the desktop app as an OpenCode host", () => {
		const rows: ProcessRow[] = [
			{ pid: 10, ppid: 1, name: "OpenCode.exe", command: "OpenCode.exe", created: 1 },
			{
				pid: 11,
				ppid: 10,
				name: "cmd.exe",
				command: '"C:\\WINDOWS\\system32\\cmd.exe" /c npx -y chrome-devtools-mcp@latest',
				created: 2,
			},
		];
		expect(findInstances([CHROME], win32Table(rows), 1)[0]!.ownerName).toBe("opencode");
	});

	test("names an unnamed host by its executable, without quotes", () => {
		const rows: ProcessRow[] = [
			{ pid: 20, ppid: 1, name: "cmd.exe", command: '"C:\\WINDOWS\\system32\\cmd.exe"', created: 1 },
			{
				pid: 21,
				ppid: 20,
				name: "cmd.exe",
				command: '"C:\\WINDOWS\\system32\\cmd.exe" /c npx -y chrome-devtools-mcp@latest',
				created: 2,
			},
		];
		expect(findInstances([CHROME], win32Table(rows), 1)[0]!.ownerName).toBe("cmd");
	});

	test("matches command lines case-insensitively, and only on Windows", () => {
		const rows: ProcessRow[] = [
			{
				pid: 30,
				ppid: 1,
				name: "cmd.exe",
				command: '"C:\\Windows\\System32\\cmd.exe" /c npx -y Chrome-DevTools-MCP@latest',
				created: 1,
			},
		];
		expect(findInstances([CHROME], win32Table(rows), 1).length).toBe(1);
		expect(findInstances([CHROME], posixTable(rows), 1).length).toBe(0);
	});
});
