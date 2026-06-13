import { useState } from "react";
import {
  Trash2,
  Globe,
  AlertTriangle,
  Zap,
  Hand,
  MessageSquare,
  MessageSquarePlus,
  Pencil,
} from "lucide-react";

function Section({ title, icon: Icon, children }) {
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-zinc-500">
        <Icon size={13} /> {title}
      </div>
      {children}
    </div>
  );
}

function relTime(ts) {
  if (!ts) return "";
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d}d ago`;
  return new Date(ts).toLocaleDateString();
}

export default function Sidebar({
  width,
  chats,
  activeChatId,
  onNewChat,
  onSwitchChat,
  onRenameChat,
  onDeleteChat,
  settings,
  update,
  activeKey,
}) {
  const [editingId, setEditingId] = useState(null);
  const [editVal, setEditVal] = useState("");

  const startRename = (chat) => {
    setEditingId(chat.id);
    setEditVal(chat.title);
  };
  const commitRename = () => {
    if (editingId) onRenameChat(editingId, editVal);
    setEditingId(null);
    setEditVal("");
  };

  const sortedChats = [...chats].sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));

  return (
    <aside
      style={{ width }}
      className="shrink-0 border-r border-white/10 bg-[#0c0c0e] overflow-y-auto p-4 space-y-5"
    >
      <div className="flex items-center gap-2">
        <div className="grid place-items-center w-8 h-8 rounded-lg bg-gradient-to-br from-sky-500 to-indigo-600">
          <Zap size={16} className="text-white" />
        </div>
        <div>
          <div className="font-semibold leading-tight">Codex Local</div>
          <div className="text-xs text-zinc-500 leading-tight">Agentic coding assistant</div>
        </div>
      </div>

      {/* CHATS */}
      <div className="space-y-2">
        <button
          onClick={onNewChat}
          className="flex w-full items-center justify-center gap-1.5 rounded-lg bg-sky-600 px-3 py-2 text-sm font-medium text-white transition hover:bg-sky-500"
        >
          <MessageSquarePlus size={15} /> New chat
        </button>

        <div className="max-h-64 space-y-1 overflow-y-auto pr-0.5">
          {sortedChats.map((c) => {
            const active = c.id === activeChatId;
            return (
              <div
                key={c.id}
                className={`group flex items-center gap-2 rounded-lg border px-2.5 py-1.5 ${
                  active
                    ? "border-sky-500/60 bg-sky-500/10"
                    : "border-transparent hover:border-white/10 hover:bg-white/5"
                }`}
              >
                <MessageSquare size={14} className="shrink-0 text-zinc-500" />
                {editingId === c.id ? (
                  <input
                    autoFocus
                    value={editVal}
                    onChange={(e) => setEditVal(e.target.value)}
                    onBlur={commitRename}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") commitRename();
                      if (e.key === "Escape") {
                        setEditingId(null);
                        setEditVal("");
                      }
                    }}
                    className="min-w-0 flex-1 rounded border border-white/10 bg-black/40 px-1.5 py-0.5 text-sm outline-none focus:border-sky-500/60"
                  />
                ) : (
                  <button
                    onClick={() => onSwitchChat(c.id)}
                    onDoubleClick={() => startRename(c)}
                    className="min-w-0 flex-1 text-left"
                    title={c.title}
                  >
                    <div className="truncate text-sm text-zinc-200">{c.title}</div>
                    <div className="text-[10px] text-zinc-500">{relTime(c.updatedAt)}</div>
                  </button>
                )}
                {editingId !== c.id && (
                  <div className="flex shrink-0 items-center gap-1 opacity-0 transition group-hover:opacity-100">
                    <button
                      onClick={() => startRename(c)}
                      title="Rename chat"
                      className="text-zinc-500 hover:text-zinc-200"
                    >
                      <Pencil size={13} />
                    </button>
                    <button
                      onClick={() => onDeleteChat(c.id)}
                      title="Delete chat"
                      className="text-zinc-500 hover:text-rose-400"
                    >
                      <Trash2 size={13} />
                    </button>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {settings ? (
        <>
          {/* SESSION CONTROLS divider — live toggles for the active chat */}
          <div className="space-y-1 pt-1">
            <div className="flex items-center gap-2">
              <span className="text-[10px] font-semibold uppercase tracking-wider text-zinc-500">
                Session controls
              </span>
              <div className="h-px flex-1 bg-white/10" />
            </div>
            <p className="text-[11px] text-zinc-600">
              Live toggles for the current chat. Key, model, workspace, and optional safety ID are
              set when you create it.
            </p>
          </div>

          {/* OUTSIDE WORKSPACE ACCESS */}
          <Section title="Outside Workspace" icon={Globe}>
            <label className="flex items-center justify-between rounded-lg border border-white/10 px-2.5 py-2">
              <span className="text-sm">Allow parent/outside paths</span>
              <button
                onClick={() => update({ allowOutsideWorkspace: !settings.allowOutsideWorkspace })}
                className={`relative h-5 w-9 shrink-0 rounded-full transition-colors ${
                  settings.allowOutsideWorkspace ? "bg-sky-500" : "bg-zinc-700"
                }`}
              >
                <span
                  className={`absolute left-0.5 top-0.5 h-4 w-4 rounded-full bg-white transition-transform ${
                    settings.allowOutsideWorkspace ? "translate-x-4" : "translate-x-0"
                  }`}
                />
              </button>
            </label>
            <p className="text-[11px] text-zinc-500">
              {settings.allowOutsideWorkspace
                ? "Child folders are always allowed. Parent or outside paths can run only after your approval, even in Auto-run."
                : "Child folders are allowed by default. Parent or outside paths are blocked."}
            </p>
          </Section>

          {/* APPROVAL MODE */}
          <Section title="Command Approval" icon={Hand}>
            <div className="grid grid-cols-2 gap-1.5">
              {[
                { id: "manual", label: "Ask first", icon: Hand },
                { id: "auto", label: "Auto-run", icon: Zap },
              ].map((m) => (
                <button
                  key={m.id}
                  onClick={() => update({ approvalMode: m.id })}
                  className={`flex items-center justify-center gap-1.5 rounded-lg border px-2 py-2 text-sm ${
                    settings.approvalMode === m.id
                      ? "border-sky-500/60 bg-sky-500/10"
                      : "border-white/10 hover:border-white/20"
                  }`}
                >
                  <m.icon size={14} /> {m.label}
                </button>
              ))}
            </div>
            <p className="text-[11px] text-zinc-500">
              {settings.approvalMode === "manual"
                ? "File edits run automatically; you approve each command."
                : "Commands run without prompting. Use with care."}
            </p>
          </Section>

          {!activeKey && (
            <div className="flex items-start gap-2 rounded-lg border border-amber-500/40 bg-amber-500/10 p-2.5 text-xs text-amber-300">
              <AlertTriangle size={14} className="mt-0.5 shrink-0" />
              This chat has no key. Start a new chat to add and pick one.
            </div>
          )}
        </>
      ) : (
        <div className="rounded-lg border border-white/10 bg-white/[0.03] p-3 text-xs text-zinc-500">
          No chats yet.
        </div>
      )}
    </aside>
  );
}
