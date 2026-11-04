import { DurableObject } from "cloudflare:workers";
import { CHAT_SYSTEM_PROMPT, SUMMARY_PROMPT, buildChatContext } from "./prompts";
import { complete, sseTextDeltas, streamCompletion, type ChatMessage } from "./llm";
import type { TriageReport } from "./workflow";

/** Messages kept verbatim in the prompt; older ones are folded into a rolling summary. */
const RECENT_WINDOW = 12;
/** Summarise once this many un-summarised messages have built up beyond the window. */
const SUMMARISE_AFTER = 8;

export type StoredMessage = { id: number; role: "user" | "assistant"; content: string; createdAt: number };
export type StoredReport = {
  id: string;
  status: "running" | "complete" | "errored";
  report: TriageReport | null;
  error: string | null;
  createdAt: number;
  updatedAt: number;
};

export type SessionState = {
  stack: string;
  summary: string;
  messages: StoredMessage[];
  reports: StoredReport[];
};

/**
 * One Durable Object per incident session. It is the app's memory:
 * - full chat transcript (SQLite)
 * - the engineer's stack description, remembered across turns
 * - a rolling LLM-written summary of older turns, so long incidents fit the context window
 * - triage reports produced by the TriageWorkflow, fed back into later chat turns
 */
export class IncidentSession extends DurableObject<Env> {
  private sql: SqlStorage;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.migrate();
  }

  private migrate(): void {
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS kv (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS reports (
        id TEXT PRIMARY KEY,
        status TEXT NOT NULL,
        report TEXT,
        error TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `);
  }

  // ---------- small key/value helpers ----------

  private get(key: string, fallback = ""): string {
    const row = this.sql.exec<{ value: string }>("SELECT value FROM kv WHERE key = ?", key).toArray()[0];
    return row?.value ?? fallback;
  }

  private set(key: string, value: string): void {
    this.sql.exec(
      "INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      key,
      value,
    );
  }

  private allMessages(): StoredMessage[] {
    return this.sql
      .exec<{ id: number; role: string; content: string; created_at: number }>(
        "SELECT id, role, content, created_at FROM messages ORDER BY id",
      )
      .toArray()
      .map((r) => ({ id: r.id, role: r.role as StoredMessage["role"], content: r.content, createdAt: r.created_at }));
  }

  private addMessage(role: StoredMessage["role"], content: string): void {
    this.sql.exec("INSERT INTO messages (role, content, created_at) VALUES (?, ?, ?)", role, content, Date.now());
  }

  private allReports(): StoredReport[] {
    return this.sql
      .exec<{ id: string; status: string; report: string | null; error: string | null; created_at: number; updated_at: number }>(
        "SELECT * FROM reports ORDER BY created_at DESC",
      )
      .toArray()
      .map((r) => ({
        id: r.id,
        status: r.status as StoredReport["status"],
        report: r.report ? (JSON.parse(r.report) as TriageReport) : null,
        error: r.error,
        createdAt: r.created_at,
        updatedAt: r.updated_at,
      }));
  }

  // ---------- RPC methods called by the Worker and the Workflow ----------

  async getState(): Promise<SessionState> {
    return {
      stack: this.get("stack"),
      summary: this.get("summary"),
      messages: this.allMessages(),
      reports: this.allReports(),
    };
  }

  async setStack(stack: string): Promise<void> {
    this.set("stack", stack.slice(0, 2000));
  }

  async reset(): Promise<void> {
    await this.ctx.storage.deleteAll();
    this.migrate(); // deleteAll drops the tables; recreate them for the next request
  }

  /** Used by the TriageWorkflow to read everything known about the incident. */
  async getTranscript(): Promise<{ stack: string; summary: string; transcript: string; messageCount: number }> {
    const messages = this.allMessages();
    return {
      stack: this.get("stack"),
      summary: this.get("summary"),
      transcript: messages.map((m) => `${m.role === "user" ? "ENGINEER" : "COPILOT"}: ${m.content}`).join("\n\n"),
      messageCount: messages.length,
    };
  }

  /** Appends an alert notification (from the Alertmanager webhook) to the incident timeline. */
  async ingestAlert(text: string): Promise<void> {
    this.addMessage("user", text);
  }

  /** True if a triage run started in the last 10 minutes hasn't finished (avoids duplicate runs per alert). */
  async hasActiveTriage(): Promise<boolean> {
    const row = this.sql
      .exec<{ n: number }>(
        "SELECT COUNT(*) AS n FROM reports WHERE status = 'running' AND created_at > ?",
        Date.now() - 10 * 60_000,
      )
      .one();
    return row.n > 0;
  }

  async startReport(id: string): Promise<void> {
    const now = Date.now();
    this.sql.exec(
      "INSERT OR IGNORE INTO reports (id, status, created_at, updated_at) VALUES (?, 'running', ?, ?)",
      id,
      now,
      now,
    );
  }

  async finishReport(id: string, result: { report?: TriageReport; error?: string }): Promise<void> {
    const now = Date.now();
    this.sql.exec(
      `INSERT INTO reports (id, status, report, error, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET status = excluded.status, report = excluded.report,
         error = excluded.error, updated_at = excluded.updated_at`,
      id,
      result.report ? "complete" : "errored",
      result.report ? JSON.stringify(result.report) : null,
      result.error ?? null,
      now,
      now,
    );
  }

  /**
   * Handles one chat turn. Returns a plain-text token stream for the browser; the
   * full reply is persisted once the model finishes, even if the client disconnects.
   */
  async chat(userMessage: string): Promise<ReadableStream<Uint8Array>> {
    this.addMessage("user", userMessage);

    let aiStream: ReadableStream<Uint8Array>;
    try {
      aiStream = await streamCompletion(this.env, this.buildPrompt());
    } catch (err) {
      // Don't leave an unanswered message behind; the user can simply resend.
      this.sql.exec("DELETE FROM messages WHERE id = (SELECT MAX(id) FROM messages)");
      throw err;
    }

    const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
    const writer = writable.getWriter();
    const encoder = new TextEncoder();

    const pump = (async () => {
      let reply = "";
      let clientGone = false;
      try {
        for await (const delta of sseTextDeltas(aiStream)) {
          reply += delta;
          if (!clientGone) {
            try {
              await writer.write(encoder.encode(delta));
            } catch {
              clientGone = true; // keep consuming so we can still save the reply
            }
          }
        }
      } catch (err) {
        const note = `\n\n_(Model stream interrupted: ${(err as Error).message})_`;
        reply += note;
        if (!clientGone) await writer.write(encoder.encode(note)).catch(() => {});
      } finally {
        if (reply.trim()) this.addMessage("assistant", reply.trim());
        if (!clientGone) await writer.close().catch(() => {});
      }
      await this.maybeSummarise();
    })();

    this.ctx.waitUntil(pump);
    return readable;
  }

  // ---------- prompt assembly and memory compaction ----------

  private buildPrompt(): ChatMessage[] {
    const all = this.allMessages();
    const recent = all.slice(-RECENT_WINDOW);

    const latest = this.allReports().find((r) => r.status === "complete")?.report;
    const latestTriage = latest
      ? [
          `Severity: ${latest.classification.severity} — ${latest.classification.title}`,
          `Affected: ${latest.classification.affected_components.join(", ") || "unknown"}`,
          `Top hypothesis: ${latest.analysis.hypotheses[0]?.cause ?? "none"}`,
        ].join("\n")
      : "";

    const system =
      CHAT_SYSTEM_PROMPT +
      buildChatContext({ stack: this.get("stack"), summary: this.get("summary"), latestTriage });

    return [{ role: "system", content: system }, ...recent.map((m) => ({ role: m.role, content: m.content }))];
  }

  /** Folds messages that have scrolled out of the recent window into the rolling summary. */
  private async maybeSummarise(): Promise<void> {
    const all = this.allMessages();
    const summarisedUpTo = Number(this.get("summarised_up_to", "0"));
    const outOfWindow = all.slice(0, Math.max(0, all.length - RECENT_WINDOW)).filter((m) => m.id > summarisedUpTo);
    if (outOfWindow.length < SUMMARISE_AFTER) return;

    const existing = this.get("summary");
    const convo = outOfWindow.map((m) => `${m.role.toUpperCase()}: ${m.content}`).join("\n\n");
    try {
      const summary = await complete(
        this.env,
        [
          { role: "system", content: SUMMARY_PROMPT },
          {
            role: "user",
            content: `Existing summary:\n${existing || "(none)"}\n\nNew conversation to merge:\n${convo}`,
          },
        ],
        { maxTokens: 400, temperature: 0.1 },
      );
      this.set("summary", summary.trim());
      this.set("summarised_up_to", String(outOfWindow[outOfWindow.length - 1].id));
    } catch (err) {
      console.warn("summary failed; will retry next turn", err);
    }
  }
}
