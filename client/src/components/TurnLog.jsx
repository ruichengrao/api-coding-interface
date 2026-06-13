import { useState } from "react";
import { ScrollText, Copy, Check, ShieldCheck, ShieldOff, Download } from "lucide-react";

function CopyBtn({ value }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      onClick={() => {
        navigator.clipboard.writeText(value);
        setCopied(true);
        setTimeout(() => setCopied(false), 1200);
      }}
      className="text-zinc-500 hover:text-zinc-200"
      title="Copy"
    >
      {copied ? <Check size={12} className="text-emerald-400" /> : <Copy size={12} />}
    </button>
  );
}

function IdRow({ label, value }) {
  if (!value) return null;
  return (
    <div className="flex items-center gap-1.5">
      <span className="w-14 shrink-0 text-zinc-500">{label}</span>
      <code className="flex-1 truncate text-zinc-300">{value}</code>
      <CopyBtn value={value} />
    </div>
  );
}

function SafetyIdentifierCard({ enabled, value }) {
  return (
    <div
      className={`rounded-xl border p-3 text-xs ${
        enabled
          ? "border-emerald-500/20 bg-emerald-500/[0.04]"
          : "border-white/10 bg-white/[0.02]"
      }`}
    >
      <div
        className={`mb-2 flex items-center gap-1.5 font-semibold ${
          enabled ? "text-emerald-300" : "text-zinc-400"
        }`}
      >
        {enabled ? <ShieldCheck size={13} /> : <ShieldOff size={13} />} Safety Identifier
      </div>
      {enabled && value ? (
        <div className="flex items-center gap-1.5 rounded-lg bg-black/30 p-2">
          <code className="min-w-0 flex-1 truncate text-zinc-300">{value}</code>
          <CopyBtn value={value} />
        </div>
      ) : enabled ? (
        <div className="flex items-center gap-1.5 rounded-lg bg-black/30 p-2 text-zinc-500">
          <ShieldOff size={12} /> Enabled, not set
        </div>
      ) : (
        <div className="flex items-center gap-1.5 rounded-lg bg-black/30 p-2 text-zinc-500">
          <ShieldOff size={12} /> Disabled for this chat
        </div>
      )}
    </div>
  );
}

export default function TurnLog({ width, turns, safetyIdentifierEnabled, safetyIdentifier, onExport }) {
  return (
    <aside
      style={{ width }}
      className="shrink-0 border-l border-white/10 bg-[#0c0c0e] overflow-y-auto"
    >
      <div className="sticky top-0 z-10 flex items-center gap-2 border-b border-white/10 bg-[#0c0c0e] px-4 py-3 text-sm font-semibold">
        <ScrollText size={15} className="text-zinc-400" /> Turn Log
        <button
          onClick={onExport}
          disabled={turns.length === 0}
          title="Download turn log as .csv"
          className="ml-auto flex items-center gap-1 rounded-md border border-white/10 px-2 py-1 text-xs font-normal hover:bg-white/5 disabled:opacity-40"
        >
          <Download size={12} /> .csv
        </button>
        <span className="text-xs font-normal text-zinc-500">{turns.length}</span>
      </div>

      <div className="p-3 space-y-3">
        <SafetyIdentifierCard enabled={safetyIdentifierEnabled} value={safetyIdentifier} />

        {turns.length === 0 && (
          <p className="px-1 text-xs text-zinc-500">
            Request and response IDs for each turn appear here.
          </p>
        )}

        {turns.map((turn, i) => (
          <div key={turn.id} className="rounded-xl border border-white/10 bg-white/[0.02] p-3 text-xs">
            <div className="mb-2 flex items-center justify-between">
              <span className="font-semibold text-zinc-300">Turn {i + 1}</span>
              <span className="text-zinc-500">{turn.time}</span>
            </div>

            <div className="mb-2 flex flex-wrap items-center gap-2">
              <span className="rounded bg-white/10 px-1.5 py-0.5 text-[10px] text-zinc-300">
                {turn.keyLabel}
              </span>
              <span className="rounded bg-white/10 px-1.5 py-0.5 font-mono text-[10px] text-zinc-300">
                {turn.model}
              </span>
              <span
                className={`flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] ${
                  turn.safetyIdentifier
                    ? "bg-emerald-500/15 text-emerald-300"
                    : "bg-zinc-500/15 text-zinc-400"
                }`}
                title={turn.safetyIdentifier || "safety_identifier not sent"}
              >
                {turn.safetyIdentifier ? <ShieldCheck size={11} /> : <ShieldOff size={11} />}
                {turn.safetyIdentifier ? "safety id" : "no safety id"}
              </span>
            </div>

            <div className="space-y-2">
              {turn.calls.map((c, ci) => (
                <div key={ci} className="space-y-1 rounded-lg bg-black/30 p-2">
                  {turn.calls.length > 1 && (
                    <div className="text-[10px] text-zinc-500">API call {ci + 1}</div>
                  )}
                  <IdRow label="request" value={c.request_id} />
                  <IdRow label="response" value={c.response_id} />
                  {c.status && (
                    <div className="flex items-center gap-1.5 text-[10px] text-rose-300">
                      <span className="w-14 shrink-0 text-zinc-500">status</span>
                      <span>{c.status}</span>
                    </div>
                  )}
                  {c.error && (
                    <div className="flex items-start gap-1.5 text-[10px] text-rose-300">
                      <span className="w-14 shrink-0 text-zinc-500">error</span>
                      <span className="min-w-0 flex-1 break-words">{c.error}</span>
                    </div>
                  )}
                  {c.usage && (
                    <div className="flex items-center gap-1.5 text-[10px] text-zinc-500">
                      <span className="w-14 shrink-0">tokens</span>
                      <span>
                        in {c.usage.input_tokens ?? "?"} / out {c.usage.output_tokens ?? "?"}
                      </span>
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </aside>
  );
}
