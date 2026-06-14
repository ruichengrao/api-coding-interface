// Agentic tools the model can call: read/write files, list dirs, run commands.
// All file operations are sandboxed to the configured workspace root.

import fs from "fs/promises";
import path from "path";
import { exec, execFile } from "child_process";
import { promisify } from "util";

const execAsync = promisify(exec);
const execFileAsync = promisify(execFile);

const COMMAND_TIMEOUT_MS = 60_000;
const MAX_BUFFER = 1024 * 1024; // 1 MB
const MAX_READ_CHARS = 100_000;
const MAX_TREE_ENTRIES = 600;
const MAX_SEARCH_RESULTS = 200;
const MAX_READ_MANY_FILES = 20;
const MAX_READ_MANY_CHARS = 40_000;
const SKIP_DIRS = new Set([
  ".git",
  "node_modules",
  "dist",
  "build",
  ".next",
  ".cache",
  "coverage",
  "target",
  "vendor",
]);

// Tool schemas in OpenAI Responses API "function" tool format (flattened).
export const toolDefinitions = [
  {
    type: "function",
    name: "read_file",
    description:
      "Read the contents of a text file within the workspace. Returns the file text.",
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "File path relative to the workspace root. A leading slash is treated as workspace-root-relative, so /public means the workspace's public folder.",
        },
      },
      required: ["path"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "write_file",
    description:
      "Create or overwrite a text file within the workspace. Creates parent directories as needed.",
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "File path relative to the workspace root. A leading slash is treated as workspace-root-relative, so /public means the workspace's public folder.",
        },
        content: {
          type: "string",
          description: "The full contents to write to the file.",
        },
      },
      required: ["path", "content"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "list_dir",
    description: "List files and subdirectories within a directory in the workspace.",
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description:
            "Directory path relative to the workspace root. Use '.' for the root. A leading slash is treated as workspace-root-relative.",
        },
      },
      required: ["path"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "file_tree",
    description:
      "Show a recursive file tree under a workspace directory. Skips common heavy folders like node_modules, .git, dist, build, and coverage.",
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Directory path relative to the workspace root. Use '.' for the root.",
        },
        maxEntries: {
          type: "number",
          description: `Maximum number of entries to return. Default ${MAX_TREE_ENTRIES}.`,
        },
      },
      required: ["path"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "search_files",
    description:
      "Search text in workspace files using ripgrep when available. Use this before shelling out to grep/rg.",
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Text or regex pattern to search for.",
        },
        path: {
          type: "string",
          description: "Workspace-relative directory or file to search. Use '.' for the root.",
        },
        glob: {
          type: "string",
          description: "Optional ripgrep-style glob filter, such as '*.jsx' or 'src/**'.",
        },
        fixedStrings: {
          type: "boolean",
          description: "When true, treat query as literal text instead of a regex.",
        },
        maxResults: {
          type: "number",
          description: `Maximum matching lines to return. Default ${MAX_SEARCH_RESULTS}.`,
        },
      },
      required: ["query"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "read_many_files",
    description:
      "Read several workspace files in one tool call. Use after search/file_tree to gather context without many separate reads.",
    parameters: {
      type: "object",
      properties: {
        paths: {
          type: "array",
          items: { type: "string" },
          description: `Workspace-relative file paths. Max ${MAX_READ_MANY_FILES}.`,
        },
        maxCharsPerFile: {
          type: "number",
          description: `Maximum characters per file. Default ${MAX_READ_MANY_CHARS}.`,
        },
      },
      required: ["paths"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "edit_file",
    description:
      "Edit a workspace text file by exact string replacements. Prefer this for targeted edits instead of rewriting whole files.",
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "File path relative to the workspace root.",
        },
        replacements: {
          type: "array",
          items: {
            type: "object",
            properties: {
              oldText: { type: "string", description: "Exact text to replace." },
              newText: { type: "string", description: "Replacement text." },
              replaceAll: {
                type: "boolean",
                description: "Replace every occurrence instead of only the first one.",
              },
            },
            required: ["oldText", "newText"],
            additionalProperties: false,
          },
          description: "Ordered exact replacements to apply atomically.",
        },
      },
      required: ["path", "replacements"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "run_command",
    description:
      "Run a shell command from the workspace root and return its stdout/stderr. Use relative paths such as public/file.js for workspace children; shell paths starting with / are OS-absolute paths.",
    parameters: {
      type: "object",
      properties: {
        command: {
          type: "string",
          description: "The exact shell command to execute.",
        },
      },
      required: ["command"],
      additionalProperties: false,
    },
  },
];

// Approval policy:
// - Any tool call that reaches OUTSIDE the workspace always requires explicit
//   approval, even when command approval is set to "auto". (Only possible when
//   the user has enabled outside-workspace access.)
// - "smart" mode auto-runs normal inside-workspace debugging/build commands but
//   asks for destructive commands, dependency installs, privilege changes, and
//   other high-risk shell actions.
// - "manual" asks for every shell command. "auto" runs inside-workspace shell
//   commands without prompting.
export function needsApproval({ name, args, approvalMode, outside, allowOutsideWorkspace }) {
  if (allowOutsideWorkspace && outside) return true;
  if (name !== "run_command") return false;
  if (approvalMode === "auto") return false;
  if (approvalMode === "manual") return true;
  if (approvalMode === "smart") return commandNeedsApproval(args?.command || "");
  return true;
}

function isOutside(root, resolved) {
  // Windows paths are case-insensitive, so compare case-folded there to avoid
  // false "outside" hits when drive/letter casing differs (e.g. c:\ vs C:\).
  const norm = (p) => (process.platform === "win32" ? p.toLowerCase() : p);
  const r = norm(root);
  const x = norm(resolved);
  return x !== r && !x.startsWith(r + path.sep);
}

function firstSegment(p) {
  return p.split(/[\\/]+/).filter(Boolean)[0] || "";
}

function resolveWorkspacePath(root, input) {
  const raw = String(input || ".");
  if (/^[A-Za-z]:[\\/]/.test(raw) || raw.startsWith("\\\\")) return path.resolve(raw);
  if (!path.isAbsolute(raw)) return path.resolve(root, raw);

  const absolute = path.resolve(raw);
  if (!isOutside(root, absolute)) return absolute;

  // Models often use web-style root-relative paths such as /public or /src.
  // Treat those as workspace children. Full absolute paths that share the
  // workspace's top-level segment still behave as absolute paths, so parent
  // access like /Users/me remains outside.
  if (firstSegment(raw) !== firstSegment(root)) {
    return path.resolve(root, raw.replace(/^[/\\]+/, "") || ".");
  }

  return absolute;
}

// Resolve a path relative to the workspace. When the resolved path escapes the
// workspace and outside access is not allowed, throw.
function resolvePath(workspaceRoot, relPath, allowOutside) {
  const root = path.resolve(workspaceRoot);
  const resolved = resolveWorkspacePath(root, relPath);
  if (isOutside(root, resolved) && !allowOutside) {
    throw new Error(
      `Path "${relPath}" is outside the workspace. Enable "Outside workspace access" in Settings to allow this.`
    );
  }
  return resolved;
}

function toWorkspaceRelative(root, target) {
  const rel = path.relative(root, target) || ".";
  return rel.split(path.sep).join("/");
}

function clampNumber(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(n)));
}

async function walkTree(root, dir, lines, limit) {
  if (lines.length >= limit) return;

  const entries = await fs.readdir(dir, { withFileTypes: true });
  entries.sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name));

  for (const entry of entries) {
    if (lines.length >= limit) return;
    if (entry.isDirectory() && SKIP_DIRS.has(entry.name)) continue;

    const full = path.join(dir, entry.name);
    const rel = toWorkspaceRelative(root, full);
    lines.push(`${entry.isDirectory() ? "[dir] " : "[file]"} ${rel}`);

    if (entry.isDirectory()) await walkTree(root, full, lines, limit);
  }
}

async function fallbackSearch(root, target, query, { fixedStrings, maxResults }) {
  const results = [];
  const matcher = fixedStrings
    ? (line) => line.includes(query)
    : (line) => {
        try {
          return new RegExp(query).test(line);
        } catch {
          return line.includes(query);
        }
      };

  async function scan(p) {
    if (results.length >= maxResults) return;
    const stat = await fs.stat(p);
    if (stat.isDirectory()) {
      const entries = await fs.readdir(p, { withFileTypes: true });
      for (const entry of entries) {
        if (results.length >= maxResults) return;
        if (entry.isDirectory() && SKIP_DIRS.has(entry.name)) continue;
        await scan(path.join(p, entry.name));
      }
      return;
    }

    let text;
    try {
      text = await fs.readFile(p, "utf8");
    } catch {
      return;
    }
    if (text.includes("\u0000")) return;

    const lines = text.split(/\r?\n/);
    for (let i = 0; i < lines.length && results.length < maxResults; i++) {
      if (matcher(lines[i])) {
        results.push(`${toWorkspaceRelative(root, p)}:${i + 1}: ${lines[i]}`);
      }
    }
  }

  await scan(target);
  return results;
}

// Best-effort heuristic: does a shell command appear to touch paths outside the
// workspace root? We treat parent traversal (..), home (~), and absolute paths
// not under the root as "outside". URLs are ignored. This can't catch every
// case (e.g. a command that cd's via a variable), so it errs toward "outside"
// when an absolute-looking path is present — outside access is then ask-first.
function stripHeredocBodies(command) {
  const lines = String(command || "").split(/\r?\n/);
  const kept = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    kept.push(line);

    const match = line.match(/<<-?\s*['"]?([A-Za-z_][A-Za-z0-9_]*)['"]?/);
    if (!match) continue;

    const delimiter = match[1];
    while (i + 1 < lines.length && lines[i + 1].trim() !== delimiter) i++;
    if (i + 1 < lines.length) kept.push(lines[++i]);
  }

  return kept.join("\n");
}

function commandLooksOutside(command, root) {
  const shellText = stripHeredocBodies(command);
  // Strip URLs so "https://host/path" isn't read as an absolute filesystem path.
  const cleaned = shellText.replace(/[a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^\s"'`)]*/g, " ");
  if (/(^|[\s"'=(:])\.\.(\/|\\|$|\s)/.test(cleaned)) return true;

  const candidates = [];
  // Quoted paths first — these may legitimately contain spaces.
  for (const m of cleaned.matchAll(/"([^"]*)"|'([^']*)'/g)) candidates.push(m[1] ?? m[2]);
  // Then unquoted, whitespace-delimited path-looking tokens.
  const unquoted = cleaned.replace(/"[^"]*"|'[^']*'/g, " ");
  for (const m of unquoted.matchAll(/(^|[\s<>|;&()])(~[^\s"'<>;|&()]*|\/[^\s"'<>;|&()]*|[A-Za-z]:\\[^\s"'<>;|&()]*)/g)) {
    candidates.push(m[2]);
  }

  for (const t of candidates) {
    if (!t) continue;
    if (t.startsWith("~")) return true; // home dir lives outside the workspace
    const isWin = /^[A-Za-z]:[\\/]/.test(t) || t.startsWith("\\\\");
    const isPosix = t.startsWith("/");
    if (!isWin && !isPosix) continue; // relative paths run from cwd = workspace
    // Resolve the token and the root with the matching path flavor so a Windows
    // (C:\…) or POSIX (/…) absolute path is judged correctly regardless of which
    // OS the server runs on.
    const flavor = isWin ? path.win32 : path.posix;
    const fold = (p) => (process.platform === "win32" ? p.toLowerCase() : p);
    const rt = fold(flavor.resolve(t));
    const rr = fold(flavor.resolve(root));
    if (rt !== rr && !rt.startsWith(rr + flavor.sep)) return true;
  }
  return false;
}

function commandNeedsApproval(command) {
  const shellText = stripHeredocBodies(command)
    .replace(/[a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^\s"'`)]*/g, " ")
    .toLowerCase();

  const riskyPatterns = [
    /\b(sudo|su|doas)\b/,
    /\b(rm|del|rmdir)\b/,
    /\b(git)\s+(reset|clean|checkout|switch|rebase)\b/,
    /\b(npm|pnpm|yarn|bun)\s+(install|add|remove|update|upgrade|audit\s+fix)\b/,
    /\b(pip|pip3|python\s+-m\s+pip|uv)\s+(install|remove|uninstall|sync)\b/,
    /\b(brew|apt|apt-get|yum|dnf|pacman|choco|winget)\s+(install|remove|upgrade|update)\b/,
    /\b(kill|pkill|killall|taskkill)\b/,
    /\b(chmod|chown|chgrp|takeown|icacls)\b/,
    /\b(ssh|scp|rsync)\b/,
    /\b(curl|wget)\b.*\|\s*(sh|bash|zsh|pwsh|powershell)\b/,
    /\b(open|xdg-open|osascript|start-process)\b/,
  ];

  return riskyPatterns.some((pattern) => pattern.test(shellText));
}

// Used by the agent loop to decide whether a call needs the outside-access gate.
export function accessesOutside(name, args, workspaceRoot) {
  const root = path.resolve(workspaceRoot || ".");
  if (name === "read_file" || name === "write_file" || name === "list_dir") {
    return isOutside(root, resolveWorkspacePath(root, args.path));
  }
  if (name === "run_command") {
    return commandLooksOutside(args.command || "", root);
  }
  return false;
}

export async function executeTool(name, args, workspaceRoot, allowOutside = false) {
  if (!workspaceRoot) {
    return "Error: No workspace folder is configured. Set one in Settings.";
  }

  switch (name) {
    case "read_file": {
      const target = resolvePath(workspaceRoot, args.path, allowOutside);
      let text = await fs.readFile(target, "utf8");
      if (text.length > MAX_READ_CHARS) {
        text = text.slice(0, MAX_READ_CHARS) + "\n... [truncated]";
      }
      return text;
    }

    case "write_file": {
      const target = resolvePath(workspaceRoot, args.path, allowOutside);
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, args.content ?? "", "utf8");
      return `Wrote ${Buffer.byteLength(args.content ?? "")} bytes to ${args.path}.`;
    }

    case "list_dir": {
      const target = resolvePath(workspaceRoot, args.path, allowOutside);
      const entries = await fs.readdir(target, { withFileTypes: true });
      const lines = entries.map(
        (e) => `${e.isDirectory() ? "[dir] " : "[file]"} ${e.name}`
      );
      return lines.length ? lines.join("\n") : "(empty directory)";
    }

    case "file_tree": {
      const root = path.resolve(workspaceRoot);
      const target = resolvePath(workspaceRoot, args.path || ".", allowOutside);
      const limit = clampNumber(args.maxEntries, MAX_TREE_ENTRIES, 1, 2_000);
      const lines = [];
      await walkTree(root, target, lines, limit + 1);
      const truncated = lines.length > limit;
      const output = lines.slice(0, limit).join("\n");
      return `${output || "(empty directory)"}${truncated ? `\n... [truncated after ${limit} entries]` : ""}`;
    }

    case "search_files": {
      const root = path.resolve(workspaceRoot);
      const target = resolvePath(workspaceRoot, args.path || ".", allowOutside);
      const targetArg = isOutside(root, target) ? target : toWorkspaceRelative(root, target);
      const query = String(args.query || "");
      if (!query) return "Error: search_files requires a non-empty query.";

      const maxResults = clampNumber(args.maxResults, MAX_SEARCH_RESULTS, 1, 1_000);
      const rgArgs = [
        "--line-number",
        "--hidden",
        "--glob",
        "!.git",
        "--glob",
        "!node_modules",
        "--glob",
        "!dist",
        "--glob",
        "!build",
        "--glob",
        "!coverage",
      ];
      if (args.fixedStrings) rgArgs.push("--fixed-strings");
      if (args.glob) rgArgs.push("--glob", String(args.glob));
      rgArgs.push("--", query, targetArg);

      try {
        const { stdout } = await execFileAsync("rg", rgArgs, {
          cwd: root,
          timeout: COMMAND_TIMEOUT_MS,
          maxBuffer: MAX_BUFFER,
          windowsHide: true,
        });
        const lines = stdout.split(/\r?\n/).filter(Boolean).slice(0, maxResults);
        const truncated = stdout.split(/\r?\n/).filter(Boolean).length > maxResults;
        return lines.length ? `${lines.join("\n")}${truncated ? `\n... [truncated after ${maxResults} matches]` : ""}` : "(no matches)";
      } catch (e) {
        if (e.code !== 1 && e.code !== "ENOENT") {
          return `search_files failed: ${e.message}`;
        }
        const results = await fallbackSearch(root, target, query, {
          fixedStrings: Boolean(args.fixedStrings),
          maxResults,
        });
        return results.length ? results.join("\n") : "(no matches)";
      }
    }

    case "read_many_files": {
      const paths = Array.isArray(args.paths) ? args.paths.slice(0, MAX_READ_MANY_FILES) : [];
      if (paths.length === 0) return "Error: read_many_files requires at least one path.";
      const maxChars = clampNumber(args.maxCharsPerFile, MAX_READ_MANY_CHARS, 1_000, MAX_READ_CHARS);
      const blocks = [];

      for (const p of paths) {
        const target = resolvePath(workspaceRoot, p, allowOutside);
        let text;
        try {
          text = await fs.readFile(target, "utf8");
        } catch (e) {
          blocks.push(`## ${p}\nError: ${e.message}`);
          continue;
        }
        const truncated = text.length > maxChars;
        if (truncated) text = text.slice(0, maxChars);
        blocks.push(`## ${p}\n\`\`\`\n${text}${truncated ? "\n... [truncated]" : ""}\n\`\`\``);
      }

      return blocks.join("\n\n");
    }

    case "edit_file": {
      const replacements = Array.isArray(args.replacements) ? args.replacements : [];
      if (replacements.length === 0) return "Error: edit_file requires at least one replacement.";

      const target = resolvePath(workspaceRoot, args.path, allowOutside);
      let text = await fs.readFile(target, "utf8");
      const counts = [];

      for (const [index, replacement] of replacements.entries()) {
        const oldText = String(replacement.oldText ?? "");
        const newText = String(replacement.newText ?? "");
        if (!oldText) return `Error: replacement ${index + 1} has empty oldText.`;

        const count = text.split(oldText).length - 1;
        if (count === 0) {
          return `Error: replacement ${index + 1} oldText was not found. No changes written.`;
        }

        if (replacement.replaceAll) {
          text = text.split(oldText).join(newText);
          counts.push(count);
        } else {
          text = text.replace(oldText, newText);
          counts.push(1);
        }
      }

      await fs.writeFile(target, text, "utf8");
      const total = counts.reduce((sum, count) => sum + count, 0);
      return `Edited ${args.path}: ${total} replacement${total === 1 ? "" : "s"} applied.`;
    }

    case "run_command": {
      if (!allowOutside && commandLooksOutside(args.command || "", path.resolve(workspaceRoot))) {
        return `Blocked: this command appears to access paths outside the workspace, which is disabled. Use relative paths like public/... for workspace child folders, or enable "Outside workspace access" in Settings for parent/outside paths.`;
      }
      try {
        const { stdout, stderr } = await execAsync(args.command, {
          cwd: path.resolve(workspaceRoot),
          timeout: COMMAND_TIMEOUT_MS,
          maxBuffer: MAX_BUFFER,
          windowsHide: true,
        });
        const out = [
          stdout ? `STDOUT:\n${stdout}` : "",
          stderr ? `STDERR:\n${stderr}` : "",
        ]
          .filter(Boolean)
          .join("\n\n");
        return out || "Command completed successfully.";
      } catch (e) {
        return [
          `Command failed (exit code ${e.code ?? "unknown"}).`,
          e.stdout ? `STDOUT:\n${e.stdout}` : "",
          e.stderr ? `STDERR:\n${e.stderr}` : "",
          e.killed ? "(process was killed, possibly due to timeout)" : "",
        ]
          .filter(Boolean)
          .join("\n\n");
      }
    }

    default:
      return `Error: Unknown tool "${name}".`;
  }
}
