# cf_ai_incident_copilot

An on-call **incident copilot** for platform and reliability teams, built entirely on Cloudflare. Alerts from Alertmanager open an incident automatically and kick off a durable triage **Workflow**; the on-call engineer then chats with a copilot that remembers the stack and everything said in that incident. The result: a severity call, ranked root-cause hypotheses with the exact commands to confirm each one (from `kafka-consumer-groups` to `iostat`), and a blameless postmortem draft.

**Live demo:** https://cf-ai-incident-copilot.ahmedtijani1792.workers.dev

## How it meets the assignment

| Requirement | Implementation |
|---|---|
| **LLM** | Llama 3.3 70B on Workers AI (`@cf/meta/llama-3.3-70b-instruct-fp8-fast`), streamed for chat and run in JSON-schema mode for structured triage |
| **Workflow / coordination** | `TriageWorkflow` (Cloudflare Workflows): 5 checkpointed steps with per-step retries and exponential backoff. A Worker routes requests, receives alerts, and coordinates the Durable Object and the Workflow |
| **User input** | Chat UI (static assets on the same Worker) with streamed responses; alerts arrive via an Alertmanager webhook |
| **Memory / state** | `IncidentSession` Durable Object per incident, backed by SQLite: alert and chat timeline, remembered stack, rolling LLM summary of older turns, and triage reports that feed back into later chat answers |

## Architecture

```
Alertmanager ──POST /api/alerts/alertmanager──┐   (bearer token)
                                              │
Browser (public/)                             │
   │  POST /api/sessions/:id/chat  (stream)   │
   │  POST /api/sessions/:id/triage           │
   ▼                                          ▼
Worker (src/index.ts) ── router, auth, validation, alert → session mapping
   │                                  │
   ▼                                  ▼
IncidentSession DO (src/session.ts)   TriageWorkflow (src/workflow.ts)
 • SQLite: messages, kv, reports       1. load incident from session memory
 • builds prompt: system + stack       2. classify severity & impact     (JSON)
   + rolling summary + last triage     3. rank root-cause hypotheses     (JSON)
   + last 12 messages                  4. draft postmortem               (Markdown)
 • streams Llama 3.3, saves reply      5. save report back to the DO ───┐
 • compacts old turns into summary  ◄────────────────────────────────────┘
   │
   ▼
Workers AI — Llama 3.3 70B
```

## Design choices

**Durable execution for triage (the Temporal pattern).** Triage is three dependent LLM calls plus I/O. Each is a Workflow step, so its result is checkpointed: if step 3 hits a transient Workers AI error, only step 3 retries (3 attempts, exponential backoff, 2-minute timeout), and the run survives Worker restarts. This is the same durable-execution model as Temporal, applied to an AI pipeline.

**One Durable Object per incident.** An incident is a natural unit of consistency: one timeline, one set of hypotheses, one owner of truth. A Durable Object gives single-threaded, strongly consistent state per incident with SQLite storage co-located with the compute, and no shared database to coordinate. Alert notifications and chat turns are serialised through the same object, so the timeline is always in order.

**Alerts in, triage before anyone opens a laptop.** Alertmanager notifications for the same alert group always map to the same session (an HMAC of the group key, so ids are stable but unguessable). The first `firing` notification starts triage; repeats and `resolved` notifications are appended to the timeline without starting duplicate runs. By the time the engineer opens the link, a severity call and first hypotheses are waiting.

**Memory that fits a context window.**
- *Short-term:* the last 12 messages go to the model verbatim.
- *Long-term:* once 8+ messages scroll out of that window, the model folds them into a ≤180-word rolling summary, keeping early facts (first alert time, what was ruled out).
- *Stack memory:* described once, used to tailor every command.
- *Feedback loop:* the latest triage result is injected into later chat turns, so chat and pipeline share one picture of the incident.
- The assistant's reply is saved even if the browser disconnects mid-stream; if the model call fails before streaming starts, the unanswered message is rolled back so a resend doesn't duplicate it.

**Diagnose down the layers.** Prompts push the model from symptom → orchestrator → host OS → network, with platform commands (`etcdctl`, `kafka-consumer-groups`, `SHOW POOLS`, `ceph -s`, PromQL) and Linux commands (`ss`, `iostat`, `vmstat`, `dmesg`, `journalctl`, `perf`) where the host could be involved. It is told never to invent log output or metrics, and to offer the safer option before risky actions.

**Structured output with a safety net.** Classification and hypotheses use Workers AI JSON-schema mode, then get normalised (valid severity enum, arrays always present), so a model that drifts from the schema can't break the UI.

## Run it

**Prerequisites:** Node.js 18+ and a Cloudflare account (the free plan works; Workers AI has a free daily allowance).

```bash
git clone https://github.com/<your-username>/cf_ai_incident_copilot.git
cd cf_ai_incident_copilot
npm install
npx wrangler login
```

### Local development

```bash
cp .dev.vars.example .dev.vars   # optional: enables the alert webhook locally
npm run dev
```

Open http://localhost:8787. Durable Objects, Workflows and static assets run locally in `workerd`; Workers AI calls are proxied to your Cloudflare account (they use your quota, and Wrangler will ask you to log in).

### Deploy

```bash
npm run deploy
npx wrangler secret put ALERT_WEBHOOK_TOKEN   # optional: enables the alert webhook
```

Wrangler prints the `*.workers.dev` URL. No extra resources need creating: the Durable Object migration and the Workflow are declared in `wrangler.jsonc`. Until `ALERT_WEBHOOK_TOKEN` is set, the webhook returns `503` (disabled by default).

### Checks

```bash
npm run check   # generate binding types, tsc --noEmit, wrangler deploy --dry-run
```

GitHub Actions runs the same checks on every push and PR (`.github/workflows/ci.yml`). To deploy automatically on pushes to `main`, add repository secrets `CLOUDFLARE_API_TOKEN` (template: *Edit Cloudflare Workers*) and `CLOUDFLARE_ACCOUNT_ID`.

## Try it

### From chat

1. Paste a stack into **Stack memory**, e.g. `Bare-metal Linux fleet, Kubernetes 1.30 (etcd 3.5, 3 members), Kafka 3.7 + ZooKeeper, Postgres 15 behind PgBouncer, Ceph via Rook, Prometheus/Alertmanager`, and click **Remember stack**.
2. Pick an example incident or describe one: *"PgBouncer cl_waiting is spiking on the billing pool and services see 'no more connections allowed'. Postgres itself shows plenty of headroom."*
3. Answer the copilot's follow-up questions with what you "see" (logs, metrics, command output).
4. Click **Run triage**. Watch the five steps finish, then read the severity, hypotheses with diagnostic commands, and the postmortem draft (copy it with one click).
5. Reload the page or open the URL later: the `#session-id` in the URL brings back the whole incident.

### From an alert

```bash
curl -X POST "$URL/api/alerts/alertmanager" \
  -H "Authorization: Bearer $ALERT_WEBHOOK_TOKEN" \
  -H "content-type: application/json" \
  -d @examples/alert-kafka-lag.json
# → {"sessionId":"…","url":"https://…/#…","triageStarted":true,"reportId":"…"}
```

Open the returned `url`: the alerts are on the timeline and triage is already running. Send the same file again and it joins the same incident without a second triage run. To wire up a real Alertmanager, see [`examples/alertmanager.yml`](examples/alertmanager.yml).

## API

| Method | Path | Description |
|---|---|---|
| `POST` | `/api/sessions` | Create a session id |
| `GET` | `/api/sessions/:id` | Timeline, stack, summary, reports |
| `DELETE` | `/api/sessions/:id` | Wipe the session |
| `PUT` | `/api/sessions/:id/stack` | `{ "stack": "..." }` |
| `POST` | `/api/sessions/:id/chat` | `{ "message": "..." }` → streamed `text/plain` |
| `POST` | `/api/sessions/:id/triage` | Start the workflow → `{ "reportId" }` |
| `GET` | `/api/sessions/:id/triage/:reportId` | Workflow status and report |
| `POST` | `/api/alerts/alertmanager` | Alertmanager webhook (`Authorization: Bearer …`) → `{ sessionId, url, triageStarted, reportId }` |

## Project layout

```
src/
  index.ts      Worker entry: API router, alert webhook, exports DO + Workflow classes
  session.ts    IncidentSession Durable Object (SQLite memory, streaming chat, summarisation)
  workflow.ts   TriageWorkflow (classify → hypothesise → postmortem → save)
  alerts.ts     Alertmanager payload parsing, group → session mapping, token check
  llm.ts        Workers AI helpers: streaming, JSON mode, SSE parsing
  prompts.ts    Every prompt the app sends to the model
public/         Chat UI (HTML/CSS/vanilla JS, no build step)
examples/       Sample Alertmanager payload and receiver config
wrangler.jsonc  Bindings: AI, Durable Object, Workflow, assets
PROMPTS.md      AI prompts used to build this project
```

## Limitations and next steps

- LLMs can get exact CLI flags wrong (in live testing Llama 3.3 suggested `kafka-topics --under-replicated` instead of `--under-replicated-partitions`). That is why diagnostic commands are presented as checks for the engineer to run and confirm, never executed automatically.
- Chat sessions rely on unguessable ids rather than login; put Cloudflare Access in front before using it with real incident data.
- Post triage results back to Slack/PagerDuty, and accept PagerDuty and Grafana webhooks as well as Alertmanager.
- Retrieval over past postmortems (Vectorize) so the copilot can say "this looks like INC-142".
- Read-only tool use: let the model run allow-listed queries (PromQL, `kubectl get`) itself instead of asking the engineer to paste output.
- Voice input via Realtime / Whisper on Workers AI for hands-busy on-call engineers.