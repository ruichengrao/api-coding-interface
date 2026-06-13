import { useEffect, useState } from "react";
import {
  X,
  KeyRound,
  Zap,
  FolderOpen,
  FolderSearch,
  ShieldCheck,
  ShieldOff,
  RefreshCw,
  Check,
  AlertTriangle,
  MessageSquarePlus,
  Plus,
  Trash2,
} from "lucide-react";
import { validateWorkspace, browseFolder, inspectApiKey } from "../lib/agentClient";
import { randomHex } from "../lib/useSettings";

// Guided setup shown each time the user starts a new chat: manage/pick a key,
// model, workspace, and optionally enable a safety identifier for the conversation.
export default function NewChatModal({ open, onClose, onCreate, apiKeys, addKey, removeKey, defaults }) {
  const [keyId, setKeyId] = useState(null);
  const [model, setModel] = useState("gpt-5.5");
  const [workspaceRoot, setWorkspaceRoot] = useState("");
  const [validated, setValidated] = useState(false);
  const [wsStatus, setWsStatus] = useState(null);
  const [keyStatus, setKeyStatus] = useState(null);
  const [safetyIdentifierEnabled, setSafetyIdentifierEnabled] = useState(false);
  const [safetyIdentifier, setSafetyIdentifier] = useState("");
  const [newLabel, setNewLabel] = useState("");
  const [newKey, setNewKey] = useState("");

  // (Re)initialize the form whenever the panel opens, inheriting the current
  // chat's key/model/workspace. The safety identifier toggle starts off for each
  // new conversation; enabling it generates a fresh id.
  useEffect(() => {
    if (!open) return;
    setKeyId(defaults?.keyId ?? apiKeys[0]?.id ?? null);
    setModel(defaults?.model || "gpt-5.5");
    setWorkspaceRoot(defaults?.workspaceRoot || "");
    setValidated(false);
    setWsStatus(null);
    setKeyStatus(null);
    setSafetyIdentifierEnabled(false);
    setSafetyIdentifier("");
    setNewLabel("");
    setNewKey("");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Close on Escape.
  useEffect(() => {
    if (!open) return;
    const onKey = (e) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  const onPathChange = (v) => {
    setWorkspaceRoot(v);
    setValidated(false);
    setWsStatus(null);
  };

  const validate = async () => {
    setWsStatus({ checking: true });
    const r = await validateWorkspace(workspaceRoot);
    setValidated(!!r.ok);
    setWsStatus(r.ok ? null : r);
  };

  const browse = async () => {
    setWsStatus({ checking: true });
    const r = await browseFolder();
    if (r.path) {
      setWorkspaceRoot(r.path);
      setValidated(true);
      setWsStatus(null);
    } else if (r.canceled) {
      setWsStatus(null);
    } else {
      setWsStatus({ ok: false, error: r.error || "Could not open the folder picker." });
    }
  };

  const addNewKey = () => {
    if (!newKey.trim()) return;
    const id = addKey(newLabel.trim(), newKey.trim());
    setKeyId(id); // select the key we just added
    setKeyStatus(null);
    setNewLabel("");
    setNewKey("");
  };

  const removeOneKey = (id) => {
    removeKey(id);
    setKeyStatus(null);
    if (keyId === id) setKeyId(apiKeys.find((k) => k.id !== id)?.id ?? null);
  };

  const toggleSafetyIdentifier = () => {
    setSafetyIdentifierEnabled((enabled) => {
      const next = !enabled;
      if (next && !safetyIdentifier) setSafetyIdentifier(randomHex());
      return next;
    });
  };

  const canCreate = validated && !!keyId;

  const create = async () => {
    if (!canCreate) return;
    const selectedKey = apiKeys.find((k) => k.id === keyId);
    if (!selectedKey) {
      setKeyStatus({ ok: false, error: "Choose an API key before creating a chat." });
      return;
    }

    setKeyStatus({ checking: true });
    let apiIdentity;
    try {
      apiIdentity = await inspectApiKey(selectedKey.key);
    } catch (e) {
      setKeyStatus({ ok: false, error: e.message });
      return;
    }

    const nextSafetyIdentifier = safetyIdentifierEnabled ? safetyIdentifier || randomHex() : "";
    onCreate({
      keyId,
      model,
      workspaceRoot,
      workspaceValidated: true,
      apiIdentity: { ...apiIdentity, keyId: selectedKey.id, keyLabel: selectedKey.label },
      safetyIdentifierEnabled,
      safetyIdentifier: nextSafetyIdentifier,
    });
    setKeyStatus(null);
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      onMouseDown={onClose}
    >
      <div
        className="w-full max-w-lg overflow-hidden rounded-2xl border border-white/10 bg-[#0c0c0e] shadow-2xl"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 border-b border-white/10 px-5 py-3">
          <MessageSquarePlus size={16} className="text-sky-400" />
          <div className="font-semibold">New chat</div>
          <button onClick={onClose} className="ml-auto text-zinc-500 hover:text-zinc-200" title="Close">
            <X size={16} />
          </button>
        </div>

        <div className="max-h-[70vh] space-y-5 overflow-y-auto p-5">
          {/* API key — full management lives here: select, remove, or add */}
          <div className="space-y-2">
            <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-zinc-500">
              <KeyRound size={13} /> API Key
            </div>
            {apiKeys.length === 0 ? (
              <p className="text-xs text-amber-400/80">No keys yet — add one below to continue.</p>
            ) : (
              <div className="space-y-1.5">
                {apiKeys.map((k) => (
                  <div
                    key={k.id}
                    className={`flex items-center gap-2 rounded-lg border px-2.5 py-2 ${
                      keyId === k.id ? "border-sky-500/60 bg-sky-500/10" : "border-white/10 hover:border-white/20"
                    }`}
                  >
                    <label className="flex min-w-0 flex-1 cursor-pointer items-center gap-2">
                      <input
                        type="radio"
                        name="newChatKey"
                        className="accent-sky-500"
                        checked={keyId === k.id}
                        onChange={() => {
                          setKeyId(k.id);
                          setKeyStatus(null);
                        }}
                      />
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-sm">{k.label}</div>
                        <div className="truncate font-mono text-[11px] text-zinc-500">
                          {k.key.slice(0, 7)}…{k.key.slice(-4)}
                        </div>
                      </div>
                    </label>
                    <button
                      onClick={() => removeOneKey(k.id)}
                      title="Remove key from your pool"
                      className="shrink-0 text-zinc-500 hover:text-rose-400"
                    >
                      <Trash2 size={14} />
                    </button>
                  </div>
                ))}
              </div>
            )}

            <div className="space-y-1.5 rounded-lg border border-white/10 bg-white/[0.02] p-2">
              <input
                value={newLabel}
                onChange={(e) => setNewLabel(e.target.value)}
                placeholder="Label (e.g. Personal)"
                className="w-full rounded-lg border border-white/10 bg-black/30 px-2.5 py-1.5 text-sm outline-none focus:border-sky-500/60"
              />
              <div className="flex gap-1.5">
                <input
                  value={newKey}
                  onChange={(e) => setNewKey(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && addNewKey()}
                  placeholder="sk-..."
                  type="password"
                  className="min-w-0 flex-1 rounded-lg border border-white/10 bg-black/30 px-2.5 py-1.5 font-mono text-sm outline-none focus:border-sky-500/60"
                />
                <button
                  onClick={addNewKey}
                  disabled={!newKey.trim()}
                  className="flex shrink-0 items-center gap-1 rounded-lg bg-white/10 px-3 py-1.5 text-sm hover:bg-white/15 disabled:opacity-40"
                >
                  <Plus size={14} /> Add
                </button>
              </div>
            </div>
            {keyStatus?.checking && <p className="text-xs text-zinc-500">Checking API key…</p>}
            {keyStatus && keyStatus.ok === false && (
              <p className="text-xs text-rose-400">{keyStatus.error}</p>
            )}
          </div>

          {/* Model */}
          <div className="space-y-2">
            <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-zinc-500">
              <Zap size={13} /> Model
            </div>
            <input
              value={model}
              onChange={(e) => setModel(e.target.value)}
              placeholder="gpt-5.5"
              className="w-full rounded-lg border border-white/10 bg-black/30 px-2.5 py-1.5 font-mono text-sm outline-none focus:border-sky-500/60"
            />
          </div>

          {/* Workspace */}
          <div className="space-y-2">
            <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-zinc-500">
              <FolderOpen size={13} /> Workspace Folder
            </div>
            <div className="flex gap-1.5">
              <input
                value={workspaceRoot}
                onChange={(e) => onPathChange(e.target.value)}
                placeholder="Path to your project folder…"
                className="min-w-0 flex-1 rounded-lg border border-white/10 bg-black/30 px-2.5 py-1.5 font-mono text-sm outline-none focus:border-sky-500/60"
              />
              <button
                onClick={browse}
                title="Browse for a folder"
                className="flex shrink-0 items-center gap-1 rounded-lg border border-white/10 px-2.5 py-1.5 text-sm hover:bg-white/5"
              >
                <FolderSearch size={14} /> Browse
              </button>
            </div>
            <div className="flex items-center gap-3">
              <button onClick={validate} className="text-xs text-sky-400 hover:underline">
                Validate folder
              </button>
              {wsStatus?.checking && <span className="text-xs text-zinc-500">Checking…</span>}
              {validated && !wsStatus?.checking && (
                <span className="flex items-center gap-1 text-xs text-emerald-400">
                  <Check size={13} /> Folder is valid
                </span>
              )}
              {wsStatus && wsStatus.ok === false && (
                <span className="flex items-center gap-1 text-xs text-rose-400">
                  <AlertTriangle size={13} /> {wsStatus.error}
                </span>
              )}
            </div>
            {!validated && (
              <p className="text-[11px] text-amber-400/80">Validate the folder to create the chat.</p>
            )}
          </div>

          {/* Safety identifier */}
          <div className="space-y-2">
            <div className="flex items-center justify-between gap-3">
              <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-zinc-500">
                {safetyIdentifierEnabled ? <ShieldCheck size={13} /> : <ShieldOff size={13} />}
                Safety Identifier
              </div>
              <button
                onClick={toggleSafetyIdentifier}
                className={`relative h-5 w-9 shrink-0 rounded-full transition-colors ${
                  safetyIdentifierEnabled ? "bg-sky-500" : "bg-zinc-700"
                }`}
                title={safetyIdentifierEnabled ? "Disable safety identifier" : "Enable safety identifier"}
              >
                <span
                  className={`absolute left-0.5 top-0.5 h-4 w-4 rounded-full bg-white transition-transform ${
                    safetyIdentifierEnabled ? "translate-x-4" : "translate-x-0"
                  }`}
                />
              </button>
            </div>
            <div className="flex gap-1.5">
              <input
                value={safetyIdentifier}
                onChange={(e) => setSafetyIdentifier(e.target.value)}
                disabled={!safetyIdentifierEnabled}
                placeholder={safetyIdentifierEnabled ? "safety identifier" : "Not sent for this chat"}
                className="min-w-0 flex-1 rounded-lg border border-white/10 bg-black/30 px-2.5 py-1.5 font-mono text-xs outline-none focus:border-sky-500/60 disabled:opacity-50"
              />
              <button
                onClick={() => setSafetyIdentifier(randomHex())}
                disabled={!safetyIdentifierEnabled}
                title="Generate a new safety identifier"
                className="flex shrink-0 items-center gap-1 rounded-lg border border-white/10 px-2.5 py-1.5 text-xs hover:bg-white/5 disabled:opacity-40"
              >
                <RefreshCw size={12} /> Generate
              </button>
            </div>
            <p className="text-[11px] text-zinc-500">
              {safetyIdentifierEnabled ? (
                <>
                  Sent as <code>safety_identifier</code> on every request in this conversation.
                </>
              ) : (
                "No safety_identifier will be sent for this conversation."
              )}
            </p>
          </div>
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-white/10 px-5 py-3">
          <button
            onClick={onClose}
            className="rounded-lg border border-white/10 px-3 py-1.5 text-sm hover:bg-white/5"
          >
            Cancel
          </button>
          <button
            onClick={create}
            disabled={!canCreate || keyStatus?.checking}
            className="flex items-center gap-1.5 rounded-lg bg-sky-600 px-3 py-1.5 text-sm font-medium text-white transition hover:bg-sky-500 disabled:opacity-40"
          >
            <MessageSquarePlus size={15} /> {keyStatus?.checking ? "Checking…" : "Create chat"}
          </button>
        </div>
      </div>
    </div>
  );
}
