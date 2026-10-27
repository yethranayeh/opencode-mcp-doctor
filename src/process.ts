/* Process layer: read the platform's process table and say what "the parent is gone" means there.
 *
 * Nothing above this file knows which OS it runs on. A table carries both its rows and the
 * platform's orphan rule, so chain detection stays a pure function of that table. Failing to
 * read the table is reported as such: an unreadable table is not a clean machine.
 */

import { execFile, execFileSync } from "node:child_process";

export interface ProcessRow {
	pid: number;
	ppid: number;
	/** Full command line, or "" when the platform does not report one. */
	command: string;
	/** Executable name, when the platform reports it separately. */
	name?: string;
	/** Start time in epoch milliseconds, when the platform reports it. Used to detect PID reuse. */
	created?: number;
}

export interface ProcessTable {
	rows: ProcessRow[];
	/** Whether command lines match keys case-insensitively, as Windows paths and names do. */
	foldCase: boolean;
	/** True when this table says the child's parent no longer exists. */
	isOrphanParent(parent: ProcessRow | undefined, child: ProcessRow): boolean;
}

export type Snapshot = { ok: true; table: ProcessTable } | { ok: false; reason: string };

/** A real process table is far smaller than this; the limit only exists to fail loudly, not truncate. */
const MAX_OUTPUT_BYTES = 32 * 1024 * 1024;

/**
 * Far above the slowest observed read (the PowerShell CIM query takes a few seconds on Windows),
 * and low enough that a wedged enumeration reports itself instead of hanging the caller forever.
 */
const ENUMERATION_TIMEOUT_MS = 20_000;

/** The same call options for both read paths, so the sync and async reads cannot drift. */
const READ_OPTIONS = {
	encoding: "utf8" as const,
	maxBuffer: MAX_OUTPUT_BYTES,
	// Keep the command's own errors out of the terminal; they are reported as the reason.
	stdio: ["ignore", "pipe", "pipe"] as ["ignore", "pipe", "pipe"],
	windowsHide: true,
	// The plugin awaits this read inside the host, so a hung command must eventually give up.
	timeout: ENUMERATION_TIMEOUT_MS,
};

/**
 * Windows has no `ps` with these semantics. PowerShell's CIM provider gives the parent pid and
 * the command line in one call. CreationDate is converted here, because CIM's date format has no
 * JavaScript equivalent. Output encoding is forced to UTF-8 without a BOM: Windows PowerShell
 * otherwise writes its console output in the OEM codepage, which mangles non-ASCII command lines.
 */
const WINDOWS_ENUMERATION_SCRIPT = `[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false
Get-CimInstance Win32_Process | Select-Object ProcessId, ParentProcessId, Name, CommandLine, @{
  n = 'Created'
  e = {
    if ($_.CreationDate) {
      try {
        [long]([System.Management.ManagementDateTimeConverter]::ToDateTime($_.CreationDate).ToUniversalTime() - [datetime]::new(1970, 1, 1, 0, 0, 0, [System.DateTimeKind]::Utc)).TotalMilliseconds
      } catch { $null }
    }
  }
} | ConvertTo-Json -Compress
`;

/**
 * Everything that differs between platforms: the command that enumerates the table, the parser
 * for its output, and the platform's orphan rule.
 */
interface Enumeration {
	command: string;
	args: readonly string[];
	parse: (output: string) => ProcessRow[];
	toTable: (rows: ProcessRow[]) => ProcessTable;
}

/**
 * The one place that decides how this machine is enumerated.
 * Dispatches on the platform rather than probing for a `ps` binary: Git for Windows ships an
 * MSYS `ps` that appears to work but reports a private PID namespace, which would turn a missing
 * report into a confident wrong one.
 */
function enumeration(): Enumeration {
	if (process.platform === "win32") {
		return {
			command: "powershell.exe",
			args: ["-NoProfile", "-NonInteractive", "-Command", WINDOWS_ENUMERATION_SCRIPT],
			parse: parseCim,
			toTable: win32Table,
		};
	}

	return {
		command: "ps",
		args: ["-Ao", "pid=,ppid=,command="],
		parse: parsePs,
		toTable: posixTable,
	};
}

/**
 * Reads the process table of the machine this runs on, or says why it could not, blocking until
 * the command exits. For short-lived callers (the CLI) the wait costs nothing. A caller inside a
 * long-lived host, such as the OpenCode plugin, uses snapshotAsync instead: on Windows this read
 * takes seconds, and blocking the host's event loop that long would stall everything it serves.
 */
export function snapshot(): Snapshot {
	const plan = enumeration();
	return toSnapshot(plan, readProcesses(plan.command, plan.args));
}

/** The same table as snapshot(), read without blocking the event loop. */
export async function snapshotAsync(): Promise<Snapshot> {
	const plan = enumeration();
	return toSnapshot(plan, await readProcessesAsync(plan.command, plan.args));
}

/** One place turns a completed read into a Snapshot, whichever way the read ran. */
function toSnapshot(plan: Enumeration, result: Read): Snapshot {
	return result.ok ? fromOutput(plan.parse, plan.toTable, result.output) : result;
}

type Read = { ok: true; output: string } | { ok: false; reason: string };

function readProcesses(command: string, args: readonly string[]): Read {
	try {
		return { ok: true, output: execFileSync(command, args, READ_OPTIONS) };
	} catch (error) {
		return { ok: false, reason: failureReason(error) };
	}
}

function readProcessesAsync(command: string, args: readonly string[]): Promise<Read> {
	return new Promise((resolve) => {
		execFile(command, args, READ_OPTIONS, (error, stdout, stderr) => {
			if (!error) {
				resolve({ ok: true, output: stdout });
				return;
			}
			// execFile's error carries the status but not the command's stderr, which the sync path
			// does provide. Attach it so failureReason() reads both paths the same way.
			resolve({ ok: false, reason: failureReason(Object.assign(error, { stderr })) });
		});
	});
}

function fromOutput(
	parse: (output: string) => ProcessRow[],
	toTable: (rows: ProcessRow[]) => ProcessTable,
	output: string,
): Snapshot {
	let rows: ProcessRow[];
	try {
		rows = parse(output);
	} catch (error) {
		return { ok: false, reason: failureReason(error) };
	}
	if (rows.length === 0) {
		// Every machine has running processes, so an empty table means enumeration did not work.
		return { ok: false, reason: "the process table came back empty" };
	}
	return { ok: true, table: toTable(rows) };
}

/** One short line for the user, preferring the command's own message. */
function failureReason(error: unknown): string {
	if (error && typeof error === "object") {
		const failure = error as { code?: unknown; stderr?: unknown; status?: unknown };
		const stderr = typeof failure.stderr === "string" ? failure.stderr.trim() : "";
		if (stderr) {
			return stderr.split("\n")[0]!;
		}
		if (typeof failure.code === "string") {
			return failure.code;
		}
		if (typeof failure.status === "number") {
			return `exit ${failure.status}`;
		}
	}
	return error instanceof Error ? error.message : String(error);
}

/** macOS and Linux: a dead parent reparents its children to init, so pid 1 means the launcher is gone. */
export function posixTable(rows: ProcessRow[]): ProcessTable {
	return {
		rows,
		foldCase: false,
		isOrphanParent: (parent) => !parent || parent.pid === 1,
	};
}

/**
 * Windows: nothing is reparented, so a dead parent's pid stays on the child. The launcher is gone
 * when that pid is absent from the table, when it is 0, or when it belongs to a process that
 * started after the child, meaning the pid was reused.
 */
export function win32Table(rows: ProcessRow[]): ProcessTable {
	return {
		rows,
		foldCase: true,
		isOrphanParent: (parent, child) => {
			if (!parent || child.ppid === 0) {
				return true;
			}
			return parent.created !== undefined && child.created !== undefined && parent.created > child.created;
		},
	};
}

export function parsePs(output: string): ProcessRow[] {
	const rows: ProcessRow[] = [];
	for (const line of output.split("\n")) {
		const match = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
		if (match) {
			rows.push({ pid: Number(match[1]), ppid: Number(match[2]), command: match[3]! });
		}
	}
	return rows;
}

/** Reads the projection that WINDOWS_ENUMERATION_SCRIPT emits. */
export function parseCim(json: string): ProcessRow[] {
	// Windows PowerShell may prefix a BOM; JSON has no place for one.
	const parsed: unknown = JSON.parse(json.replace(/^\uFEFF/, ""));
	// ConvertTo-Json emits a bare object rather than a list when there is exactly one row.
	const items: unknown[] = Array.isArray(parsed) ? parsed : [parsed];
	const rows: ProcessRow[] = [];

	for (const item of items) {
		if (!item || typeof item !== "object") {
			continue;
		}
		const record = item as Record<string, unknown>;
		const pid = numberOrNull(record.ProcessId);
		if (pid === null) {
			continue;
		}

		// A protected process reports no command line. Keep the row anyway: its pid must stay in
		// the table, or a live parent would look like a dead one.
		const command = typeof record.CommandLine === "string" ? record.CommandLine : "";
		const row: ProcessRow = { pid, ppid: numberOrNull(record.ParentProcessId) ?? 0, command };

		if (typeof record.Name === "string" && record.Name.length > 0) {
			row.name = record.Name;
		}
		const created = numberOrNull(record.Created);
		if (created !== null) {
			row.created = created;
		}
		rows.push(row);
	}

	return rows;
}

function numberOrNull(value: unknown): number | null {
	return typeof value === "number" && Number.isFinite(value) ? value : null;
}
