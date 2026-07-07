/**
 * Copyright 2026 Sendbird, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */
/**
 * Windows-safe command resolution for external CLIs (`claude`, `codex`).
 *
 * npm-installed CLIs are exposed on Windows through `.cmd` / `.ps1` shims.
 * Shells resolve those, but direct CreateProcess-style subprocess calls
 * (`spawn` / `spawnSync` without `shell: true`) do not, so `spawn("claude")`
 * fails with ENOENT even though `claude --version` works in PowerShell.
 *
 * This module resolves a command to a directly spawnable invocation:
 * - non-Windows: the command is returned unchanged.
 * - Windows: PATH is searched for `.exe` first, then `.cmd`, then `.bat`.
 *   Recognized npm-style shims are unwrapped to their real executable target.
 *
 * Security invariants (do not weaken):
 * - never `shell: true`, never `cmd.exe /c` — prompts are user-controlled and
 *   passed as argv; a shell wrapper would create a quoting/injection risk.
 * - `.ps1` candidates are intentionally excluded.
 * - a `.cmd` / `.bat` that cannot be unwrapped to a known npm shim pattern
 *   fails closed with `COMMAND_RESOLUTION_FAILED` instead of falling back to
 *   shell execution.
 */

import fs from "node:fs";
import path from "node:path";
import process from "node:process";

export const COMMAND_RESOLUTION_FAILED = "COMMAND_RESOLUTION_FAILED";

const WINDOWS_PATH_DELIMITER = ";";
const WINDOWS_CANDIDATE_EXTENSIONS = [".exe", ".cmd", ".bat"];
const SHIM_EXTENSIONS = new Set([".cmd", ".bat"]);

export class CommandResolutionError extends Error {
  constructor(failure) {
    super(
      `[${failure.code}] Could not resolve command "${failure.command}": ${failure.reason}`
    );
    this.name = "CommandResolutionError";
    this.code = failure.code;
    this.command = failure.command;
    this.searched = failure.searched;
    this.reason = failure.reason;
  }
}

function failure(command, searched, reason) {
  return { ok: false, code: COMMAND_RESOLUTION_FAILED, command, searched, reason };
}

function isFile(candidate) {
  try {
    return fs.statSync(candidate).isFile();
  } catch {
    return false;
  }
}

/**
 * Windows environment variables are case-insensitive; the PATH key may appear
 * as `Path`, `PATH`, or any other casing depending on how the process was
 * launched.
 */
function getWindowsPathValue(env) {
  for (const key of Object.keys(env)) {
    if (key.toLowerCase() === "path" && typeof env[key] === "string") {
      return env[key];
    }
  }
  return "";
}

function listWindowsPathDirectories(env) {
  return getWindowsPathValue(env)
    .split(WINDOWS_PATH_DELIMITER)
    .map((entry) => entry.trim().replace(/^"|"$/g, ""))
    .filter(Boolean);
}

function collapseDuplicateSeparators(value) {
  // Shim targets are assembled from `%dp0%` + a literal suffix that already
  // starts with a separator; collapse the doubled separator without touching
  // a UNC-style leading `\\`.
  return value.replace(/(?!^)([\\/])[\\/]+/g, "$1");
}

/**
 * Expand `%dp0%` / `%~dp0` (the shim's own directory, trailing separator
 * included) inside a quoted shim token. Returns null if the token still
 * contains unexpanded `%...%` variables we do not understand.
 */
function expandShimToken(token, shimDir) {
  const dirWithSep = shimDir.endsWith(path.sep) ? shimDir : shimDir + path.sep;
  const expanded = token.replace(/%~?dp0%?/gi, dirWithSep);
  if (/%[^%]+%/.test(expanded)) {
    return null;
  }
  return collapseDuplicateSeparators(expanded);
}

/**
 * Unwrap a `.cmd` / `.bat` npm-style shim to its real executable target.
 *
 * Accepted patterns (the launch line is the last line containing `%*`):
 * 1. Native executable target: one quoted path ending in `.exe`
 *    -> { command: "<target.exe>", args }
 * 2. Node script target: quoted node program plus a quoted `.js` entrypoint
 *    (`"%_prog%"` or an explicit `node.exe` path)
 *    -> { command: "<node.exe>", args: ["<entrypoint.js>", ...args] }
 *
 * Anything else fails closed — arbitrary shell logic is never executed.
 */
function unwrapWindowsShim(shimPath, args) {
  let content;
  try {
    content = fs.readFileSync(shimPath, "utf8");
  } catch (err) {
    return { ok: false, reason: `Could not read shim "${shimPath}": ${err.message}` };
  }

  const shimDir = path.dirname(shimPath);
  const launchLine = content
    .split(/\r?\n/)
    .filter((line) => line.includes("%*"))
    .pop();
  if (!launchLine) {
    return {
      ok: false,
      reason: `Shim "${shimPath}" has no "%*" launch line; not a recognized npm-style shim.`,
    };
  }

  const quotedTokens = [...launchLine.matchAll(/"([^"]+)"/g)].map((m) => m[1]);

  // Pattern 1: "<target>.exe" %*
  if (quotedTokens.length === 1 && /\.exe$/i.test(quotedTokens[0])) {
    const target = expandShimToken(quotedTokens[0], shimDir);
    if (!target) {
      return {
        ok: false,
        reason: `Shim "${shimPath}" launch target contains unsupported variables.`,
      };
    }
    if (!isFile(target)) {
      return {
        ok: false,
        reason: `Shim "${shimPath}" points to missing executable "${target}".`,
      };
    }
    return { ok: true, command: target, args: [...args], shimPath };
  }

  // Pattern 2: "<node>" "<entrypoint>.js" %*
  if (quotedTokens.length === 2 && /\.js$/i.test(quotedTokens[1])) {
    const [progToken, entryToken] = quotedTokens;
    const entrypoint = expandShimToken(entryToken, shimDir);
    if (!entrypoint || !isFile(entrypoint)) {
      return {
        ok: false,
        reason: `Shim "${shimPath}" points to missing script entrypoint "${entrypoint ?? entryToken}".`,
      };
    }

    let nodeCommand = null;
    if (/^%_prog%$/i.test(progToken)) {
      // npm cmd-shim: `_prog` is `<shimDir>\node.exe` when present, else the
      // `node` on PATH. The current Node runtime is that same resolution
      // product, so `process.execPath` is a safe fallback.
      const localNode = path.join(shimDir, "node.exe");
      nodeCommand = isFile(localNode) ? localNode : process.execPath;
    } else if (/node(\.exe)?$/i.test(progToken)) {
      const explicitNode = expandShimToken(progToken, shimDir);
      if (!explicitNode || !isFile(explicitNode)) {
        return {
          ok: false,
          reason: `Shim "${shimPath}" points to missing node runtime "${explicitNode ?? progToken}".`,
        };
      }
      nodeCommand = explicitNode;
    }

    if (nodeCommand) {
      return { ok: true, command: nodeCommand, args: [entrypoint, ...args], shimPath };
    }
  }

  return {
    ok: false,
    reason:
      `Shim "${shimPath}" does not match a recognized npm-style pattern; ` +
      "refusing to execute arbitrary shell logic.",
  };
}

function resolveWindowsCandidate(candidatePath, command, args, searched) {
  const ext = path.extname(candidatePath).toLowerCase();
  if (ext === ".exe") {
    return {
      ok: true,
      command: candidatePath,
      args: [...args],
      displayCommand: command,
      resolvedPath: candidatePath,
    };
  }
  if (SHIM_EXTENSIONS.has(ext)) {
    const unwrapped = unwrapWindowsShim(candidatePath, args);
    if (!unwrapped.ok) {
      return failure(command, searched, unwrapped.reason);
    }
    return {
      ok: true,
      command: unwrapped.command,
      args: unwrapped.args,
      displayCommand: command,
      resolvedPath: unwrapped.command,
      shimPath: candidatePath,
    };
  }
  return failure(
    command,
    searched,
    `Unsupported candidate extension "${ext}" for "${candidatePath}".`
  );
}

function hasPathSeparator(value) {
  return value.includes("/") || value.includes("\\");
}

function resolveWindowsExplicitPath(command, args) {
  const searched = [];
  const ext = path.extname(command).toLowerCase();

  if (ext === ".ps1") {
    return failure(
      command,
      [command],
      "PowerShell scripts (.ps1) are not supported as command targets."
    );
  }

  const candidates =
    ext === ""
      ? WINDOWS_CANDIDATE_EXTENSIONS.map((e) => command + e)
      : [command];

  for (const candidate of candidates) {
    searched.push(candidate);
    if (isFile(candidate)) {
      return resolveWindowsCandidate(candidate, command, args, searched);
    }
  }
  return failure(
    command,
    searched,
    "No direct executable or recognized npm-style shim was found."
  );
}

function resolveWindowsFromPath(command, args, env) {
  const searched = [];
  const directories = listWindowsPathDirectories(env);

  // Extension-major search: a real `.exe` anywhere on PATH is preferred over
  // an earlier `.cmd` / `.bat` shim.
  for (const extension of WINDOWS_CANDIDATE_EXTENSIONS) {
    for (const directory of directories) {
      const candidate = path.join(directory, command + extension);
      searched.push(candidate);
      if (isFile(candidate)) {
        return resolveWindowsCandidate(candidate, command, args, searched);
      }
    }
  }
  return failure(
    command,
    searched,
    "No direct executable or recognized npm-style shim was found."
  );
}

/**
 * Resolve a command into a directly spawnable invocation without throwing.
 *
 * Returns `{ ok: true, command, args, displayCommand, resolvedPath }` on
 * success, or `{ ok: false, code, command, searched, reason }` on failure.
 *
 * `command` may be a bare name (PATH search) or an explicit path (validated
 * in place). `options.env` / `options.platform` default to the real process
 * environment and are overridable for tests.
 */
export function resolveCommand(command, args = [], options = {}) {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;

  if (platform !== "win32") {
    return {
      ok: true,
      command,
      args: [...args],
      displayCommand: command,
      resolvedPath: null,
    };
  }

  if (hasPathSeparator(command)) {
    return resolveWindowsExplicitPath(command, args);
  }
  return resolveWindowsFromPath(command, args, env);
}

/**
 * Resolve a command into a directly spawnable invocation.
 *
 * Returns `{ command, args, displayCommand, resolvedPath }`; the caller should
 * pass `command` and `args` straight into `spawn` / `spawnSync`.
 * Throws `CommandResolutionError` (with `code`, `command`, `searched`,
 * `reason`) when no safe invocation exists.
 */
export function resolveCommandInvocation(command, args = [], options = {}) {
  const result = resolveCommand(command, args, options);
  if (!result.ok) {
    throw new CommandResolutionError(result);
  }
  return result;
}
