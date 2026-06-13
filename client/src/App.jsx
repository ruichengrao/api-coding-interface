import { memo, useCallback, useMemo, useRef, useState, useEffect, useLayoutEffect } from "react";
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
import { streamChat, approveToolCall, inspectApiKey } from "./lib/agentClient";
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

const csvHeaders = [
  "turn_number",
  "time",
  "chat_title",
  "key",
  "model",
  "api_email",
  "api_organization_id",
  "safety_identifier",
  "api_call_count",
  "request_ids",
  "response_ids",
  "statuses",
  "errors",
  "input_tokens",
  "output_tokens",
  "request",
  "response",
  "attachments",
  "tool_activity",
];

const csvCell = (value) => {
  const text = String(value ?? "");
  const safe = /^[=+\-@]/.test(text.trimStart()) ? `'${text}` : text;
  return `"${safe.replace(/"/g, '""')}"`;
};

const csvLine = (values) => values.map(csvCell).join(",");

const attachmentPlaceholder = (attachment) =>
  `[attachment:${attachment?.kind || "file"}:${attachment?.name || "unnamed"}]`;

const toolPlaceholder = (tool) => {
  const status = tool.status ? ` (${tool.status})` : "";
  if (tool.name === "read_file") return `read_file [local file omitted]${status}`;
  if (tool.name === "write_file") {
    return `write_file [local file omitted] [content omitted]${status}`;
  }
  if (tool.name === "list_dir") return `list_dir [local directory omitted]${status}`;
  if (tool.name === "run_command") return `run_command [command omitted]${status}`;
  return `${tool.name || "tool"} [details omitted]${status}`;
};

function buildTurnTranscripts(messages, turns) {
  const segments = [];
  let current = null;

  for (const message of messages) {
    if (message.role === "user") {
      current = { user: message, assistant: [], tools: [], notices: [] };
      segments.push(current);
    } else if (current && message.role === "assistant") {
      current.assistant.push(message);
    } else if (current && message.type === "tool") {
      current.tools.push(message);
    } else if (current && message.type === "notice") {
      current.notices.push(message);
    }
  }

  return turns.map((turn, index) => {
    const segment = segments.find((s) => s.user?.id === turn.userMessageId) || segments[index] || {};
    const userMessage = segment.user || null;
    const attachments = userMessage?.attachments || [];
    const attachmentText = attachments.map(attachmentPlaceholder).join("\n");
    const request = [userMessage?.text || "", attachmentText].filter(Boolean).join("\n");
    const assistantText = (segment.assistant || []).map((m) => m.text || "").filter(Boolean).join("\n\n");
    const noticeText = (segment.notices || []).map((m) => `[notice: ${m.text}]`).join("\n");
    const errorText = (turn.calls || []).map((c) => c.error).filter(Boolean).map((e) => `[error: ${e}]`).join("\n");
    const response = assistantText || noticeText || errorText || "";

    return {
      request,
      response,
      attachments: attachmentText,
      toolActivity: (segment.tools || []).map(toolPlaceholder).join("\n"),
    };
  });
}

const PANEL_DEFAULT = 320;
const PANEL_MIN = 220;
const PANEL_MAX = 560;
const COMPOSER_MAX_HEIGHT = 160;
const INITIAL_VISIBLE_MESSAGES = 140;
const MESSAGE_PAGE_SIZE = 100;

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

const MessageRow = memo(function MessageRow({ message, onApprove, onReject }) {
  if (message.type === "notice") {
    return (
      <div className="mx-auto w-fit rounded-full border border-white/10 bg-white/5 px-3 py-1 text-xs text-zinc-400">
        {message.text}
      </div>
    );
  }

  if (message.type === "tool") {
    return (
      <div className="ml-9">
        <ToolCard tool={message} onApprove={onApprove} onReject={onReject} />
      </div>
    );
  }

  const isUser = message.role === "user";
  return (
    <div className="flex gap-3">
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
            {message.text && (
              <p className="whitespace-pre-wrap text-[0.92rem] leading-relaxed text-zinc-200">
                {message.text}
              </p>
            )}
            {message.attachments?.length > 0 && (
              <div className="mt-1.5 flex flex-wrap gap-1.5">
                {message.attachments.map((a, i) => (
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
          <Markdown>{message.text}</Markdown>
        )}
      </div>
    </div>
  );
});

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
  const [visibleMessageCount, setVisibleMessageCount] = useState(INITIAL_VISIBLE_MESSAGES);

  // The active chat is the single source of truth for the conversation, its
  // turn log, and its settings.
  const chat = activeChat;
  const messages = chat?.messages || [];
  const turns = chat?.turns || [];
  const visibleMessages = useMemo(
    () => messages.slice(Math.max(0, messages.length - visibleMessageCount)),
    [messages, visibleMessageCount]
  );
  const hiddenMessageCount = messages.length - visibleMessages.length;

  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");
  const [error, setError] = useState(null);

  const [leftWidth, setLeftWidth] = useState(() => loadWidth("left"));
  const [rightWidth, setRightWidth] = useState(() => loadWidth("right"));

  const [attachments, setAttachments] = useState([]);
  const fileInputRef = useRef(null);
  const textareaRef = useRef(null);

  const streamChatId = useRef(null); // chat the in-flight stream writes to
  const scrollRef = useRef(null);
  const abortRef = useRef(null);
  const identityCheckRef = useRef(new Set());
  const stickToBottomRef = useRef(true);

  useEffect(() => {
    const scroller = scrollRef.current;
    if (!scroller || !stickToBottomRef.current) return;
    requestAnimationFrame(() => {
      scroller.scrollTo({ top: scroller.scrollHeight, behavior: "auto" });
    });
  }, [messages, status]);

  const onChatScroll = useCallback((e) => {
    const el = e.currentTarget;
    stickToBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 180;
  }, []);

  useLayoutEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;

    textarea.style.height = "auto";
    const height = Math.min(textarea.scrollHeight, COMPOSER_MAX_HEIGHT);
    textarea.style.height = `${height}px`;
    textarea.style.overflowY = textarea.scrollHeight > COMPOSER_MAX_HEIGHT ? "auto" : "hidden";
  }, [input]);

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
    setVisibleMessageCount(INITIAL_VISIBLE_MESSAGES);
  }, [activeChatId]);

  // Pre-fill the workspace folder from the server default for the first chat.
  useEffect(() => {
    if (!activeChat || activeChat.workspaceRoot?.trim()) return;
    fetch("/api/default-workspace")
      .then((r) => r.json())
      .then((d) => {
        if (d?.path) updateActive({ workspaceRoot: d.path });
      })
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!chat || !activeKey) return;
    if (chat.apiIdentity?.keyId === activeKey.id && chat.apiIdentity?.checkedAt) return;

    const cacheKey = `${activeChatId}:${activeKey.id}`;
    if (identityCheckRef.current.has(cacheKey)) return;
    identityCheckRef.current.add(cacheKey);

    let canceled = false;
    inspectApiKey(activeKey.key)
      .then((identity) => {
        if (canceled) return;
        updateChat(activeChatId, {
          apiIdentity: { ...identity, keyId: activeKey.id, keyLabel: activeKey.label },
        });
      })
      .catch(() => {});

    return () => {
      canceled = true;
    };
  }, [
    activeChatId,
    activeKey,
    chat,
    updateChat,
  ]);

  const patchTool = useCallback((chatId, callId, patch) =>
    updateChat(chatId, (c) => ({
      messages: c.messages.map((m) =>
        m.type === "tool" && m.call_id === callId ? { ...m, ...patch } : m
      ),
    })), [updateChat]);

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

  const ensureApiIdentity = async (chatId) => {
    const cached = chat?.apiIdentity;
    if (cached?.keyId === activeKey?.id && cached.checkedAt) {
      return cached;
    }

    const identity = await inspectApiKey(activeKey.key);
    const apiIdentity = { ...identity, keyId: activeKey.id, keyLabel: activeKey.label };
    updateChat(chatId, { apiIdentity });
    return apiIdentity;
  };

  const send = async () => {
    const text = input.trim();
    if ((!text && attachments.length === 0) || busy) return;
    if (!chat) {
      setError("Create a chat before sending a prompt.");
      return;
    }
    if (!activeKey) {
      setError("Choose an API key for this chat in the sidebar first.");
      return;
    }
    if (!chat.workspaceValidated) {
      setError("Validate this chat's workspace folder in the sidebar before chatting.");
      return;
    }

    const chatId = activeChatId;
    setError(null);
    setBusy(true);
    setStatus("Checking API key…");

    let apiIdentity;
    try {
      apiIdentity = await ensureApiIdentity(chatId);
    } catch (e) {
      setError(e.message);
      setBusy(false);
      setStatus("");
      return;
    }

    streamChatId.current = chatId;
    const sentAttachments = attachments;
    const safetyId = chat.safetyIdentifierEnabled ? chat.safetyIdentifier || null : null;
    const turnId = nextId("turn");
    const userMessageId = nextId("msg");

    stickToBottomRef.current = true;
    setInput("");
    setAttachments([]);
    setStatus("Thinking…");

    // Append the user message + a new turn-log entry; title the chat from the
    // first message.
    updateChat(chatId, (c) => ({
      title: c.messages.length === 0 ? deriveTitle(text) : c.title,
      messages: [
        ...c.messages,
        {
          id: userMessageId,
          role: "user",
          text,
          attachments: sentAttachments.map((a) => ({ name: a.name, kind: a.kind })),
        },
      ],
      turns: [
        ...c.turns,
        {
          id: turnId,
          userMessageId,
          time: new Date().toLocaleTimeString(),
          keyLabel: activeKey.label,
          apiIdentity,
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
            const failedCall = {
              request_id: d.request_id || null,
              response_id: null,
              model: chat.model,
              usage: null,
              status: d.status || null,
              error: d.message || "Request failed.",
            };
            updateChat(chatId, (c) => ({
              turns: c.turns.map((t) => {
                if (t.id !== turnId) return t;
                const existingIndex = failedCall.request_id
                  ? t.calls.findIndex((call) => call.request_id === failedCall.request_id)
                  : -1;
                if (existingIndex === -1) return { ...t, calls: [...t.calls, failedCall] };
                return {
                  ...t,
                  calls: t.calls.map((call, i) =>
                    i === existingIndex ? { ...call, ...failedCall } : call
                  ),
                };
              }),
            }));
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

  const handleApprove = useCallback(async (callId) => {
    patchTool(streamChatId.current, callId, { status: "running" });
    setStatus("Thinking…");
    await approveToolCall(callId, true);
  }, [patchTool]);
  const handleReject = useCallback(async (callId) => {
    await approveToolCall(callId, false);
  }, []);

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
    if (!chat || messages.length === 0) return;
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
    if (!chat || turns.length === 0) return;
    const transcripts = buildTurnTranscripts(messages, turns);
    const rows = turns.map((turn, i) => {
      const calls = Array.isArray(turn.calls) ? turn.calls : [];
      const apiIdentity = turn.apiIdentity || chat.apiIdentity || {};
      const inputTokens = calls.reduce((sum, c) => sum + (Number(c.usage?.input_tokens) || 0), 0);
      const outputTokens = calls.reduce((sum, c) => sum + (Number(c.usage?.output_tokens) || 0), 0);
      const transcript = transcripts[i] || {};

      return [
        i + 1,
        turn.time || "",
        chat.title || "",
        turn.keyLabel || "",
        turn.model || "",
        apiIdentity.email || "",
        apiIdentity.organizationId || "",
        turn.safetyIdentifier || "",
        calls.length,
        calls.map((c) => c.request_id).filter(Boolean).join("\n"),
        calls.map((c) => c.response_id).filter(Boolean).join("\n"),
        calls.map((c) => c.status).filter(Boolean).join("\n"),
        calls.map((c) => c.error).filter(Boolean).join("\n"),
        inputTokens || "",
        outputTokens || "",
        transcript.request || "",
        transcript.response || "",
        transcript.attachments || "",
        transcript.toolActivity || "",
      ];
    });
    const csv = "\ufeff" + [csvLine(csvHeaders), ...rows.map(csvLine)].join("\r\n");
    download(`turn-log-${stamp()}.csv`, csv, "text/csv;charset=utf-8");
  };

  const canChat = Boolean(activeKey && chat?.workspaceValidated);

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
            <div className="truncate font-semibold">{chat?.title || "No chat selected"}</div>
            <div className="text-xs text-zinc-500">
              {chat ? `${activeKey ? activeKey.label : "no key selected"} · ${chat.model}` : "create a chat to begin"}
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

        <div ref={scrollRef} onScroll={onChatScroll} className="flex-1 overflow-y-auto px-5 py-6">
          <div className="mx-auto max-w-3xl space-y-5">
            {!chat && (
              <div className="mt-20 text-center text-zinc-500">
                <Bot size={32} className="mx-auto mb-3 text-zinc-600" />
                <p className="text-lg font-medium text-zinc-300">No chats yet</p>
                <button
                  onClick={() => setShowNewChat(true)}
                  className="mx-auto mt-4 flex items-center gap-1.5 rounded-lg bg-sky-600 px-3 py-2 text-sm font-medium text-white transition hover:bg-sky-500"
                >
                  <Plus size={14} /> Create chat
                </button>
              </div>
            )}

            {chat && messages.length === 0 && (
              <div className="mt-20 text-center text-zinc-500">
                <Bot size={32} className="mx-auto mb-3 text-zinc-600" />
                <p className="text-lg font-medium text-zinc-300">Start vibe coding</p>
                <p className="mt-1 text-sm">
                  Pick a key and a workspace folder in the sidebar, then ask me to build, edit, or run your project.
                </p>
              </div>
            )}

            {hiddenMessageCount > 0 && (
              <button
                onClick={() => setVisibleMessageCount((count) => count + MESSAGE_PAGE_SIZE)}
                className="mx-auto flex items-center justify-center rounded-lg border border-white/10 px-3 py-1.5 text-xs text-zinc-400 hover:bg-white/5 hover:text-zinc-200"
              >
                Show {Math.min(MESSAGE_PAGE_SIZE, hiddenMessageCount)} older messages
              </button>
            )}

            {visibleMessages.map((m) => (
              <MessageRow
                key={m.id}
                message={m}
                onApprove={handleApprove}
                onReject={handleReject}
              />
            ))}

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

        {chat && (
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
                ref={textareaRef}
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
                className="max-h-40 min-h-8 flex-1 resize-none bg-transparent px-2 py-1.5 text-sm leading-5 outline-none placeholder:text-zinc-600 disabled:opacity-50"
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
        )}
      </main>

      <ResizeHandle width={rightWidth} setWidth={setRightWidth} dir={-1} />
      <TurnLog
        width={rightWidth}
        turns={turns}
        apiIdentity={chat?.apiIdentity}
        safetyIdentifierEnabled={chat?.safetyIdentifierEnabled}
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
