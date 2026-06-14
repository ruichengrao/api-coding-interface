import { useState } from "react";
import {
  FileText,
  FilePen,
  FolderTree,
  TerminalSquare,
  Search,
  Files,
  Pencil,
  ChevronRight,
  Check,
  X,
  Loader2,
  Globe,
  Copy,
} from "lucide-react";

const ICONS = {
  read_file: FileText,
  write_file: FilePen,
  list_dir: FolderTree,
  file_tree: FolderTree,
  search_files: Search,
  read_many_files: Files,
  edit_file: Pencil,
  run_command: TerminalSquare,
};

const LABELS = {
  read_file: "Read file",
  write_file: "Write file",
  list_dir: "List directory",
  file_tree: "File tree",
  search_files: "Search files",
  read_many_files: "Read files",
  edit_file: "Edit file",
  run_command: "Run command",
};

function summarize(name, args) {
  const a = args || {};
  if (name === "run_command") return a.command;
  if (name === "search_files") return a.query;
  if (name === "read_many_files") return Array.isArray(a.paths) ? a.paths.join(", ") : "";
  if (name === "write_file" || name === "edit_file") return a.path;
  return a.path;
}

function DetailBlock({ label, value, mono = true }) {
  const [copied, setCopied] = useState(false);
  if (value == null || value === "") return null;

  const copy = (e) => {
    e.stopPropagation();
    navigator.clipboard.writeText(String(value));
    setCopied(true);
    setTimeout(() => setCopied(false), 1200);
  };

  return (
    <div className="rounded-lg border border-white/10 bg-[#0d1117]">
      <div className="flex items-center gap-2 border-b border-white/10 px-2 py-1.5 text-[10px] uppercase tracking-wide text-zinc-500">
        <span>{label}</span>
        <button
          onClick={copy}
          className="ml-auto flex items-center gap-1 rounded px-1.5 py-0.5 normal-case tracking-normal text-zinc-400 hover:bg-white/5 hover:text-zinc-200"
          title={`Copy ${label}`}
        >
          {copied ? <Check size={12} className="text-emerald-400" /> : <Copy size={12} />}
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <pre
        className={`max-h-60 overflow-auto p-2 text-xs whitespace-pre-wrap break-words ${
          mono ? "font-mono" : "font-sans"
        }`}
      >
        {value}
      </pre>
    </div>
  );
}

export default function ToolCard({ tool, onApprove, onReject }) {
  const [open, setOpen] = useState(tool.name === "run_command" || tool.name === "write_file");
  const Icon = ICONS[tool.name] || TerminalSquare;
  const pending = tool.status === "pending_approval";
  const running = tool.status === "running";
  const rejected = tool.status === "rejected";

  return (
    <div
      className={`rounded-xl border text-sm overflow-hidden ${
        pending
          ? "border-amber-500/50 bg-amber-500/5"
          : "border-white/10 bg-white/[0.03]"
      }`}
    >
      <button
        onClick={() => setOpen((o) => !o)}
        className="w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-white/[0.03]"
      >
        <ChevronRight
          size={14}
          className={`shrink-0 text-zinc-500 transition-transform ${open ? "rotate-90" : ""}`}
        />
        <Icon size={15} className="shrink-0 text-zinc-400" />
        <span className="font-medium text-zinc-300">{LABELS[tool.name] || tool.name}</span>
        <code className="truncate text-zinc-500 text-xs" title={summarize(tool.name, tool.arguments)}>
          {summarize(tool.name, tool.arguments)}
        </code>
        {tool.outside && (
          <span
            title="Reaches outside the workspace folder"
            className="flex shrink-0 items-center gap-1 rounded-full border border-amber-500/40 bg-amber-500/10 px-1.5 py-0.5 text-[10px] font-medium text-amber-400"
          >
            <Globe size={10} /> outside
          </span>
        )}
        <span className="ml-auto shrink-0">
          {running && <Loader2 size={14} className="animate-spin text-sky-400" />}
          {tool.status === "done" && <Check size={14} className="text-emerald-400" />}
          {rejected && <X size={14} className="text-rose-400" />}
          {pending && <span className="text-xs text-amber-400">approval needed</span>}
        </span>
      </button>

      {open && (
        <div className="px-3 pb-3 space-y-2">
          {tool.name === "run_command" && (
            <DetailBlock label="command" value={tool.arguments?.command} />
          )}
          {tool.name === "write_file" && tool.arguments?.content != null && (
            <DetailBlock label="content" value={tool.arguments.content} />
          )}
          {tool.result != null && (
            <DetailBlock label="result" value={tool.result} />
          )}
        </div>
      )}

      {pending && (
        <div className="flex gap-2 px-3 pb-3">
          <button
            onClick={() => onApprove(tool.call_id)}
            className="flex items-center gap-1 rounded-lg bg-emerald-600 hover:bg-emerald-500 px-3 py-1.5 text-xs font-medium text-white"
          >
            <Check size={13} /> Approve & run
          </button>
          <button
            onClick={() => onReject(tool.call_id)}
            className="flex items-center gap-1 rounded-lg bg-zinc-700 hover:bg-zinc-600 px-3 py-1.5 text-xs font-medium text-white"
          >
            <X size={13} /> Reject
          </button>
        </div>
      )}
    </div>
  );
}
