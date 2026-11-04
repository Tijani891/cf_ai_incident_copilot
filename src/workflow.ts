import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { CLASSIFY_PROMPT, HYPOTHESIS_PROMPT, POSTMORTEM_PROMPT } from "./prompts";
import { complete, completeJson } from "./llm";

export type TriageParams = { sessionId: string; reportId: string };

export type Classification = {
  title: string;
  severity: "SEV1" | "SEV2" | "SEV3" | "SEV4";
  affected_components: string[];
  customer_impact: string;
  timeline: { time: string; event: string }[];
};

export type Analysis = {
  hypotheses: { cause: string; likelihood: "high" | "medium" | "low"; evidence: string; checks: string[] }[];
  immediate_mitigations: string[];
};

export type TriageReport = {
  classification: Classification;
  analysis: Analysis;
  postmortem: string;
  generatedAt: string;
};

const CLASSIFICATION_SCHEMA = {
  type: "object",
  properties: {
    title: { type: "string" },
    severity: { type: "string", enum: ["SEV1", "SEV2", "SEV3", "SEV4"] },
    affected_components: { type: "array", items: { type: "string" } },
    customer_impact: { type: "string" },
    timeline: {
      type: "array",
      items: {
        type: "object",
        properties: { time: { type: "string" }, event: { type: "string" } },
        required: ["time", "event"],
      },
    },
  },
  required: ["title", "severity", "affected_components", "customer_impact", "timeline"],
};

const ANALYSIS_SCHEMA = {
  type: "object",
  properties: {
    hypotheses: {
      type: "array",
      items: {
        type: "object",
        properties: {
          cause: { type: "string" },
          likelihood: { type: "string", enum: ["high", "medium", "low"] },
          evidence: { type: "string" },
          checks: { type: "array", items: { type: "string" } },
        },
        required: ["cause", "likelihood", "evidence", "checks"],
      },
    },
    immediate_mitigations: { type: "array", items: { type: "string" } },
  },
  required: ["hypotheses", "immediate_mitigations"],
};

const LLM_STEP = {
  retries: { limit: 3, delay: "5 seconds", backoff: "exponential" },
  timeout: "2 minutes",
} as const;

/**
 * Durable, multi-step triage pipeline. Each step is checkpointed by Workflows, so a
 * transient Workers AI failure retries only that step instead of the whole run.
 *
 *   load incident → classify severity → root-cause hypotheses → draft postmortem → save to session
 */
export class TriageWorkflow extends WorkflowEntrypoint<Env, TriageParams> {
  async run(event: WorkflowEvent<TriageParams>, step: WorkflowStep): Promise<TriageReport> {
    const { sessionId, reportId } = event.payload;
    const session = () => this.env.SESSIONS.get(this.env.SESSIONS.idFromName(sessionId));

    try {
      const incident = await step.do("load incident from session memory", async () => {
        const t = await session().getTranscript();
        // Keep the most recent part if the transcript is very long.
        return { ...t, transcript: t.transcript.slice(-24_000) };
      });

      const context = [
        incident.stack && `STACK:\n${incident.stack}`,
        incident.summary && `EARLIER SUMMARY:\n${incident.summary}`,
        `TRANSCRIPT:\n${incident.transcript}`,
      ]
        .filter(Boolean)
        .join("\n\n");

      const classification = await step.do("classify severity and impact", LLM_STEP, async () => {
        const c = await completeJson<Classification>(
          this.env,
          [
            { role: "system", content: CLASSIFY_PROMPT },
            { role: "user", content: context },
          ],
          CLASSIFICATION_SCHEMA,
        );
        return normaliseClassification(c);
      });

      const analysis = await step.do("generate root-cause hypotheses", LLM_STEP, async () => {
        const a = await completeJson<Analysis>(
          this.env,
          [
            { role: "system", content: HYPOTHESIS_PROMPT },
            { role: "user", content: `${context}\n\nCLASSIFICATION:\n${JSON.stringify(classification, null, 2)}` },
          ],
          ANALYSIS_SCHEMA,
          { maxTokens: 2048 },
        );
        return normaliseAnalysis(a);
      });

      const postmortem = await step.do("draft postmortem", LLM_STEP, async () =>
        complete(
          this.env,
          [
            { role: "system", content: POSTMORTEM_PROMPT },
            {
              role: "user",
              content: `${context}\n\nCLASSIFICATION:\n${JSON.stringify(classification)}\n\nHYPOTHESES:\n${JSON.stringify(analysis)}`,
            },
          ],
          { maxTokens: 2048, temperature: 0.3 },
        ),
      );

      const report: TriageReport = {
        classification,
        analysis,
        postmortem: postmortem.trim(),
        generatedAt: new Date().toISOString(),
      };

      await step.do("save report to session memory", async () => {
        await session().finishReport(reportId, { report });
      });

      return report;
    } catch (err) {
      await step.do("record failure", async () => {
        await session().finishReport(reportId, { error: (err as Error).message });
      });
      throw err;
    }
  }
}

// The model occasionally drifts from the schema; coerce into a safe shape.
function normaliseClassification(c: Partial<Classification>): Classification {
  const sev = String(c.severity ?? "").toUpperCase();
  return {
    title: c.title?.trim() || "Untitled incident",
    severity: (["SEV1", "SEV2", "SEV3", "SEV4"].includes(sev) ? sev : "SEV3") as Classification["severity"],
    affected_components: Array.isArray(c.affected_components) ? c.affected_components.map(String) : [],
    customer_impact: c.customer_impact?.trim() || "unknown",
    timeline: Array.isArray(c.timeline)
      ? c.timeline.map((t) => ({ time: String(t?.time ?? "unknown"), event: String(t?.event ?? "") }))
      : [],
  };
}

function normaliseAnalysis(a: Partial<Analysis>): Analysis {
  const hyps = Array.isArray(a.hypotheses) ? a.hypotheses : [];
  return {
    hypotheses: hyps.slice(0, 4).map((h) => ({
      cause: String(h?.cause ?? ""),
      likelihood: (["high", "medium", "low"].includes(String(h?.likelihood)) ? h.likelihood : "medium") as
        | "high"
        | "medium"
        | "low",
      evidence: String(h?.evidence ?? ""),
      checks: Array.isArray(h?.checks) ? h.checks.map(String) : [],
    })),
    immediate_mitigations: Array.isArray(a.immediate_mitigations) ? a.immediate_mitigations.map(String) : [],
  };
}
