/**
 * Thin wrapper over the FastAPI backend in ../api.
 *
 * Requests go to `/api/...`, which the Vite dev server proxies to uvicorn on
 * :8000 with the prefix stripped (see vite.config.js). Set VITE_API_BASE to
 * point a build at a deployed API instead, e.g. `https://api.example.com`.
 */

const BASE = (import.meta.env.VITE_API_BASE ?? '/api').replace(/\/+$/, '');

/** The API's `Priority` enum, most urgent first. Note: `critical`, not `high`. */
export const PRIORITIES = ['critical', 'medium', 'low'];

export class ApiError extends Error {
  /** `status` is 0 when the request never reached the server. */
  constructor(message, status, options) {
    super(message, options);
    this.name = 'ApiError';
    this.status = status;
  }
}

/** FastAPI's `detail` is a string for HTTPException and a list for a 422. */
function describe(detail, fallback) {
  if (typeof detail === 'string' && detail) return detail;
  if (Array.isArray(detail)) {
    const messages = detail.map((problem) => problem?.msg).filter(Boolean);
    if (messages.length) return messages.join('; ');
  }
  return fallback;
}

/** Drops empty values; an array becomes a repeated key, which is how `ids` works. */
function query(params) {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '') continue;
    if (Array.isArray(value)) value.forEach((item) => search.append(key, item));
    else search.append(key, value);
  }
  const encoded = search.toString();
  return encoded ? `?${encoded}` : '';
}

async function request(path, { method = 'GET', body } = {}) {
  let response;
  try {
    response = await fetch(`${BASE}${path}`, {
      method,
      headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (cause) {
    // fetch only rejects when the request never reached a server.
    throw new ApiError(`Cannot reach the API at ${BASE} — is uvicorn running?`, 0, { cause });
  }

  if (!response.ok) {
    const fallback = `${method} ${path} failed with ${response.status}`;
    let detail;
    try {
      ({ detail } = await response.json());
    } catch {
      // An error page that is not JSON: the fallback message is all we have.
    }
    throw new ApiError(describe(detail, fallback), response.status);
  }

  return response.status === 204 ? null : response.json();
}

export const health = () => request('/health');

/** All e-mails, newest first. `q` searches subject + body, `priority` filters. */
export const listEmails = ({ q, priority } = {}) =>
  request(`/emails${query({ q, priority })}`);

/**
 * Digest of the matching e-mails: `{ emailIds, count, summary, status }`.
 * `summary` is null while `app/summarizer.py` is a stub — hence `status`.
 */
export const summarizeEmails = ({ q, priority, ids } = {}) =>
  request(`/emails/summarize${query({ q, priority, ids })}`);

/** Queue a summarization job for `emailIds`; returns `{ id }`. */
export const queueSummarization = (emailIds) =>
  request('/summarize', { method: 'POST', body: emailIds });

/** Jobs still waiting for a summary, oldest first. */
export const listPendingJobs = () => request('/summarize');

/** One job's `{ id, summary }`. There is no list-all route, so id is the way in. */
export const getJob = (jobId) => request(`/summarize/${jobId}`);

/** Write a job's summary, which takes it out of the pending list. */
export const submitJobSummary = (jobId, summary) =>
  request(`/summarize/${jobId}`, { method: 'POST', body: { summary } });
