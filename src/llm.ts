// Thin helpers around Workers AI so the rest of the code stays readable.

export type ChatMessage = { role: "system" | "user" | "assistant"; content: string };

type AiRunner = { run: (model: string, input: Record<string, unknown>) => Promise<unknown> };

function runner(env: Env): AiRunner {
  // The Ai binding's overloads are keyed on literal model names; we keep the
  // model configurable via the MODEL var, so call through a loose signature.
  return env.AI as unknown as AiRunner;
}

/** Non-streaming completion that returns plain text. */
export async function complete(
  env: Env,
  messages: ChatMessage[],
  opts: { maxTokens?: number; temperature?: number } = {},
): Promise<string> {
  const out = (await runner(env).run(env.MODEL, {
    messages,
    max_tokens: opts.maxTokens ?? 1024,
    temperature: opts.temperature ?? 0.3,
  })) as { response?: unknown };
  const r = out?.response;
  return typeof r === "string" ? r : JSON.stringify(r ?? "");
}

/**
 * Completion constrained to a JSON schema (Workers AI JSON mode). Falls back to
 * extracting the first JSON object from free text if the model ignores the schema.
 */
export async function completeJson<T>(
  env: Env,
  messages: ChatMessage[],
  schema: Record<string, unknown>,
  opts: { maxTokens?: number } = {},
): Promise<T> {
  const out = (await runner(env).run(env.MODEL, {
    messages,
    max_tokens: opts.maxTokens ?? 1536,
    temperature: 0.2,
    response_format: { type: "json_schema", json_schema: schema },
  })) as { response?: unknown };

  const r = out?.response;
  if (r && typeof r === "object") return r as T;
  if (typeof r === "string") return parseJsonLoose<T>(r);
  throw new Error("Model returned an empty response");
}

export function parseJsonLoose<T>(text: string): T {
  try {
    return JSON.parse(text) as T;
  } catch {
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start !== -1 && end > start) return JSON.parse(text.slice(start, end + 1)) as T;
    throw new Error(`Model did not return JSON: ${text.slice(0, 200)}`);
  }
}

/** Starts a streaming completion and returns the raw SSE stream from Workers AI. */
export async function streamCompletion(
  env: Env,
  messages: ChatMessage[],
): Promise<ReadableStream<Uint8Array>> {
  const out = await runner(env).run(env.MODEL, {
    messages,
    stream: true,
    max_tokens: 1024,
    temperature: 0.4,
  });
  if (!(out instanceof ReadableStream)) throw new Error("Expected a stream from Workers AI");
  return out as ReadableStream<Uint8Array>;
}

/**
 * Iterates the text deltas in a Workers AI SSE stream. Handles both the native
 * `{"response": "..."}` shape and the OpenAI-style `choices[0].delta.content` shape.
 */
export async function* sseTextDeltas(stream: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        const text = parseSseLine(line);
        if (text) yield text;
      }
    }
    const tail = parseSseLine(buffer.trim());
    if (tail) yield tail;
  } finally {
    reader.releaseLock();
  }
}

function parseSseLine(line: string): string {
  if (!line.startsWith("data:")) return "";
  const payload = line.slice(5).trim();
  if (!payload || payload === "[DONE]") return "";
  try {
    const j = JSON.parse(payload) as {
      response?: string;
      choices?: { delta?: { content?: string } }[];
    };
    return j.response ?? j.choices?.[0]?.delta?.content ?? "";
  } catch {
    return "";
  }
}
