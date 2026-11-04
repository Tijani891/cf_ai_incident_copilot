# AI Prompts

I built this project with an AI coding assistant (Claude, in the claude.ai app with a code workspace). This file records:

1. **How the work was split**: what I decided and did, and what the assistant did.
2. **Development prompts**: every prompt I sent, in order, with what came out of it.
3. **Runtime prompts**: the prompts the app itself sends to Llama 3.3 (source of truth: [`src/prompts.ts`](src/prompts.ts)).

---

## 1. How the work was split

**My decisions and work**
- Chose the product: an on-call incident copilot, picked over an infra-config reviewer and a generic memory chatbot because it matches my DevOps/SRE background.
- Checked the build against the *Systems Reliability Engineer – Core* job description and asked whether it fit. That review is what retargeted the project from application on-call to platform on-call and led to the Alertmanager webhook.
- Owned delivery: created the GitHub repo, pushed the code, created a scoped Cloudflare API token, set up the GitHub Actions secrets, and shipped the first deploy through CI.
- Made CI decisions: confirmed the pipeline would stay green before secrets existed, and removed the `pull_request` trigger so CI runs only on pushes to `main`.
- Tested the deployed app live against a Kafka incident scenario and reviewed the model's answer (it surfaced a wrong `kafka-topics` flag, now noted under Limitations in the README).
- Published the live demo URL in the README.

**The assistant's work**
- Architecture and code: Worker router, SQLite-backed Durable Object per incident, the 5-step triage Workflow, Workers AI helpers, chat UI, and the Alertmanager webhook.
- Prompt engineering for the runtime prompts in section 3.
- README, CI workflow, sample alert payload and Alertmanager config.
- Verification: typecheck, `wrangler deploy --dry-run`, local smoke tests (which caught a session-reset bug and a guessable alert-session id, both fixed).

---

## 2. Development prompts

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

The assistant offered three ideas and two scopes. I chose:

- **App idea:** on-call incident copilot: chat about an outage, the agent remembers the stack per session, and a Workflow runs a multi-step triage → postmortem draft.
- **Scope:** full repo ready to push; I would do the deploy and push to GitHub.

Result: the first version of the app (architecture, code, README, CI), verified with `wrangler types`, `tsc --noEmit` and `wrangler deploy --dry-run`.

### Prompt 3: checking fit against the role

I attached the job description for Cloudflare's *Systems Reliability Engineer – Core* role (Kubernetes, Postgres/PgBouncer/Stolon, Kafka, ZooKeeper, Ceph & Rook, Vault, Consul, etcd, Temporal, CI/CD, AI & LLMs) and asked:

> this is the role: does the task match it

The assistant agreed it fit (reliability focus, AI-native tooling, Workflows as durable execution like Temporal, CI/CD) but said the examples read as application on-call rather than platform on-call, and proposed four changes: Core-platform example incidents, system-level diagnostics in the prompts, an Alertmanager webhook, and a design-choices section in the README.

### Prompt 4: approving the changes

> yeah

Result: Core-platform examples; prompts that work down the layers (service → orchestrator → host OS → network) with Linux-level commands; `POST /api/alerts/alertmanager` with bearer-token auth (disabled until the secret is set, constant-time comparison), one session per alert group via an HMAC of the group key, and triage only on the first `firing` notification; README design-choices section. Re-verified with typecheck, dry-run build and a local webhook smoke test.

### Prompt 5: naming the repo

> i want to create a new repo for the task, what should i name it

Answer: `cf_ai_incident_copilot` (Cloudflare requires the `cf_ai_` prefix, and the name was already used in the README and commands). I created it as a public repo.

### Prompt 6: pushing

> i want to push to this repo: https://github.com/Tijani891/cf_ai_incident_copilot.git

The assistant couldn't push for me (my GitHub account wasn't linked), so I pushed it myself from my machine using the commands it gave me.

### Prompt 7: CI before secrets exist

> if i push the pipeline will start and i haven't yet added the env vrs

Answer: the `check` job needs no secrets (the dry-run build never contacts Cloudflare), and the `deploy` job skips itself until `CLOUDFLARE_API_TOKEN` is set, so the first push stays green.

### Prompt 8: deploy credentials

> how do i get teh follwoing: CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID

I created the token myself, checking each step with the assistant: I picked the **Edit Cloudflare Workers** template (not *Workers AI*, which can't deploy), scoped it to my account, left IP filtering off because GitHub runners use changing IPs, and reviewed the permission summary before creating it. Then I added both values as GitHub Actions secrets.

### Prompt 9: CI trigger

> i want to remive the pull_request part

My decision: CI now runs only on pushes to `main`. The assistant confirmed nothing else needed changing and mentioned `workflow_dispatch` as an option for manual runs.

### Prompt 10: first deploy

I shared the GitHub Actions deploy log. The Worker, Durable Object, Workflow, AI binding and assets all deployed to `https://cf-ai-incident-copilot.ahmedtijani1792.workers.dev`, and the assistant confirmed the page was live.

### Prompt 11: live test

I ran the Kafka example in the deployed app and shared the transcript:

> Kafka consumer lag on the logs-ingest group has been climbing since we rolling-restarted broker 3 at 14:05. Under-replicated partitions alert is firing.

Llama 3.3 asked for evidence first and suggested `kafka-topics --describe` and `kafka-consumer-groups --describe`. Reviewing it caught a wrong flag (`--under-replicated` should be `--under-replicated-partitions`), which is why diagnostic commands are framed as checks for the engineer to run and confirm.

### Prompt 12: live demo link

> here is the app url: https://cf-ai-incident-copilot.ahmedtijani1792.workers.dev/#3ba92b9c-… i want to add it to the readme file

I added the base URL without the session id, so reviewers each start a fresh incident instead of sharing (and being able to edit) my test session.

### Prompt 13: this file

> edit the prompt to reflect that we both worked on it, like i asked questions valid to the build and something to show my input as 40% and yours was like 60%, you get?

Result: this rewrite, which lists every prompt verbatim and separates my decisions from the assistant's work. We left out a percentage, since the prompts above show the split directly.

<!--
If you send the assistant more prompts, add them below in order:

### Prompt 14: <short title>
> <exact prompt text>
-->

---

## 3. Runtime prompts (sent to Llama 3.3)

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