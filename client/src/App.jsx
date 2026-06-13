import { useRef, useState, useEffect } from "react";
import {
  SendHorizontal,
  Plus,
  Loader2,
  AlertCircle,
  Bot,
  User,
  Square,
  Download,
  FileText,
  Image as ImageIcon,
  X,
} from "lucide-react";
import { useStore } from "./lib/useSettings";
import { streamChat, approveToolCall } from "./lib/agentClient";
import Sidebar from "./components/Sidebar";
import TurnLog from "./components/TurnLog";
import ToolCard from "./components/ToolCard";
import Markdown from "./components/Markdown";
import NewChatModal from "./components/NewChatModal";

const nextId = (prefix = "id") => `${prefix}-${crypto.randomUUID()}`;

const MAX_ATTACH_BYTES = 10 * 1024 * 1024; // 10 MB per file
const MAX_ATTACH_TEXT = 100_000; // chars of a text file we inline

const formatSize = (n) =>
  n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${Math.round(n / 1024)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`;

const deriveTitle = (text) => {
  const t = (text || "").replace(/\s+/g, " ").trim();
  if (!t) return "New chat";
  return t.length > 42 ? t.slice(0, 42) + "…" : t;
};

const readDataUrl = (file) =>
  new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = () => reject(r.error);
    r.readAsDataURL(file);
  });

// Turn a picked File into an attachment: images become data URLs (vision),
// everything else is read as UTF-8 text and inlined as context.
async function fileToAttachment(file) {
  const base = { id: crypto.randomUUID(), name: file.name, size: file.size };
  if (file.type.startsWith("image/")) {
    return { ...base, kind: "image", dataUrl: await readDataUrl(file) };
  }
  let text = await file.text();
  if (text.length > MAX_ATTACH_TEXT) text = text.slice(0, MAX_ATTACH_TEXT) + "\n... [truncated]";
  return { ...base, kind: "text", text };
}

const PANEL_DEFAULT = 320;
const PANEL_MIN = 220;
const PANEL_MAX = 560;

const loadWidth = (key) => {
  const v = Number(localStorage.getItem(`cla.panel.${key}`));
  return Number.isFinite(v) && v >= PANEL_MIN && v <= PANEL_MAX ? v : PANEL_DEFAULT;
};

// A draggable vertical divider. `dir` is +1 when the panel sits to the LEFT of
// the handle (drag right = wider) and -1 when it sits to the RIGHT.
function ResizeHandle({ width, setWidth, dir }) {
  const onMouseDown = (e) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = width;
    const onMove = (ev) => {
      const next = startW + dir * (ev.clientX - startX);
      setWidth(Math.min(PANEL_MAX, Math.max(PANEL_MIN, next)));
    };
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  return (
    <div
      onMouseDown={onMouseDown}
      onDoubleClick={() => setWidth(PANEL_DEFAULT)}
      title="Drag to resize · double-click to reset"
      className="relative w-px shrink-0 cursor-col-resize bg-white/10 transition-colors hover:bg-sky-500/60"
    >
      {/* widen the invisible hit area so it's easy to grab */}
      <div className="absolute inset-y-0 -left-1.5 -right-1.5" />
    </div>
  );
}

export default function App() {
  const {
    apiKeys,
    addKey,
    removeKey,
    chats,
    activeChat,
    activeChatId,
    activeKey,
    createChat,
    switchChat,
    renameChat,
    deleteChat,
    updateChat,
    updateActive,
  } = useStore();

  const [showNewChat, setShowNewChat] = useState(false);

  // The active chat is the single source of truth for the conversation, its
  // turn log, and its settings.
  const chat = activeChat;
  const messages = chat?.messages || [];
  const turns = chat?.turns || [];

  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");
  const [error, setError] = useState(null);

  const [leftWidth, setLeftWidth] = useState(() => loadWidth("left"));
  const [rightWidth, setRightWidth] = useState(() => loadWidth("right"));

  const [attachments, setAttachments] = useState([]);
  const fileInputRef = useRef(null);

  const streamChatId = useRef(null); // chat the in-flight stream writes to
  const scrollRef = useRef(null);
  const abortRef = useRef(null);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [messages, status]);

  useEffect(() => {
    localStorage.setItem("cla.panel.left", String(leftWidth));
  }, [leftWidth]);
  useEffect(() => {
    localStorage.setItem("cla.panel.right", String(rightWidth));
  }, [rightWidth]);

  // Reset transient UI state when switching to a different chat.
  useEffect(() => {
    setError(null);
    setStatus("");
    setAttachments([]);
  }, [activeChatId]);

  // Pre-fill the workspace folder from the server default for the first chat.
  useEffect(() => {
    if (activeChat?.workspaceRoot?.trim()) return;
    fetch("/api/default-workspace")
      .then((r) => r.json())
      .then((d) => {
        if (d?.path) updateActive({ workspaceRoot: d.path });
      })
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const patchTool = (chatId, callId, patch) =>
    updateChat(chatId, (c) => ({
      messages: c.messages.map((m) =>
        m.type === "tool" && m.call_id === callId ? { ...m, ...patch } : m
      ),
    }));

  const addFiles = async (files) => {
    const added = [];
    for (const f of files) {
      if (f.size > MAX_ATTACH_BYTES) {
        setError(`"${f.name}" is larger than 10 MB and was skipped.`);
        continue;
      }
      try {
        added.push(await fileToAttachment(f));
      } catch {
        setError(`Could not read "${f.name}".`);
      }
    }
    if (added.length) setAttachments((prev) => [...prev, ...added]);
  };

  const onPickFiles = (e) => {
    const files = Array.from(e.target.files || []);
    e.target.value = ""; // let the same file be re-picked later
    addFiles(files);
  };

  // Paste a screenshot or copied image straight into the composer.
  const onPaste = (e) => {
    const items = Array.from(e.clipboardData?.items || []);
    const images = items.filter((it) => it.kind === "file" && it.type.startsWith("image/"));
    if (images.length === 0) return; // let normal text paste through
    e.preventDefault();
    const files = images.map((it, i) => {
      const blob = it.getAsFile();
      // Pasted screenshots often have no/duplicate names — give each a unique one.
      const ext = (blob.type.split("/")[1] || "png").split("+")[0];
      const name = blob.name && blob.name !== "image.png" ? blob.name : `pasted-${Date.now()}-${i}.${ext}`;
      return new File([blob], name, { type: blob.type });
    });
    addFiles(files);
  };

  const removeAttachment = (id) => setAttachments((prev) => prev.filter((a) => a.id !== id));

  const send = async () => {
    const text = input.trim();
    if ((!text && attachments.length === 0) || busy) return;
    if (!activeKey) {
      setError("Choose an API key for this chat in the sidebar first.");
      return;
    }
    if (!chat.workspaceValidated) {
      setError("Validate this chat's workspace folder in the sidebar before chatting.");
      return;
    }

    const chatId = activeChatId;
    streamChatId.current = chatId;
    const sentAttachments = attachments;
    const safetyId = chat.safetyIdentifier || null;
    const turnId = nextId("turn");

    setError(null);
    setInput("");
    setAttachments([]);
    setBusy(true);
    setStatus("Thinking…");

    // Append the user message + a new turn-log entry; title the chat from the
    // first message.
    updateChat(chatId, (c) => ({
      title: c.messages.length === 0 ? deriveTitle(text) : c.title,
      messages: [
        ...c.messages,
        {
          id: nextId("msg"),
          role: "user",
          text,
          attachments: sentAttachments.map((a) => ({ name: a.name, kind: a.kind })),
        },
      ],
      turns: [
        ...c.turns,
        {
          id: turnId,
          time: new Date().toLocaleTimeString(),
          keyLabel: activeKey.label,
          model: chat.model,
          safetyIdentifier: safetyId,
          calls: [],
        },
      ],
    }));

    const payload = {
      message: text,
      apiKey: activeKey.key,
      model: chat.model,
      safetyIdentifier: safetyId,
      previousResponseId: chat.previousResponseId,
      workspaceRoot: chat.workspaceRoot,
      approvalMode: chat.approvalMode,
      allowOutsideWorkspace: chat.allowOutsideWorkspace,
      attachments: sentAttachments.map((a) =>
        a.kind === "image"
          ? { name: a.name, kind: "image", dataUrl: a.dataUrl }
          : { name: a.name, kind: "text", text: a.text }
      ),
    };

    const controller = new AbortController();
    abortRef.current = controller;

    try {
      await streamChat(
        payload,
        {
          status: (d) => setStatus(d.message || ""),
          ids: (d) =>
            updateChat(chatId, (c) => ({
              turns: c.turns.map((t) =>
                t.id === turnId ? { ...t, calls: [...t.calls, d] } : t
              ),
            })),
          assistant_message: (d) => {
            setStatus("");
            updateChat(chatId, (c) => ({
              messages: [...c.messages, { id: nextId("msg"), role: "assistant", text: d.text }],
            }));
          },
          tool_call: (d) => {
            setStatus("");
            updateChat(chatId, (c) => ({
              messages: [
                ...c.messages,
                {
                  id: nextId("tool"),
                  type: "tool",
                  call_id: d.call_id,
                  name: d.name,
                  arguments: d.arguments,
                  outside: d.outside,
                  status: "running",
                  result: null,
                },
              ],
            }));
          },
          approval_request: (d) => {
            patchTool(chatId, d.call_id, { status: "pending_approval", outside: d.outside });
            setStatus("Waiting for your approval…");
          },
          tool_result: (d) => {
            patchTool(chatId, d.call_id, {
              status: d.rejected ? "rejected" : "done",
              result: d.result,
            });
          },
          done: (d) => {
            if (d.previousResponseId) updateChat(chatId, { previousResponseId: d.previousResponseId });
            setStatus("");
          },
          error: (d) => {
            setError(`${d.message}${d.request_id ? ` (request id: ${d.request_id})` : ""}`);
            setStatus("");
          },
        },
        controller.signal
      );
    } catch (e) {
      if (e.name === "AbortError") {
        updateChat(chatId, (c) => ({
          messages: [...c.messages, { id: nextId("notice"), type: "notice", text: "Stopped by you." }],
        }));
      } else {
        setError(e.message);
      }
    } finally {
      abortRef.current = null;
      setBusy(false);
      setStatus("");
    }
  };

  const stop = () => {
    abortRef.current?.abort();
    const chatId = streamChatId.current;
    if (chatId) {
      // Clear any tool calls that were waiting on the model or your approval.
      updateChat(chatId, (c) => ({
        messages: c.messages.map((m) =>
          m.type === "tool" && (m.status === "running" || m.status === "pending_approval")
            ? { ...m, status: "rejected" }
            : m
        ),
      }));
    }
    setStatus("");
  };

  const handleApprove = async (callId) => {
    patchTool(streamChatId.current, callId, { status: "running" });
    setStatus("Thinking…");
    await approveToolCall(callId, true);
  };
  const handleReject = async (callId) => {
    await approveToolCall(callId, false);
  };

  const onKeyDown = (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  };

  const download = (filename, content, mime) => {
    const blob = new Blob([content], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  };

  const stamp = () => new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);

  const exportChat = () => {
    if (messages.length === 0) return;
    const lines = [
      `# ${chat.title}`,
      `_Exported ${new Date().toLocaleString()} · model: ${chat.model}_`,
      "",
    ];
    for (const m of messages) {
      if (m.type === "notice") {
        lines.push(`> _${m.text}_`, "");
      } else if (m.type === "tool") {
        lines.push(`### Tool: \`${m.name}\` (${m.status})`);
        if (m.arguments?.command) lines.push("```sh", m.arguments.command, "```");
        else if (m.arguments?.path) lines.push(`Path: \`${m.arguments.path}\``);
        if (m.name === "write_file" && m.arguments?.content != null) {
          lines.push("```", m.arguments.content, "```");
        }
        if (m.result != null) lines.push("Result:", "```", String(m.result), "```");
        lines.push("");
      } else {
        lines.push(m.role === "user" ? "## You" : "## Assistant", "", m.text, "");
        if (m.attachments?.length) {
          lines.push(`_Attachments: ${m.attachments.map((a) => a.name).join(", ")}_`, "");
        }
      }
    }
    download(`chat-${stamp()}.md`, lines.join("\n"), "text/markdown");
  };

  const exportTurnLog = () => {
    if (turns.length === 0) return;
    const lines = [
      "Codex Local Assistant — Turn Log",
      `Chat: ${chat.title}`,
      `Safety Identifier: ${chat.safetyIdentifier || "(not set)"}`,
      `Exported: ${new Date().toLocaleString()}`,
      "=".repeat(48),
      "",
    ];
    turns.forEach((t, i) => {
      lines.push(`Turn ${i + 1} — ${t.time}`);
      lines.push(
        `  Key: ${t.keyLabel} | Model: ${t.model} | Safety ID: ${t.safetyIdentifier || "(not sent)"}`
      );
      if (t.calls.length === 0) lines.push("  (no API calls recorded)");
      t.calls.forEach((c, ci) => {
        lines.push(`  API call ${ci + 1}:`);
        lines.push(`    request_id:  ${c.request_id || "n/a"}`);
        lines.push(`    response_id: ${c.response_id || "n/a"}`);
        if (c.usage) {
          lines.push(
            `    tokens:      in ${c.usage.input_tokens ?? "?"} / out ${c.usage.output_tokens ?? "?"}`
          );
        }
      });
      lines.push("");
    });
    download(`turn-log-${stamp()}.txt`, lines.join("\n"), "text/plain");
  };

  const canChat = activeKey && chat?.workspaceValidated;

  return (
    <div className="flex h-screen overflow-hidden">
      <Sidebar
        width={leftWidth}
        chats={chats}
        activeChatId={activeChatId}
        onNewChat={() => setShowNewChat(true)}
        onSwitchChat={switchChat}
        onRenameChat={renameChat}
        onDeleteChat={deleteChat}
        settings={chat}
        update={updateActive}
        activeKey={activeKey}
      />
      <ResizeHandle width={leftWidth} setWidth={setLeftWidth} dir={1} />

      {/* Main chat column */}
      <main className="flex min-w-0 flex-1 flex-col">
        <header className="flex items-center gap-3 border-b border-white/10 px-5 py-3">
          <div className="min-w-0">
            <div className="truncate font-semibold">{chat?.title || "Chat"}</div>
            <div className="text-xs text-zinc-500">
              {activeKey ? activeKey.label : "no key selected"} · {chat?.model}
            </div>
          </div>
          <button
            onClick={exportChat}
            disabled={messages.length === 0}
            title="Download chat as Markdown"
            className="ml-auto flex items-center gap-1.5 rounded-lg border border-white/10 px-3 py-1.5 text-sm hover:bg-white/5 disabled:opacity-40"
          >
            <Download size={14} /> .md
          </button>
          <button
            onClick={() => setShowNewChat(true)}
            className="flex items-center gap-1.5 rounded-lg border border-white/10 px-3 py-1.5 text-sm hover:bg-white/5"
          >
            <Plus size={14} /> New chat
          </button>
        </header>

        <div ref={scrollRef} className="flex-1 overflow-y-auto px-5 py-6">
          <div className="mx-auto max-w-3xl space-y-5">
            {messages.length === 0 && (
              <div className="mt-20 text-center text-zinc-500">
                <Bot size={32} className="mx-auto mb-3 text-zinc-600" />
                <p className="text-lg font-medium text-zinc-300">Start vibe coding</p>
                <p className="mt-1 text-sm">
                  Pick a key and a workspace folder in the sidebar, then ask me to build, edit, or run your project.
                </p>
              </div>
            )}

            {messages.map((m) => {
              if (m.type === "notice") {
                return (
                  <div
                    key={m.id}
                    className="mx-auto w-fit rounded-full border border-white/10 bg-white/5 px-3 py-1 text-xs text-zinc-400"
                  >
                    {m.text}
                  </div>
                );
              }
              if (m.type === "tool") {
                return (
                  <div key={m.id} className="ml-9">
                    <ToolCard tool={m} onApprove={handleApprove} onReject={handleReject} />
                  </div>
                );
              }
              const isUser = m.role === "user";
              return (
                <div key={m.id} className="flex gap-3">
                  <div
                    className={`mt-0.5 grid h-7 w-7 shrink-0 place-items-center rounded-lg ${
                      isUser ? "bg-zinc-700" : "bg-gradient-to-br from-sky-500 to-indigo-600"
                    }`}
                  >
                    {isUser ? <User size={15} /> : <Bot size={15} className="text-white" />}
                  </div>
                  <div className="min-w-0 flex-1 pt-0.5">
                    {isUser ? (
                      <>
                        {m.text && (
                          <p className="whitespace-pre-wrap text-[0.92rem] leading-relaxed text-zinc-200">
                            {m.text}
                          </p>
                        )}
                        {m.attachments?.length > 0 && (
                          <div className="mt-1.5 flex flex-wrap gap-1.5">
                            {m.attachments.map((a, i) => (
                              <span
                                key={i}
                                className="flex items-center gap-1 rounded-md border border-white/10 bg-white/5 px-1.5 py-0.5 text-[11px] text-zinc-400"
                              >
                                {a.kind === "image" ? <ImageIcon size={11} /> : <FileText size={11} />}
                                {a.name}
                              </span>
                            ))}
                          </div>
                        )}
                      </>
                    ) : (
                      <Markdown>{m.text}</Markdown>
                    )}
                  </div>
                </div>
              );
            })}

            {status && (
              <div className="ml-10 flex items-center gap-2 text-sm text-zinc-500">
                <Loader2 size={14} className="animate-spin" /> {status}
              </div>
            )}

            {error && (
              <div className="flex items-start gap-2 rounded-lg border border-rose-500/40 bg-rose-500/10 p-3 text-sm text-rose-300">
                <AlertCircle size={16} className="mt-0.5 shrink-0" />
                <span className="whitespace-pre-wrap">{error}</span>
              </div>
            )}
          </div>
        </div>

        {/* Composer */}
        <div className="border-t border-white/10 px-5 py-4">
          <div className="mx-auto max-w-3xl rounded-2xl border border-white/10 bg-white/[0.03] p-2 focus-within:border-sky-500/50">
            {attachments.length > 0 && (
              <div className="mb-2 flex flex-wrap gap-2 px-1">
                {attachments.map((a) => (
                  <div
                    key={a.id}
                    className="flex items-center gap-1.5 rounded-lg border border-white/10 bg-white/5 px-2 py-1 text-xs"
                  >
                    {a.kind === "image" ? (
                      <ImageIcon size={13} className="shrink-0 text-zinc-400" />
                    ) : (
                      <FileText size={13} className="shrink-0 text-zinc-400" />
                    )}
                    <span className="max-w-[12rem] truncate text-zinc-200">{a.name}</span>
                    <span className="text-zinc-600">{formatSize(a.size)}</span>
                    <button
                      onClick={() => removeAttachment(a.id)}
                      title="Remove attachment"
                      className="text-zinc-500 hover:text-rose-400"
                    >
                      <X size={12} />
                    </button>
                  </div>
                ))}
              </div>
            )}
            <div className="flex items-end gap-2">
              <input
                ref={fileInputRef}
                type="file"
                multiple
                className="hidden"
                onChange={onPickFiles}
              />
              <button
                onClick={() => fileInputRef.current?.click()}
                disabled={!canChat}
                title="Attach files"
                className="grid h-9 w-9 shrink-0 place-items-center rounded-xl border border-white/10 text-zinc-400 transition hover:bg-white/5 hover:text-zinc-200 disabled:opacity-40"
              >
                <Plus size={18} />
              </button>
              <textarea
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={onKeyDown}
                onPaste={onPaste}
                rows={1}
                placeholder={
                  !activeKey
                    ? "Choose an API key in the sidebar to begin…"
                    : !chat?.workspaceValidated
                    ? "Validate this chat's workspace folder to begin…"
                    : "Ask me to build something…"
                }
                disabled={!canChat}
                className="max-h-40 flex-1 resize-none bg-transparent px-2 py-1.5 text-sm outline-none placeholder:text-zinc-600 disabled:opacity-50"
              />
              {busy ? (
                <button
                  onClick={stop}
                  title="Force stop"
                  className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-rose-600 text-white transition hover:bg-rose-500"
                >
                  <Square size={15} fill="currentColor" />
                </button>
              ) : (
                <button
                  onClick={send}
                  disabled={(!input.trim() && attachments.length === 0) || !canChat}
                  className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-sky-600 text-white transition hover:bg-sky-500 disabled:opacity-40"
                >
                  <SendHorizontal size={16} />
                </button>
              )}
            </div>
          </div>
          <p className="mx-auto mt-1.5 max-w-3xl text-center text-[11px] text-zinc-600">
            {busy ? "Running — click the red stop button to force exit" : "Enter to send · Shift+Enter for newline"}
          </p>
        </div>
      </main>

      <ResizeHandle width={rightWidth} setWidth={setRightWidth} dir={-1} />
      <TurnLog
        width={rightWidth}
        turns={turns}
        safetyIdentifier={chat?.safetyIdentifier}
        onExport={exportTurnLog}
      />

      <NewChatModal
        open={showNewChat}
        onClose={() => setShowNewChat(false)}
        onCreate={(seed) => {
          createChat(seed);
          setShowNewChat(false);
        }}
        apiKeys={apiKeys}
        addKey={addKey}
        removeKey={removeKey}
        defaults={chat || {}}
      />
    </div>
  );
}
