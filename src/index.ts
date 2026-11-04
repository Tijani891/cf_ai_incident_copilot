import { IncidentSession } from "./session";
import { TriageWorkflow } from "./workflow";
import { authorised, formatAlertMessage, isAlertmanagerPayload, sessionIdForGroup } from "./alerts";

export { IncidentSession, TriageWorkflow };

const SESSION_ID = /^[a-f0-9-]{36}$/;
const MAX_MESSAGE_CHARS = 4000;

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });

const error = (message: string, status: number) => json({ error: message }, status);

async function body<T>(request: Request): Promise<T | null> {
  try {
    return (await request.json()) as T;
  } catch {
    return null;
  }
}

/** Registers a report in the session and starts the triage Workflow for it. */
async function startTriage(env: Env, sessionId: string): Promise<string> {
  const session = env.SESSIONS.get(env.SESSIONS.idFromName(sessionId));
  const reportId = crypto.randomUUID();
  await session.startReport(reportId);
  await env.TRIAGE.create({ id: reportId, params: { sessionId, reportId } });
  return reportId;
}

/** POST /api/alerts/alertmanager — Alertmanager webhook_config receiver. */
async function handleAlertmanager(request: Request, env: Env): Promise<Response> {
  // Secret set with `wrangler secret put ALERT_WEBHOOK_TOKEN` (locally: .dev.vars), so it
  // isn't in the generated Env type unless .dev.vars exists.
  const token = (env as Env & { ALERT_WEBHOOK_TOKEN?: string }).ALERT_WEBHOOK_TOKEN;
  const auth = authorised(request, token);
  if (auth === "disabled") return error("Webhook disabled: set the ALERT_WEBHOOK_TOKEN secret", 503);
  if (!auth) return error("Unauthorized", 401);

  const payload = await body<unknown>(request);
  if (!isAlertmanagerPayload(payload)) return error("Expected an Alertmanager webhook payload", 400);

  const sessionId = await sessionIdForGroup(payload.groupKey, token!);
  const session = env.SESSIONS.get(env.SESSIONS.idFromName(sessionId));
  await session.ingestAlert(formatAlertMessage(payload));

  // Triage on firing notifications only, and not while a run for this group is in flight.
  let reportId: string | null = null;
  if (payload.status === "firing" && !(await session.hasActiveTriage())) {
    reportId = await startTriage(env, sessionId);
  }

  const origin = new URL(request.url).origin;
  return json({ sessionId, url: `${origin}/#${sessionId}`, triageStarted: !!reportId, reportId }, 202);
}

/**
 * API routes (everything else is served from ./public as static assets):
 *
 *   POST   /api/sessions                      create a new incident session
 *   GET    /api/sessions/:id                  transcript, remembered stack, summary, reports
 *   DELETE /api/sessions/:id                  wipe the session
 *   PUT    /api/sessions/:id/stack            remember the engineer's stack
 *   POST   /api/sessions/:id/chat             chat turn (streams plain text)
 *   POST   /api/sessions/:id/triage           start the triage Workflow
 *   GET    /api/sessions/:id/triage/:reportId Workflow status + report
 *   POST   /api/alerts/alertmanager           Alertmanager webhook (bearer token)
 */
export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);
    const parts = url.pathname.split("/").filter(Boolean); // ["api", "sessions", id, ...]

    if (parts[0] !== "api") return env.ASSETS.fetch(request);

    try {
      if (parts[1] === "alerts" && parts[2] === "alertmanager" && parts.length === 3) {
        if (request.method !== "POST") return error("Method not allowed", 405);
        return await handleAlertmanager(request, env);
      }

      if (parts[1] !== "sessions") return error("Not found", 404);

      if (parts.length === 2 && request.method === "POST") {
        return json({ id: crypto.randomUUID() }, 201);
      }

      const sessionId = parts[2];
      if (!sessionId || !SESSION_ID.test(sessionId)) return error("Invalid session id", 400);
      const session = env.SESSIONS.get(env.SESSIONS.idFromName(sessionId));
      const action = parts[3];

      if (!action) {
        if (request.method === "GET") return json(await session.getState());
        if (request.method === "DELETE") {
          await session.reset();
          return json({ ok: true });
        }
      }

      if (action === "stack" && request.method === "PUT") {
        const b = await body<{ stack?: string }>(request);
        if (typeof b?.stack !== "string") return error("Body must be { stack: string }", 400);
        await session.setStack(b.stack);
        return json({ ok: true });
      }

      if (action === "chat" && request.method === "POST") {
        const b = await body<{ message?: string }>(request);
        const message = b?.message?.trim();
        if (!message) return error("Body must be { message: string }", 400);
        if (message.length > MAX_MESSAGE_CHARS) return error(`Message over ${MAX_MESSAGE_CHARS} characters`, 413);

        const stream = await session.chat(message);
        return new Response(stream, {
          headers: {
            "content-type": "text/plain; charset=utf-8",
            "cache-control": "no-store",
            "x-content-type-options": "nosniff",
          },
        });
      }

      if (action === "triage" && request.method === "POST" && parts.length === 4) {
        const { messageCount } = await session.getTranscript();
        if (messageCount === 0) return error("Describe the incident in chat before running triage", 409);

        return json({ reportId: await startTriage(env, sessionId) }, 202);
      }

      if (action === "triage" && request.method === "GET" && parts[4]) {
        const reportId = parts[4];
        if (!SESSION_ID.test(reportId)) return error("Invalid report id", 400);
        const instance = await env.TRIAGE.get(reportId);
        const status = await instance.status();
        const stored = (await session.getState()).reports.find((r) => r.id === reportId) ?? null;
        return json({
          workflowStatus: status.status,
          error: status.error ?? stored?.error ?? null,
          report: stored?.report ?? null,
        });
      }

      return error("Not found", 404);
    } catch (err) {
      console.error(err);
      return error((err as Error).message || "Internal error", 500);
    }
  },
} satisfies ExportedHandler<Env>;
