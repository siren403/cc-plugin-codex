/**
 * Copyright 2026 Sendbird, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

import {
  resolveCommand,
  resolveCommandInvocation,
  CommandResolutionError,
  COMMAND_RESOLUTION_FAILED,
} from "../scripts/lib/command-resolution.mjs";

const WIN = { platform: "win32" };

let fixtureRoot;

function makeDir(...segments) {
  const dir = path.join(fixtureRoot, ...segments);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function writeFileIn(dir, name, content = "") {
  const filePath = path.join(dir, name);
  fs.writeFileSync(filePath, content, "utf8");
  return filePath;
}

/** npm cmd-shim pattern 1: quoted native `.exe` target followed by `%*`. */
function writeExeShim(dir, shimName, targetRelative) {
  const content = [
    "@ECHO off",
    "GOTO start",
    ":find_dp0",
    "SET dp0=%~dp0",
    "EXIT /b",
    ":start",
    "SETLOCAL",
    "CALL :find_dp0",
    `"%dp0%${path.sep}${targetRelative}"   %*`,
    "",
  ].join("\r\n");
  return writeFileIn(dir, shimName, content);
}

/** npm cmd-shim pattern 2: `"%_prog%"` + quoted `.js` entrypoint + `%*`. */
function writeNodeShim(dir, shimName, entryRelative) {
  const content = [
    "@ECHO off",
    "GOTO start",
    ":find_dp0",
    "SET dp0=%~dp0",
    "EXIT /b",
    ":start",
    "SETLOCAL",
    "CALL :find_dp0",
    "",
    'IF EXIST "%dp0%\\node.exe" (',
    '  SET "_prog=%dp0%\\node.exe"',
    ") ELSE (",
    '  SET "_prog=node"',
    "  SET PATHEXT=%PATHEXT:;.JS;=;%",
    ")",
    "",
    "endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & " +
      `"%_prog%"  "%dp0%${path.sep}${entryRelative}" %*`,
    "",
  ].join("\r\n");
  return writeFileIn(dir, shimName, content);
}

before(() => {
  fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cc-cmd-resolution-"));
});

after(() => {
  fs.rmSync(fixtureRoot, { recursive: true, force: true });
});

// ===========================================================================
// Non-Windows passthrough
// ===========================================================================

describe("resolveCommand on non-Windows", () => {
  it("returns the command unchanged", () => {
    const result = resolveCommand("claude", ["--version"], { platform: "linux" });
    assert.equal(result.ok, true);
    assert.equal(result.command, "claude");
    assert.deepEqual(result.args, ["--version"]);
    assert.equal(result.displayCommand, "claude");
    assert.equal(result.resolvedPath, null);
  });
});

// ===========================================================================
// Windows PATH search
// ===========================================================================

describe("resolveCommand on Windows PATH", () => {
  it("resolves a direct .exe from PATH", () => {
    const dir = makeDir("direct-exe");
    const exePath = writeFileIn(dir, "claude.exe");

    const result = resolveCommand("claude", ["--version"], {
      ...WIN,
      env: { PATH: dir },
    });
    assert.equal(result.ok, true);
    assert.equal(result.command, exePath);
    assert.deepEqual(result.args, ["--version"]);
    assert.equal(result.resolvedPath, exePath);
    assert.equal(result.displayCommand, "claude");
  });

  it("handles the PATH key regardless of casing", () => {
    const dir = makeDir("path-casing");
    const exePath = writeFileIn(dir, "claude.exe");

    for (const key of ["Path", "PATH", "path"]) {
      const result = resolveCommand("claude", [], { ...WIN, env: { [key]: dir } });
      assert.equal(result.ok, true, `PATH key "${key}" should resolve`);
      assert.equal(result.command, exePath);
    }
  });

  it("prefers a .exe in a later directory over an earlier .cmd shim", () => {
    const shimDir = makeDir("prefer-exe", "shims");
    const exeDir = makeDir("prefer-exe", "real");
    writeExeShim(shimDir, "claude.cmd", "missing.exe");
    const exePath = writeFileIn(exeDir, "claude.exe");

    const result = resolveCommand("claude", [], {
      ...WIN,
      env: { Path: [shimDir, exeDir].join(";") },
    });
    assert.equal(result.ok, true);
    assert.equal(result.command, exePath);
  });

  it("fails with COMMAND_RESOLUTION_FAILED when the command is missing", () => {
    const dir = makeDir("missing");
    const result = resolveCommand("claude", [], { ...WIN, env: { PATH: dir } });
    assert.equal(result.ok, false);
    assert.equal(result.code, COMMAND_RESOLUTION_FAILED);
    assert.equal(result.command, "claude");
    assert.ok(Array.isArray(result.searched) && result.searched.length > 0);
    assert.match(result.reason, /No direct executable or recognized npm-style shim/);
  });

  it("never resolves .ps1 candidates", () => {
    const dir = makeDir("ps1-only");
    writeFileIn(dir, "claude.ps1", "Write-Host hi");

    const result = resolveCommand("claude", [], { ...WIN, env: { PATH: dir } });
    assert.equal(result.ok, false);
    assert.equal(result.code, COMMAND_RESOLUTION_FAILED);
  });
});

// ===========================================================================
// Shim unwrapping
// ===========================================================================

describe("npm-style shim unwrapping", () => {
  it("unwraps a .cmd shim to its native .exe target", () => {
    const dir = makeDir("cmd-to-exe");
    const targetDir = makeDir("cmd-to-exe", "bin");
    const targetExe = writeFileIn(targetDir, "claude.exe");
    const shimPath = writeExeShim(dir, "claude.cmd", path.join("bin", "claude.exe"));

    const result = resolveCommand("claude", ["--version"], {
      ...WIN,
      env: { PATH: dir },
    });
    assert.equal(result.ok, true);
    assert.equal(result.command, targetExe);
    assert.deepEqual(result.args, ["--version"]);
    assert.equal(result.shimPath, shimPath);
  });

  it("unwraps a .bat shim the same way as .cmd", () => {
    const dir = makeDir("bat-to-exe");
    const targetExe = writeFileIn(dir, "real.exe");
    writeFileIn(dir, "claude.bat", `"%dp0%${path.sep}real.exe" %*\r\n`);

    const result = resolveCommand("claude", [], { ...WIN, env: { PATH: dir } });
    assert.equal(result.ok, true);
    assert.equal(result.command, targetExe);
  });

  it("unwraps a node-script shim using the shim-local node.exe", () => {
    const dir = makeDir("node-local");
    const entryDir = makeDir("node-local", "pkg");
    const localNode = writeFileIn(dir, "node.exe");
    const entry = writeFileIn(entryDir, "cli.js", "// entry");
    writeNodeShim(dir, "codex.cmd", path.join("pkg", "cli.js"));

    const result = resolveCommand("codex", ["app-server"], {
      ...WIN,
      env: { PATH: dir },
    });
    assert.equal(result.ok, true);
    assert.equal(result.command, localNode);
    assert.deepEqual(result.args, [entry, "app-server"]);
  });

  it("falls back to process.execPath when the shim dir has no node.exe", () => {
    const dir = makeDir("node-fallback");
    const entry = writeFileIn(dir, "cli.js", "// entry");
    writeNodeShim(dir, "codex.cmd", "cli.js");

    const result = resolveCommand("codex", ["--version"], {
      ...WIN,
      env: { PATH: dir },
    });
    assert.equal(result.ok, true);
    assert.equal(result.command, process.execPath);
    assert.deepEqual(result.args, [entry, "--version"]);
  });

  it("fails closed when the shim target executable is missing", () => {
    const dir = makeDir("target-missing");
    writeExeShim(dir, "claude.cmd", "nope.exe");

    const result = resolveCommand("claude", [], { ...WIN, env: { PATH: dir } });
    assert.equal(result.ok, false);
    assert.equal(result.code, COMMAND_RESOLUTION_FAILED);
    assert.match(result.reason, /missing executable/);
  });

  it("fails closed for shims with unrecognized launch logic", () => {
    const dir = makeDir("weird-shim");
    writeFileIn(dir, "claude.cmd", "@ECHO off\r\ncmd /c evil.exe %*\r\n");

    const result = resolveCommand("claude", [], { ...WIN, env: { PATH: dir } });
    assert.equal(result.ok, false);
    assert.equal(result.code, COMMAND_RESOLUTION_FAILED);
  });

  it("fails closed for shims with no %* launch line", () => {
    const dir = makeDir("no-launch-line");
    writeFileIn(dir, "claude.cmd", "@ECHO off\r\nECHO not a shim\r\n");

    const result = resolveCommand("claude", [], { ...WIN, env: { PATH: dir } });
    assert.equal(result.ok, false);
    assert.equal(result.code, COMMAND_RESOLUTION_FAILED);
  });
});

// ===========================================================================
// Argument safety
// ===========================================================================

describe("argument handling", () => {
  const SPECIAL_ARGS = [
    "plain",
    "has space",
    'quoted "inner" text',
    "a&b|c<d>e",
    "(parens) and %VAR%",
    "-p",
  ];

  it("keeps special-character args as argv entries for direct executables", () => {
    const dir = makeDir("args-exe");
    writeFileIn(dir, "claude.exe");

    const result = resolveCommand("claude", SPECIAL_ARGS, {
      ...WIN,
      env: { PATH: dir },
    });
    assert.equal(result.ok, true);
    assert.deepEqual(result.args, SPECIAL_ARGS);
  });

  it("keeps special-character args as argv entries after node-shim unwrap", () => {
    const dir = makeDir("args-node");
    const entry = writeFileIn(dir, "cli.js", "// entry");
    writeNodeShim(dir, "codex.cmd", "cli.js");

    const result = resolveCommand("codex", SPECIAL_ARGS, {
      ...WIN,
      env: { PATH: dir },
    });
    assert.equal(result.ok, true);
    assert.deepEqual(result.args, [entry, ...SPECIAL_ARGS]);
  });

  it("does not mutate the caller's args array", () => {
    const dir = makeDir("args-immutable");
    writeFileIn(dir, "claude.exe");
    const args = ["--version"];

    const result = resolveCommand("claude", args, { ...WIN, env: { PATH: dir } });
    assert.equal(result.ok, true);
    assert.notEqual(result.args, args);
    assert.deepEqual(args, ["--version"]);
  });
});

// ===========================================================================
// Explicit path / environment override behavior
// ===========================================================================

describe("explicit path resolution (env overrides)", () => {
  it("accepts an explicit .exe path", () => {
    const dir = makeDir("override-exe");
    const exePath = writeFileIn(dir, "codex.exe");

    const result = resolveCommand(exePath, ["app-server"], { ...WIN, env: {} });
    assert.equal(result.ok, true);
    assert.equal(result.command, exePath);
    assert.deepEqual(result.args, ["app-server"]);
  });

  it("unwraps an explicit .cmd shim path", () => {
    const dir = makeDir("override-cmd");
    const entry = writeFileIn(dir, "cli.js", "// entry");
    const shimPath = writeNodeShim(dir, "codex.cmd", "cli.js");

    const result = resolveCommand(shimPath, ["app-server"], { ...WIN, env: {} });
    assert.equal(result.ok, true);
    assert.deepEqual(result.args, [entry, "app-server"]);
  });

  it("tries .exe/.cmd/.bat candidates for an extensionless explicit path", () => {
    const dir = makeDir("override-noext");
    const exePath = writeFileIn(dir, "codex.exe");

    const result = resolveCommand(path.join(dir, "codex"), [], { ...WIN, env: {} });
    assert.equal(result.ok, true);
    assert.equal(result.command, exePath);
  });

  it("rejects an explicit .ps1 path", () => {
    const dir = makeDir("override-ps1");
    const ps1Path = writeFileIn(dir, "codex.ps1", "Write-Host hi");

    const result = resolveCommand(ps1Path, [], { ...WIN, env: {} });
    assert.equal(result.ok, false);
    assert.equal(result.code, COMMAND_RESOLUTION_FAILED);
    assert.match(result.reason, /\.ps1/);
  });

  it("fails closed for an explicit path that does not exist", () => {
    const result = resolveCommand(path.join(fixtureRoot, "ghost", "codex.exe"), [], {
      ...WIN,
      env: {},
    });
    assert.equal(result.ok, false);
    assert.equal(result.code, COMMAND_RESOLUTION_FAILED);
  });
});

// ===========================================================================
// Throwing wrapper
// ===========================================================================

describe("resolveCommandInvocation", () => {
  it("returns the invocation on success", () => {
    const dir = makeDir("throwing-ok");
    const exePath = writeFileIn(dir, "claude.exe");

    const invocation = resolveCommandInvocation("claude", ["--version"], {
      ...WIN,
      env: { PATH: dir },
    });
    assert.equal(invocation.command, exePath);
    assert.deepEqual(invocation.args, ["--version"]);
  });

  it("throws CommandResolutionError with diagnostic fields on failure", () => {
    const dir = makeDir("throwing-fail");
    assert.throws(
      () => resolveCommandInvocation("claude", [], { ...WIN, env: { PATH: dir } }),
      (err) => {
        assert.ok(err instanceof CommandResolutionError);
        assert.equal(err.code, COMMAND_RESOLUTION_FAILED);
        assert.equal(err.command, "claude");
        assert.ok(Array.isArray(err.searched));
        assert.match(err.reason, /No direct executable/);
        return true;
      }
    );
  });
});
