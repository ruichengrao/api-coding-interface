// Agentic tools the model can call: read/write files, list dirs, run commands.
// All file operations are sandboxed to the configured workspace root.

import fs from "fs/promises";
import path from "path";
import { exec } from "child_process";
import { promisify } from "util";

const execAsync = promisify(exec);

const COMMAND_TIMEOUT_MS = 60_000;
const MAX_BUFFER = 1024 * 1024; // 1 MB
const MAX_READ_CHARS = 100_000;

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
// - Inside the workspace, only run_command needs approval, and only in manual mode.
//   File operations (read_file, list_dir, write_file) are auto-approved.
export function needsApproval({ name, approvalMode, outside, allowOutsideWorkspace }) {
  if (allowOutsideWorkspace && outside) return true;
  if (name === "run_command") return approvalMode !== "auto";
  return false;
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

// Best-effort heuristic: does a shell command appear to touch paths outside the
// workspace root? We treat parent traversal (..), home (~), and absolute paths
// not under the root as "outside". URLs are ignored. This can't catch every
// case (e.g. a command that cd's via a variable), so it errs toward "outside"
// when an absolute-looking path is present — outside access is then ask-first.
function commandLooksOutside(command, root) {
  // Strip URLs so "https://host/path" isn't read as an absolute filesystem path.
  const cleaned = command.replace(/[a-zA-Z][a-zA-Z0-9+.-]*:\/\/\S*/g, " ");
  if (/(^|[\s"'=(:])\.\.(\/|\\|$|\s)/.test(cleaned)) return true;

  const candidates = [];
  // Quoted paths first — these may legitimately contain spaces.
  for (const m of cleaned.matchAll(/"([^"]*)"|'([^']*)'/g)) candidates.push(m[1] ?? m[2]);
  // Then unquoted, whitespace-delimited path-looking tokens.
  const unquoted = cleaned.replace(/"[^"]*"|'[^']*'/g, " ");
  for (const m of unquoted.matchAll(/(~[^\s"';|&]*|\/[^\s"';|&]*|[A-Za-z]:\\[^\s"';|&]*)/g)) {
    candidates.push(m[0]);
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
