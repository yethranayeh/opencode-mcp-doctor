#!/usr/bin/env node
/* CLI: report local MCP server processes that are leftover or competing.
 *
 * Exit codes: 0 nothing to reclaim, 1 orphaned processes found, 2 usage error,
 * 3 the process table could not be read, 4 competing live chains with --strict.
 */

import { readTargets } from "../src/config.ts";
import { findInstances } from "../src/detect.ts";
import { snapshot } from "../src/process.ts";
import { conflictNote, exitStatus, formatReport, toJson } from "../src/report.ts";
import { selfPid } from "../src/system.ts";

const USAGE = `Usage: mcp-doctor [options]

Reports the running local MCP server processes behind your configured servers, and
whether each one is still owned by a live host or was left behind.

Options:
  --config <path>  Read server commands from this config file (repeatable).
  --json           Print machine-readable output.
  --quiet          Print nothing; use the exit code only.
  --strict         Fail when more than one live chain competes for a server.
  -h, --help       Show this help.

Exit codes:
  0  nothing to reclaim
  1  orphaned processes found
  2  usage error
  3  the process table could not be read
  4  competing live chains found (--strict)`;

function main(argv: readonly string[]): number {
  const configs: string[] = [];
  let json = false;
  let quiet = false;
  let strict = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--json") {
      json = true;
    } else if (arg === "--quiet") {
      quiet = true;
    } else if (arg === "--strict") {
      strict = true;
    } else if (arg === "--config") {
      const path = argv[++i];
      if (!path) {
        process.stderr.write("mcp-doctor: --config needs a path\n");
        return 2;
      }
      configs.push(path);
    } else if (arg === "-h" || arg === "--help") {
      process.stdout.write(`${USAGE}\n`);
      return 0;
    } else {
      process.stderr.write(`mcp-doctor: unknown argument ${arg}\n`);
      return 2;
    }
  }

  const targets = readTargets(configs.length > 0 ? configs : undefined);
  const result = snapshot();
  if (!result.ok) {
    // A table we could not read is not a clean machine, and must not be reported as one.
    process.stderr.write(`mcp-doctor: could not read the process table (${result.reason})\n`);
    return 3;
  }

  const instances = findInstances(targets, result.table, selfPid());

  if (!quiet) {
    process.stdout.write(json ? `${toJson(instances)}\n` : `${formatReport(instances)}\n`);
    const note = conflictNote(instances);
    if (note && !json) {
      process.stdout.write(`\n${note}\n`);
    }
  }

  return exitStatus(instances, strict);
}

process.exit(main(process.argv.slice(2)));
