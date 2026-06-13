// Thin wrappers around OpenAI API calls using global fetch (Node 18+).
// Response creation returns both the parsed body and the x-request-id header so
// the UI can log the request id alongside the response id for every turn.

const RESPONSES_URL = "https://api.openai.com/v1/responses";
const ME_URL = "https://api.openai.com/v1/me";

const EMAIL_RE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i;

function extractEmail(data, org) {
  const candidates = [
    data?.email,
    data?.user?.email,
    data?.account?.email,
    org?.description,
    ...(Array.isArray(data?.orgs?.data) ? data.orgs.data.map((o) => o?.description) : []),
  ];
  for (const value of candidates) {
    const match = typeof value === "string" ? value.match(EMAIL_RE) : null;
    if (match) return match[0];
  }
  return null;
}

function pickOrganization(data) {
  const orgs = Array.isArray(data?.orgs?.data) ? data.orgs.data : [];
  return orgs.find((org) => org?.is_default) || orgs[0] || null;
}

async function readJson(res) {
  try {
    return await res.json();
  } catch {
    return null;
  }
}

/**
 * Call POST /v1/responses.
 * @param {object} opts
 * @param {string} opts.apiKey  - OpenAI API key (sk-...)
 * @param {object} opts.body    - Request body for the Responses API
 * @returns {Promise<{data: object, requestId: string|null}>}
 */
export async function createResponse({ apiKey, body }) {
  if (!apiKey) {
    const err = new Error("No API key provided. Add and select a key in Settings.");
    err.status = 401;
    throw err;
  }

  let res;
  try {
    res = await fetch(RESPONSES_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
  } catch (e) {
    const err = new Error(`Network error contacting OpenAI: ${e.message}`);
    err.status = 0;
    throw err;
  }

  const requestId = res.headers.get("x-request-id");

  let data;
  try {
    data = await res.json();
  } catch {
    data = null;
  }

  if (!res.ok) {
    const message = data?.error?.message || `OpenAI API error (HTTP ${res.status})`;
    const err = new Error(message);
    err.status = res.status;
    err.requestId = requestId;
    err.data = data;
    throw err;
  }

  return { data, requestId };
}

/**
 * Call GET /v1/me and distill the API-key account identity for local display.
 * @param {object} opts
 * @param {string} opts.apiKey - OpenAI API key (sk-...)
 * @returns {Promise<{email:string|null,organizationId:string|null,organizationDescription:string,organizationName:string,organizationTitle:string,checkedAt:string}>}
 */
export async function inspectApiKey({ apiKey }) {
  if (!apiKey) {
    const err = new Error("No API key provided. Add and select a key before creating a chat.");
    err.status = 401;
    throw err;
  }

  let res;
  try {
    res = await fetch(ME_URL, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${apiKey}`,
      },
    });
  } catch (e) {
    const err = new Error(`Network error checking API key: ${e.message}`);
    err.status = 0;
    throw err;
  }

  const requestId = res.headers.get("x-request-id");
  const data = await readJson(res);

  if (!res.ok) {
    const message = data?.error?.message || `API key check failed (HTTP ${res.status})`;
    const err = new Error(message);
    err.status = res.status;
    err.requestId = requestId;
    err.data = data;
    throw err;
  }

  const org = pickOrganization(data);
  return {
    email: extractEmail(data, org),
    organizationId: org?.id || null,
    organizationDescription: org?.description || "",
    organizationName: org?.name || "",
    organizationTitle: org?.title || "",
    checkedAt: new Date().toISOString(),
  };
}
