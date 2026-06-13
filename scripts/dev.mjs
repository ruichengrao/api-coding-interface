import { existsSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const useShell = process.platform === "win32";
const serverScript = process.argv.includes("--server-start") ? "start" : "dev";
const installOnly = process.argv.includes("--install-only");

function hasInstalledDependencies() {
  return [
    "node_modules",
    path.join("node_modules", "express"),
    path.join("node_modules", "react"),
    path.join("node_modules", "vite"),
  ].every((entry) => existsSync(path.join(root, entry)));
}

function runChecked(command, args) {
  const result = spawnSync(command, args, {
    cwd: root,
    stdio: "inherit",
    shell: useShell,
  });

  if (result.error) {
    console.error(`Failed to run ${command}: ${result.error.message}`);
    process.exit(1);
  }

  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

function ensureDependencies() {
  if (hasInstalledDependencies()) return;

  const hasNodeModules = existsSync(path.join(root, "node_modules"));
  const installArgs = existsSync(path.join(root, "package-lock.json")) && !hasNodeModules
    ? ["ci"]
    : ["install"];

  console.log("Dependencies are missing. Installing them now...");
  runChecked(npm, installArgs);
}

function startWorkspace(name, args) {
  const child = spawn(npm, args, {
    cwd: root,
    stdio: "inherit",
    shell: useShell,
  });

  child.on("error", (error) => {
    console.error(`[${name}] ${error.message}`);
  });

  return child;
}

ensureDependencies();

if (installOnly) {
  console.log("Dependencies are installed.");
  process.exit(0);
}

console.log("Starting local development servers...");
console.log("Web app: http://localhost:5173");
console.log("API:     http://localhost:8787");
console.log("Press Ctrl+C to stop.\n");

const children = [
  startWorkspace("server", ["run", serverScript, "-w", "server"]),
  startWorkspace("client", ["run", "dev", "-w", "client"]),
];

let shuttingDown = false;

function stopAll(exitCode = 0) {
  if (shuttingDown) return;
  shuttingDown = true;

  for (const child of children) {
    if (!child.killed) child.kill();
  }

  setTimeout(() => process.exit(exitCode), 250);
}

for (const child of children) {
  child.on("exit", (code, signal) => {
    if (shuttingDown) return;
    if (code === 0 || signal === "SIGINT" || signal === "SIGTERM") {
      stopAll(0);
      return;
    }

    stopAll(code ?? 1);
  });
}

process.on("SIGINT", () => stopAll(0));
process.on("SIGTERM", () => stopAll(0));
