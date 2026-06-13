// Sends a chat turn to the backend and reads the Server-Sent Events stream.
// EventSource only supports GET, so we POST and parse the SSE stream manually
// from the fetch response body.

export async function streamChat(payload, handlers, signal) {
  const res = await fetch("/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    signal,
  });

  if (!res.ok || !res.body) {
    const text = await res.text().catch(() => "");
    throw new Error(`Request failed (${res.status}). ${text}`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    // SSE messages are separated by a blank line.
    let sep;
    while ((sep = buffer.indexOf("\n\n")) !== -1) {
      const raw = buffer.slice(0, sep);
      buffer = buffer.slice(sep + 2);
      parseEvent(raw, handlers);
    }
  }
}

function parseEvent(raw, handlers) {
  let event = "message";
  const dataLines = [];
  for (const line of raw.split("\n")) {
    if (line.startsWith("event:")) event = line.slice(6).trim();
    else if (line.startsWith("data:")) dataLines.push(line.slice(5).trim());
  }
  if (dataLines.length === 0) return;
  let data = {};
  try {
    data = JSON.parse(dataLines.join("\n"));
  } catch {
    data = { raw: dataLines.join("\n") };
  }
  handlers[event]?.(data);
}

export async function approveToolCall(callId, approved) {
  await fetch("/api/approve", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ call_id: callId, approved }),
  });
}

export async function browseFolder() {
  const res = await fetch("/api/browse-folder", { method: "POST" });
  return res.json();
}

export async function validateWorkspace(workspaceRoot) {
  const res = await fetch("/api/validate-workspace", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ workspaceRoot }),
  });
  return res.json();
}

export async function inspectApiKey(apiKey) {
  const res = await fetch("/api/inspect-key", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ apiKey }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.ok) {
    throw new Error(data.error || `API key check failed (${res.status}).`);
  }
  return data.identity;
}
