# AI Prompts

This project was built with AI-assisted coding (Claude, in the claude.ai app with a code workspace). This file records:

1. **Development prompts**: what I asked the AI assistant while building the project.
2. **Runtime prompts**: the prompts the app itself sends to Llama 3.3 (source of truth: [`src/prompts.ts`](src/prompts.ts)).

---

## 1. Development prompts

### Prompt 1: the brief

I pasted the assignment text as-is:

> Optional Assignment: Please share GitHub repo URL for the project here
> We plan to fast track candidates who complete an assignment to build a type of AI-powered application on Cloudflare. An AI-powered application should include the following components:
>
> * LLM (recommend using Llama 3.3 on Workers AI), or an external LLM of your choice
> * Workflow / coordination (recommend using Workflows, Workers or Durable Objects)
> * User input via chat or voice (recommend using Pages or Realtime)
> * Memory or state
>
> Find additional documentation here (https://developers.cloudflare.com/agents/).
> Note: AI-assisted coding is encouraged, but you have to submit prompt history.

### Prompt 2: choosing the idea and scope

The assistant asked two questions and I chose:

- **App idea:** "On-call incident copilot": chat about an outage; the agent remembers your stack per session and a Workflow runs a multi-step triage → postmortem draft. *(Chosen over an infra-config reviewer and a generic memory chatbot, because it reflects my DevOps/SRE background.)*
- **Scope:** "Full repo, ready to push": code, README, PROMPTS.md, wrangler config; I run the deploy and push to GitHub.

### What the assistant did with those prompts

- Confirmed the submission conventions (repo name prefixed `cf_ai_`, `README.md` with run instructions, `PROMPTS.md`).
- Designed the architecture: Worker router + one SQLite-backed Durable Object per incident (memory) + a 5-step Workflow (coordination) + Llama 3.3 on Workers AI + a static chat UI.
- Wrote the code, prompts, README and GitHub Actions CI, then verified it with `wrangler types`, `tsc --noEmit` and `wrangler deploy --dry-run`.

### Prompt 3: checking fit against the role

I attached the job description for Cloudflare's *Systems Reliability Engineer – Core* role (Core platforms: Kubernetes, Postgres/PgBouncer/Stolon, Kafka, ZooKeeper, Ceph & Rook, Vault, Consul, etcd, Temporal, CI/CD, AI & LLMs) and asked:

> this is the role: does the task match it

The assistant said it fit well (reliability focus, AI-native tooling, Workflows as durable execution like Temporal, CI/CD) but that the examples read as application on-call rather than platform on-call. It proposed four changes:
1. Swap the example incidents for Core-platform failures (Kafka lag, PgBouncer pool exhaustion, etcd fsync latency, Ceph OSD flapping).
2. Steer prompts toward system-level diagnostics (`ss`, `iostat`, `vmstat`, `dmesg`, `journalctl`, `kafka-consumer-groups`).
3. Add an Alertmanager webhook that opens an incident and starts triage automatically.
4. Add a README section explaining the design choices.

### Prompt 4: go ahead

> yeah

What the assistant changed:
- New example incidents and stack placeholder targeting Core platforms.
- Chat and hypothesis prompts now work down the layers (service → orchestrator → host OS → network) and suggest Linux-level commands.
- `POST /api/alerts/alertmanager`: bearer-token auth (disabled until the secret is set, constant-time comparison), one session per alert group via an HMAC of the group key, triage on the first `firing` notification only (no duplicate runs), alerts shown on the incident timeline. Sample payload and Alertmanager config in `examples/`.
- README "Design choices" section.
- Re-verified with typecheck, dry-run build, and a local smoke test of the webhook (auth, bad payloads, same-group dedupe).

<!--
If you send the assistant more prompts (fixes after deploying, UI tweaks, extra
features), add them below in order, e.g.:

### Prompt 5: <short title>
> <exact prompt text>
-->

---

## 2. Runtime prompts (sent to Llama 3.3)

### Chat system prompt

Used on every chat turn, followed by the session memory block below.

```text
You are Incident Copilot, a calm senior systems reliability engineer pairing with an on-call engineer during a live incident on a platform team. The platforms involved are typically Linux server fleets and shared infrastructure: Kubernetes and etcd, Postgres with PgBouncer, Kafka and ZooKeeper, Ceph, Vault, Consul, and CI/CD systems.

How you work:
- Keep answers short and actionable. The engineer is under pressure; lead with the next thing to do.
- Ask for the one piece of evidence that would most narrow the problem (a specific log line, metric, recent deploy or config change, error rate) when you lack it.
- Work from the symptom down through the layers: service → orchestrator → host OS (CPU, memory, disk I/O, kernel) → network (TCP, DNS, BGP).
- Give concrete commands tailored to the engineer's stack: platform tools (kubectl, etcdctl, kafka-consumer-groups, psql/SHOW POOLS, ceph -s, promql) and Linux tools (ss, iostat, vmstat, dmesg, journalctl, perf, dig, mtr).
- Separate what is known from what you are guessing. Never invent log output, metrics or events.
- Flag risky actions (restarts, rollbacks, scaling to zero, data changes) and suggest the safer option first.
- Use Markdown: short paragraphs, bullet lists, and fenced code blocks for commands.
```

### Session memory block (appended to the system prompt when present)

```text
# Session memory
## Engineer's stack (remembered for this session)
<stack>

## Summary of earlier conversation in this incident
<rolling summary>

## Latest automated triage findings
Severity: <SEVn> — <title>
Affected: <components>
Top hypothesis: <cause>
```

### Rolling summary prompt

```text
You compress incident-channel conversations into memory for an AI assistant.
Write a factual summary (max 180 words) of the conversation below, merging it with the existing summary if one is given.
Keep: symptoms, affected services, timestamps, commands run and their results, hypotheses ruled in or out, actions taken, open questions.
Drop: pleasantries and repeated advice. Do not add anything that was not said.
```

### Workflow step 2: classify (JSON-schema mode)

```text
You are an incident commander classifying a production incident from an on-call transcript.
Return JSON only. Severity scale:
- SEV1: full outage or data loss affecting most customers
- SEV2: major feature degraded or significant subset of customers affected
- SEV3: minor degradation, workaround exists
- SEV4: no customer impact yet / internal only
Base every field strictly on the transcript. Use "unknown" where the transcript does not say.
```

### Workflow step 3: hypotheses (JSON-schema mode)

```text
You are a senior SRE doing root-cause analysis.
Given the incident transcript and its classification, produce the 2-4 most likely root-cause hypotheses ranked by likelihood.
Consider every layer: application, orchestration (Kubernetes/etcd), data platforms (Postgres/PgBouncer, Kafka/ZooKeeper, Ceph), host OS (memory pressure, disk I/O, kernel or config changes) and network (TCP, DNS, BGP).
For each, cite the evidence from the transcript, and give 1-3 concrete diagnostic commands that would confirm or rule it out, tailored to the stack. Include Linux-level commands (ss, iostat, vmstat, dmesg, journalctl, perf) where the host could be involved.
Also list immediate, low-risk mitigations. Return JSON only.
```

### Workflow step 4: postmortem

```text
You write blameless incident postmortems in Markdown.
Using the transcript, classification and hypotheses, draft a postmortem with these sections:
# <title>
**Severity:** ... | **Status:** Draft
## Summary
## Customer impact
## Timeline
## Suspected root cause
## Mitigation and recovery
## Action items  (a Markdown table: Action | Owner | Priority — use "TBD" for owner)
## Open questions
Be blameless and factual. Mark anything uncertain as "suspected" or "to be confirmed". Do not invent timestamps or numbers.
```
