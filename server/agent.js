// The agentic loop. Sends a user message to the Responses API, executes any
// tool calls the model requests (with optional approval), feeds results back,
// and repeats until the model returns a final answer.
//
// Multi-turn conversation is maintained via `previous_response_id` + store:true,
// so we never need to resend prior context.

import { createResponse } from "./openai.js";
import { toolDefinitions, executeTool, needsApproval, accessesOutside } from "./tools.js";

const MAX_STEPS = 30;

// Build the Responses API content for the user's first message. With no
// attachments we keep the simple string form; otherwise we emit typed content
// parts — text files inlined as input_text, images as input_image.
function buildUserContent(userMessage, attachments) {
  if (!attachments || attachments.length === 0) return userMessage;

  const parts = [];
  if (userMessage && userMessage.trim()) {
    parts.push({ type: "input_text", text: userMessage });
  }
  for (const a of attachments) {
    if (a.kind === "image" && a.dataUrl) {
      parts.push({ type: "input_image", image_url: a.dataUrl });
    } else if (a.text != null) {
      parts.push({
        type: "input_text",
        text: `Attached file: ${a.name}\n\n\`\`\`\n${a.text}\n\`\`\``,
      });
    }
  }
  if (parts.length === 0) parts.push({ type: "input_text", text: userMessage || "" });
  return parts;
}

const SYSTEM_PROMPT = `You are a local agentic coding assistant, similar to Cascade, running on the user's machine.

You have tools to inspect and modify files, search code, list project trees, and run shell commands inside the user's workspace folder.

Guidelines:
- Be concise and direct. Explain your plan briefly, then act using tools.
- Start by using file_tree/search_files/read_many_files to gather local context. Do not ask the user to paste terminal output or file contents when you can inspect or run the needed command yourself.
- Prefer edit_file for targeted changes. Use write_file only when creating a new file or replacing most of an existing file.
- Use run_command for tests, builds, linters, type checks, and local debugging. Prefer short, bounded commands that produce useful logs.
- After making changes, verify them when reasonable with the most relevant test/build/check.
- Never invent file contents you have not read. Inspect first.
- Child paths inside the workspace are allowed. Parent or outside paths are blocked unless the user has enabled outside-workspace access, in which case each outside action requires explicit approval.
- Format responses in Markdown. Use fenced code blocks for code.`;

/**
 * @param {object} opts
 * @param {string} opts.apiKey
 * @param {string} opts.model
 * @param {string} opts.userMessage
 * @param {string|null} opts.safetyIdentifier  - if set, sent as safety_identifier
 * @param {string|null} opts.previousResponseId
 * @param {string} opts.workspaceRoot
 * @param {"auto"|"manual"} opts.approvalMode
 * @param {boolean} opts.allowOutsideWorkspace - allow tools to reach outside the workspace (ask-first)
 * @param {Array<{name:string,kind:"text"|"image",text?:string,dataUrl?:string}>} opts.attachments
 * @param {(event:string,data:object)=>void} opts.emit
 * @param {(toolCall:object)=>Promise<boolean>} opts.requestApproval
 */
export async function runAgent({
  apiKey,
  model,
  userMessage,
  safetyIdentifier,
  previousResponseId,
  workspaceRoot,
  approvalMode,
  allowOutsideWorkspace = false,
  attachments = [],
  emit,
  requestApproval,
  shouldAbort = () => false,
}) {
  let prevId = previousResponseId || null;
  let input = [
    {
      type: "message",
      role: "user",
      content: buildUserContent(userMessage, attachments),
    },
  ];

  const idLog = [];

  for (let step = 0; step < MAX_STEPS; step++) {
    if (shouldAbort()) break;
    const body = {
      model,
      tools: toolDefinitions,
      store: true,
      input,
    };
    if (prevId) body.previous_response_id = prevId;
    else body.instructions = SYSTEM_PROMPT;
    if (safetyIdentifier) body.safety_identifier = safetyIdentifier;

    emit("status", { message: "Thinking…" });

    const { data, requestId } = await createResponse({ apiKey, body });
    prevId = data.id;

    const ids = {
      request_id: requestId,
      response_id: data.id,
      model: data.model,
      usage: data.usage || null,
      safety_identifier: safetyIdentifier || null,
    };
    idLog.push(ids);
    emit("ids", ids);

    const output = Array.isArray(data.output) ? data.output : [];
    const functionCalls = output.filter((o) => o.type === "function_call");

    for (const item of output) {
      if (item.type === "message" && Array.isArray(item.content)) {
        const text = item.content
          .map((c) => (typeof c.text === "string" ? c.text : ""))
          .join("");
        if (text.trim()) emit("assistant_message", { text });
      }
    }

    if (functionCalls.length === 0) break;

    const toolOutputs = [];
    for (const fc of functionCalls) {
      let args = {};
      try {
        args = JSON.parse(fc.arguments || "{}");
      } catch {
        args = { _parseError: fc.arguments };
      }

      const outside = accessesOutside(fc.name, args, workspaceRoot);
      emit("tool_call", { call_id: fc.call_id, name: fc.name, arguments: args, outside });

      let approved = true;
      if (needsApproval({ name: fc.name, args, approvalMode, outside, allowOutsideWorkspace })) {
        approved = await requestApproval({
          call_id: fc.call_id,
          name: fc.name,
          arguments: args,
          outside,
        });
      }

      let result;
      if (!approved) {
        result = "The user rejected this action. Do not retry it; consider an alternative.";
        emit("tool_result", { call_id: fc.call_id, name: fc.name, result, rejected: true });
      } else {
        try {
          result = await executeTool(fc.name, args, workspaceRoot, allowOutsideWorkspace);
        } catch (e) {
          result = `Error: ${e.message}`;
        }
        emit("tool_result", { call_id: fc.call_id, name: fc.name, result });
      }

      toolOutputs.push({
        type: "function_call_output",
        call_id: fc.call_id,
        output: typeof result === "string" ? result : JSON.stringify(result),
      });
    }

    input = toolOutputs;
  }

  return { previousResponseId: prevId, idLog };
}
