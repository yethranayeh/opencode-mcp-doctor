import { describe, expect, test } from "bun:test";
import type { Instance } from "../src/detect.ts";
import { formatReport, reclaimCommand, toJson } from "../src/report.ts";

/** A chain listed parents-first, as detection returns it. */
const orphan: Instance = {
	server: "chrome-devtools",
	key: "chrome-devtools-mcp",
	rootPid: 100,
	pids: [100, 101, 102],
	owner: "orphan",
	ownerPid: null,
	ownerName: "no parent",
};

const inUse: Instance = { ...orphan, owner: "app", ownerPid: 42, ownerName: "claude" };

describe("reclaimCommand", () => {
	test("lists POSIX pids children first", () => {
		expect(reclaimCommand(orphan, "darwin")).toBe("kill 102 101 100");
		expect(reclaimCommand(orphan, "linux")).toBe("kill 102 101 100");
	});

	test("terminates the whole tree on Windows", () => {
		expect(reclaimCommand(orphan, "win32")).toBe("taskkill /PID 100 /T /F");
	});
});

describe("formatReport", () => {
	test("names the server, its chain and its owner", () => {
		const text = formatReport([inUse]);
		expect(text).toContain("chrome-devtools (chrome-devtools-mcp)");
		expect(text).toContain("claude pid 42");
		expect(text).toContain("pids 100,101,102");
	});

	test("offers a reclaim command for an orphaned chain only", () => {
		expect(formatReport([orphan])).toContain("kill 102 101 100");
		expect(formatReport([inUse])).not.toContain("kill 102 101 100");
	});
});

describe("toJson", () => {
	test("lists pids in ascending order", () => {
		const parsed = JSON.parse(toJson([{ ...orphan, pids: [100, 102, 101] }]));
		expect(parsed[0].pids).toEqual([100, 101, 102]);
		expect(parsed[0].owner).toBe("orphan");
	});
});
