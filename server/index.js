import express from "express";
import cors from "cors";
import path from "path";
import fs from "fs/promises";
import { exec } from "child_process";
import { promisify } from "util";
import { fileURLToPath } from "url";
import { randomUUID } from "crypto";
import { runAgent } from "./agent.js";
import { inspectApiKey } from "./openai.js";

const execAsync = promisify(exec);

const app = express();
const PORT = process.env.PORT || 8787;

// Default workspace = the "Account 1" folder in the app root, unless overridden
// by the DEFAULT_WORKSPACE env var. Used when the client doesn't specify one.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_WORKSPACE =
  process.env.DEFAULT_WORKSPACE || path.resolve(__dirname, "..", "Account 1");

app.use(cors());
app.use(express.json({ limit: "25mb" }));

// Pending tool approvals, keyed by call_id. Each value is a resolver fn.
const pendingApprovals = new Map();

app.get("/api/health", (_req, res) => res.json({ ok: true }));

// The default workspace folder the UI pre-fills when none is configured.
app.get("/api/default-workspace", (_req, res) => res.json({ path: DEFAULT_WORKSPACE }));

// Validate that a workspace folder exists and is a directory.
app.post("/api/validate-workspace", async (req, res) => {
  const { workspaceRoot } = req.body || {};
  if (!workspaceRoot) return res.json({ ok: false, error: "No path provided." });
  try {
    const stat = await fs.stat(workspaceRoot);
    if (!stat.isDirectory()) return res.json({ ok: false, error: "Path is not a directory." });
    return res.json({ ok: true, resolved: path.resolve(workspaceRoot) });
  } catch (e) {
    return res.json({ ok: false, error: e.message });
  }
});

// Validate the selected OpenAI API key and return non-secret account metadata
// for the turn log.
app.post("/api/inspect-key", async (req, res) => {
  const { apiKey } = req.body || {};
  try {
    const identity = await inspectApiKey({ apiKey });
    return res.json({ ok: true, identity });
  } catch (e) {
    const status = e.status && e.status !== 0 ? e.status : 502;
    return res.status(status).json({
      ok: false,
      error: e.message,
      request_id: e.requestId || null,
      status: e.status || null,
    });
  }
});

// Open a native folder-picker dialog on the machine running the server and
// return the chosen absolute path. Used by the "Browse…" button in Settings.
app.post("/api/browse-folder", async (_req, res) => {
  const platform = process.platform;
  let cmd;
  if (platform === "darwin") {
    cmd = `osascript -e 'POSIX path of (choose folder with prompt "Select workspace folder")'`;
  } else if (platform === "win32") {
    // -STA is required for the WinForms FolderBrowserDialog to run reliably.
    cmd =
      `powershell -NoProfile -STA -Command "Add-Type -AssemblyName System.Windows.Forms; ` +
      `$f = New-Object System.Windows.Forms.FolderBrowserDialog; ` +
      `if ($f.ShowDialog() -eq 'OK') { $f.SelectedPath } else { '' }"`;
  } else {
    cmd = `zenity --file-selection --directory`;
  }

  try {
    const { stdout } = await execAsync(cmd, { timeout: 120_000 });
    const picked = stdout.trim().replace(/[/\\]$/, "");
    if (!picked) return res.json({ canceled: true });
    return res.json({ path: path.resolve(picked) });
  } catch (e) {
    // osascript returns "User canceled. (-128)"; zenity exits non-zero on cancel.
    if (/-128|cancel/i.test(e.message) || e.code === 1) return res.json({ canceled: true });
    return res.json({ error: `Could not open a folder picker on this system: ${e.message}` });
  }
});

// Approve or reject a pending tool call.
app.post("/api/approve", (req, res) => {
  const { call_id, approved } = req.body || {};
  const resolver = pendingApprovals.get(call_id);
  if (!resolver) return res.status(404).json({ error: "No pending approval for that call_id." });
  pendingApprovals.delete(call_id);
  resolver(Boolean(approved));
  res.json({ ok: true });
});

// Main agent endpoint. Streams progress to the client via Server-Sent Events.
app.post("/api/chat", async (req, res) => {
  const {
    message,
    apiKey,
    model = "gpt-5.5",
    safetyIdentifier = null,
    previousResponseId = null,
    workspaceRoot = "",
    approvalMode = "manual",
    allowOutsideWorkspace = false,
    attachments = [],
  } = req.body || {};

  // Fall back to the default workspace if the client didn't provide one.
  const effectiveWorkspace = workspaceRoot?.trim() ? workspaceRoot : DEFAULT_WORKSPACE;

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders?.();

  let clientGone = false;

  const emit = (event, data) => {
    if (clientGone || res.writableEnded) return;
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  const openApprovals = new Set();
  const requestApproval = (toolCall) =>
    new Promise((resolve) => {
      pendingApprovals.set(toolCall.call_id, resolve);
      openApprovals.add(toolCall.call_id);
      emit("approval_request", toolCall);
    });

  // If the client disconnects before we finish (e.g. force-stop), abort the
  // loop and auto-reject any open approvals.
  // NOTE: use res "close" (not req "close"): the request stream emits "close"
  // as soon as its body is consumed, which is not a disconnect. The response
  // only "closes" early when the connection is actually terminated.
  res.on("close", () => {
    if (res.writableEnded) return; // normal completion, not an abort
    clientGone = true;
    for (const id of openApprovals) {
      const r = pendingApprovals.get(id);
      if (r) {
        pendingApprovals.delete(id);
        r(false);
      }
    }
  });

  try {
    if (!message || !message.trim()) {
      emit("error", { message: "Empty message." });
      return res.end();
    }

    emit("start", { id: randomUUID() });

    const result = await runAgent({
      apiKey,
      model,
      userMessage: message,
      safetyIdentifier,
      previousResponseId,
      workspaceRoot: effectiveWorkspace,
      approvalMode,
      allowOutsideWorkspace,
      attachments,
      emit,
      requestApproval,
      shouldAbort: () => clientGone,
    });

    emit("done", {
      previousResponseId: result.previousResponseId,
      idLog: result.idLog,
    });
  } catch (e) {
    emit("error", { message: e.message, request_id: e.requestId || null, status: e.status || null });
  } finally {
    for (const id of openApprovals) pendingApprovals.delete(id);
    res.end();
  }
});

app.listen(PORT, () => {
  console.log(`[codex-local-assistant] server listening on http://localhost:${PORT}`);
});
