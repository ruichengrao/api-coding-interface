import { useEffect, useState, useCallback, useRef } from "react";

// v2 store. The API keys are a single global pool; every chat session is an
// isolated unit that owns its own settings, conversation, and turn log, plus a
// reference to which pooled key it uses.
const KEY = "codex-local-assistant.store.v2";
const OLD_KEY = "codex-local-assistant.settings.v1";

// Per-conversation settings (everything that used to be global). The safety
// identifier is optional per conversation and is sent only when enabled.
const SETTING_DEFAULTS = {
  keyId: null, // which pooled API key this chat uses
  model: "gpt-5.5",
  approvalMode: "smart", // "smart" | "manual" | "auto"
  allowOutsideWorkspace: false,
  safetyIdentifierEnabled: false,
  safetyIdentifier: "",
  workspaceRoot: "",
  workspaceValidated: false,
};

const SETTING_KEYS = Object.keys(SETTING_DEFAULTS);

// Synchronous random hex (used to seed a chat's safety identifier when enabled).
export function randomHex(bytes = 32) {
  const a = new Uint8Array(bytes);
  crypto.getRandomValues(a);
  return Array.from(a, (b) => b.toString(16).padStart(2, "0")).join("");
}

function makeChat(seed = {}) {
  const now = Date.now();
  const chat = {
    id: crypto.randomUUID(),
    title: "New chat",
    createdAt: now,
    updatedAt: now,
    previousResponseId: null,
    messages: [],
    turns: [],
    apiIdentity: seed.apiIdentity || null,
    ...SETTING_DEFAULTS,
    // only copy known setting fields from the seed
    ...Object.fromEntries(SETTING_KEYS.filter((k) => k in seed).map((k) => [k, seed[k]])),
  };
  if (chat.safetyIdentifierEnabled && !chat.safetyIdentifier) chat.safetyIdentifier = randomHex();
  return chat;
}

function freshStore() {
  return { version: 2, apiKeys: [], chats: [], activeChatId: null, defaults: { ...SETTING_DEFAULTS } };
}

function makePersistedId(prefix) {
  return `${prefix}-${randomHex(8)}`;
}

function ensureUniqueIds(items, prefix) {
  if (!Array.isArray(items)) return [];
  const seen = new Set();
  return items.map((item) => {
    const next = item && typeof item === "object" ? item : {};
    if (!next.id || seen.has(next.id)) {
      const id = makePersistedId(prefix);
      seen.add(id);
      return { ...next, id };
    }
    seen.add(next.id);
    return next;
  });
}

function callKey(call) {
  if (call?.request_id) return `request:${call.request_id}`;
  if (call?.response_id) return `response:${call.response_id}`;
  return null;
}

function dedupeTurnCalls(turns) {
  const lastOccurrence = new Map();

  turns.forEach((turn, turnIndex) => {
    const calls = Array.isArray(turn.calls) ? turn.calls : [];
    calls.forEach((call, callIndex) => {
      const key = callKey(call);
      if (key) lastOccurrence.set(key, `${turnIndex}:${callIndex}`);
    });
  });

  return turns.map((turn, turnIndex) => ({
    ...turn,
    calls: (Array.isArray(turn.calls) ? turn.calls : []).filter((call, callIndex) => {
      const key = callKey(call);
      return !key || lastOccurrence.get(key) === `${turnIndex}:${callIndex}`;
    }),
  }));
}

// Wrap an existing v1 settings blob into the v2 shape: keep the key pool, fold
// the old global settings into one starter chat + the defaults for new chats.
function migrateV1(old) {
  const apiKeys = Array.isArray(old.apiKeys) ? old.apiKeys : [];
  const seed = {
    keyId: old.activeKeyId || apiKeys[0]?.id || null,
    model: old.model ?? SETTING_DEFAULTS.model,
    approvalMode: old.approvalMode ?? SETTING_DEFAULTS.approvalMode,
    allowOutsideWorkspace: old.allowOutsideWorkspace ?? false,
    safetyIdentifierEnabled: Boolean(old.safetyIdentifier),
    safetyIdentifier: old.safetyIdentifier ?? "",
    workspaceRoot: old.workspaceRoot ?? "",
    workspaceValidated: old.workspaceValidated ?? false,
  };
  const chat = makeChat(seed);
  return { version: 2, apiKeys, chats: [chat], activeChatId: chat.id, defaults: { ...seed } };
}

function normalize(store) {
  if (!Array.isArray(store.apiKeys)) store.apiKeys = [];
  store.defaults = { ...SETTING_DEFAULTS, ...(store.defaults || {}) };
  if (!Array.isArray(store.chats)) store.chats = [];
  if (!store.chats.find((c) => c.id === store.activeChatId)) {
    store.activeChatId = store.chats[0]?.id || null;
  }
  for (const c of store.chats) {
    if (!["smart", "manual", "auto"].includes(c.approvalMode)) {
      c.approvalMode = SETTING_DEFAULTS.approvalMode;
    }
    if (typeof c.safetyIdentifierEnabled !== "boolean") {
      c.safetyIdentifierEnabled = Boolean(c.safetyIdentifier);
    }
    if (c.safetyIdentifierEnabled && !c.safetyIdentifier) c.safetyIdentifier = randomHex();
    c.apiIdentity = c.apiIdentity || null;
    c.messages = ensureUniqueIds(c.messages, "msg");
    c.turns = dedupeTurnCalls(ensureUniqueIds(c.turns, "turn"));
  }
  store.version = 2;
  return store;
}

function load() {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return normalize(JSON.parse(raw));
  } catch {
    /* fall through */
  }
  try {
    const old = JSON.parse(localStorage.getItem(OLD_KEY) || "null");
    if (old) return normalize(migrateV1(old));
  } catch {
    /* fall through */
  }
  return freshStore();
}

export function useStore() {
  const [store, setStore] = useState(load);

  // Persist during idle time so large conversations don't block rendering while
  // the agent is streaming tool/message updates.
  const timer = useRef(null);
  useEffect(() => {
    clearTimeout(timer.current);
    let idleId = null;
    const persist = () => {
      try {
        localStorage.setItem(KEY, JSON.stringify(store));
      } catch {
        /* quota exceeded — keep running with in-memory state */
      }
    };
    timer.current = setTimeout(() => {
      if ("requestIdleCallback" in window) {
        idleId = window.requestIdleCallback(persist, { timeout: 2500 });
      } else {
        persist();
      }
    }, 1200);
    return () => {
      clearTimeout(timer.current);
      if (idleId != null && "cancelIdleCallback" in window) window.cancelIdleCallback(idleId);
    };
  }, [store]);

  // ── API key pool ──────────────────────────────────────────────────────────
  const addKey = useCallback((label, key) => {
    const id = crypto.randomUUID();
    setStore((s) => {
      const apiKeys = [...s.apiKeys, { id, label: label || `Key ${s.apiKeys.length + 1}`, key }];
      // If the active chat has no key yet, adopt the one just added.
      const chats = s.chats.map((c) =>
        c.id === s.activeChatId && !c.keyId ? { ...c, keyId: id } : c
      );
      return { ...s, apiKeys, chats };
    });
    return id; // so callers (the New chat panel) can auto-select it
  }, []);

  const removeKey = useCallback((id) => {
    setStore((s) => {
      const apiKeys = s.apiKeys.filter((k) => k.id !== id);
      // Detach the removed key from any chat that referenced it.
      const chats = s.chats.map((c) => (c.keyId === id ? { ...c, keyId: null } : c));
      return { ...s, apiKeys, chats };
    });
  }, []);

  // ── Chats ─────────────────────────────────────────────────────────────────
  // Create a chat from an explicit seed (the New-chat panel). Any setting the
  // seed omits is inherited from the current chat / defaults.
  const createChat = useCallback((seed = {}) => {
    setStore((s) => {
      const base = s.chats.find((c) => c.id === s.activeChatId) || s.defaults;
      const merged = {
        ...Object.fromEntries(SETTING_KEYS.map((k) => [k, base[k]])),
        ...Object.fromEntries(SETTING_KEYS.filter((k) => k in seed).map((k) => [k, seed[k]])),
      };
      if (seed.apiIdentity) merged.apiIdentity = seed.apiIdentity;
      if (!merged.keyId) merged.keyId = s.apiKeys[0]?.id || null;
      const chat = makeChat(merged);
      return { ...s, chats: [chat, ...s.chats], activeChatId: chat.id };
    });
  }, []);

  const switchChat = useCallback((id) => {
    setStore((s) => (s.activeChatId === id ? s : { ...s, activeChatId: id }));
  }, []);

  const renameChat = useCallback((id, title) => {
    setStore((s) => ({
      ...s,
      chats: s.chats.map((c) =>
        c.id === id ? { ...c, title: title.trim() || "Untitled", updatedAt: Date.now() } : c
      ),
    }));
  }, []);

  const deleteChat = useCallback((id) => {
    setStore((s) => {
      const chats = s.chats.filter((c) => c.id !== id);
      let activeChatId = s.activeChatId;
      if (id === s.activeChatId) {
        activeChatId = chats[0]?.id || null;
      }
      return { ...s, chats, activeChatId };
    });
  }, []);

  // Patch a chat. `patch` may be an object or a (chat) => partial function.
  // When it touches setting fields, mirror them into `defaults` so future new
  // chats inherit the latest values.
  const updateChat = useCallback((id, patch) => {
    setStore((s) => {
      let nextDefaults = s.defaults;
      const chats = s.chats.map((c) => {
        if (c.id !== id) return c;
        const p = typeof patch === "function" ? patch(c) : patch;
        const touchedSettings = Object.keys(p).some((k) => SETTING_KEYS.includes(k));
        if (touchedSettings) {
          nextDefaults = { ...s.defaults };
          for (const k of SETTING_KEYS) if (k in p) nextDefaults[k] = p[k];
        }
        return { ...c, ...p, updatedAt: Date.now() };
      });
      return { ...s, chats, defaults: nextDefaults };
    });
  }, []);

  const activeChat = store.chats.find((c) => c.id === store.activeChatId) || null;
  const activeKey = store.apiKeys.find((k) => k.id === activeChat?.keyId) || null;

  const updateActive = useCallback(
    (patch) => updateChat(store.activeChatId, patch),
    [store.activeChatId, updateChat]
  );

  return {
    apiKeys: store.apiKeys,
    addKey,
    removeKey,
    chats: store.chats,
    activeChat,
    activeChatId: store.activeChatId,
    activeKey,
    createChat,
    switchChat,
    renameChat,
    deleteChat,
    updateChat,
    updateActive,
  };
}
