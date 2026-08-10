import createClient from "openapi-fetch";
import type { paths } from "./generated/trilium-schema.js";

export type TriliumClientConfig = {
  baseUrl: string;
  apiToken: string;
};

export type TriliumClient = ReturnType<typeof createClient<paths>>;

// Tools need baseUrl (not just the configured client) to build note links
// back to the Trilium web UI in their responses.
export type TriliumClientHandle = {
  client: TriliumClient;
  baseUrl: string;
};

// Shared by every tool that links back to a note in Trilium's web UI
// (notes.ts and calendar.ts) -- a single implementation rather than each
// file duplicating the same string template.
//
// Best-effort direct link: Trilium's client resolves a bare `#<noteId>`
// hash to the note regardless of where it sits in the tree (verified
// against a live v0.104.1 instance), even though the app's own "copy note
// path" feature produces a longer `#root/.../<noteId>` breadcrumb form.
// The short form is used here since this plugin has no cheap way to
// compute a note's full ancestor path without extra calls.
export function noteUrl(baseUrl: string, noteId: string): string {
  return `${baseUrl}/#${noteId}`;
}

// Trilium is typically a LAN/home-server device; without a bounded
// deadline, a stalled server or a dropped connection hangs a tool call
// indefinitely. Retries are deliberately not added here: PATCH/POST/PUT
// calls in this plugin aren't idempotent, so blindly retrying a timed-out
// write risks double-applying it -- better to surface a clear timeout
// error and let the caller decide whether to retry.
const DEFAULT_TIMEOUT_MS = 30_000;

export function createTriliumClient(config: TriliumClientConfig): TriliumClient {
  return createClient<paths>({
    baseUrl: `${config.baseUrl.replace(/\/+$/, "")}/etapi`,
    headers: {
      // ETAPI's `EtapiTokenAuth` security scheme is a bare apiKey header --
      // the token goes in `Authorization` directly with no scheme prefix
      // (verified against the OpenAPI spec's securitySchemes; "Bearer
      // <token>" is also accepted from v0.93.0 on, but the unprefixed form
      // has worked since ETAPI's introduction, so it's used here for the
      // widest version compatibility).
      Authorization: config.apiToken,
    },
    fetch: (request) =>
      fetch(request, {
        signal: AbortSignal.any([request.signal, AbortSignal.timeout(DEFAULT_TIMEOUT_MS)]),
      }),
  });
}

/**
 * openapi-fetch returns { data, error, response } instead of throwing on
 * non-2xx responses. AgentTool.execute is expected to throw on failure, so
 * tools route their results through this instead of checking `error` by
 * hand.
 *
 * A non-2xx response with an empty body (a bare 401/403 from an auth proxy,
 * a 502/504 from a reverse proxy) leaves both `data` and `error` undefined
 * -- openapi-fetch never reads a body in that case. Status is read from
 * `response` so that failure still surfaces as a real HTTP error instead of
 * the generic "no data" message.
 *
 * A *successful* response with an empty body also leaves `data` undefined --
 * openapi-fetch special-cases `Content-Length: 0` the same way it special-
 * cases 204 (see its own fetch wrapper), returning `data: void 0` for any
 * ok response with nothing to read, not just a bare 204. That's ETAPI's
 * normal "done, nothing to say" shape (every DELETE, both content PUTs,
 * createRevision) *and* legitimately empty content on a GET (e.g. an
 * organizer note with no body text of its own) -- neither is a failure, so
 * response.ok generally, not just status === 204, must be treated as
 * "no data" rather than conflated with the no-data-on-a-non-2xx-response
 * case below. Every write-only tool (delete/undelete/content-write/
 * create-revision) relies on this to actually surface a failed write
 * instead of silently reporting success -- don't remove the response.ok
 * special-case without re-auditing every call site that now depends on
 * unwrap() throwing on a real failure there. A GET-content caller that
 * needs a string, not `T | undefined`, coerces with `?? ""` itself --
 * unwrap() has no way to know a given T is string-shaped.
 */
export function unwrap<T>({
  data,
  error,
  response,
}: {
  data?: T;
  error?: unknown;
  response?: Response;
}): T {
  if (error !== undefined) {
    const detail = describeEtapiError(error);
    const status = response ? ` (${response.status} ${response.statusText})` : "";
    throw new Error(`trilium ETAPI error${status}: ${detail}`);
  }
  if (data === undefined) {
    if (response?.ok) {
      return undefined as T;
    }
    if (response && !response.ok) {
      throw new Error(`trilium ETAPI error: ${response.status} ${response.statusText}`.trim());
    }
    throw new Error("trilium ETAPI returned no data");
  }
  return data;
}

// ETAPI's Error schema is { status, code, message } -- code is a stable
// string constant (e.g. NOTE_IS_PROTECTED) genuinely useful to a
// tool-calling model deciding how to react, unlike an opaque stack trace.
// Surfacing `code` and `message` together (rather than JSON.stringify-ing
// the whole error object) keeps the thrown message itself actionable, in
// line with the "specific and actionable errors" guidance this plugin's
// tool descriptions otherwise follow.
function describeEtapiError(error: unknown): string {
  if (
    error &&
    typeof error === "object" &&
    "code" in error &&
    "message" in error &&
    typeof (error as { message: unknown }).message === "string"
  ) {
    const code = (error as { code: unknown }).code;
    const message = (error as { message: string }).message;
    return typeof code === "string" ? `${code}: ${message}` : message;
  }
  return typeof error === "string" ? error : JSON.stringify(error);
}

/**
 * Shared response envelope for every tool's execute(): the `text` is what
 * the calling model reads, `details` carries the structured object for any
 * non-model consumer (logs, UI).
 */
export function toToolResult<T>(result: T): {
  content: [{ type: "text"; text: string }];
  details: T;
} {
  return {
    // Compact, not pretty-printed -- the model reads this as data, not as
    // human-formatted output, so indentation/newlines are pure token
    // overhead. `details` (below) carries the same object, unformatted,
    // for any non-model consumer that wants it.
    content: [{ type: "text", text: JSON.stringify(result) }],
    details: result,
  };
}
