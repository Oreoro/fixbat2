import type { Diagnoser } from "./model";
import { evidencePacket, fromRaw, RUBRIC, SCHEMA } from "./model";
import { toRepoPath } from "./repo";
import { callExternal, MODEL_TIMEOUT_MS } from "./http";
import type { Env } from "../types";

/**
 * Any endpoint that speaks the OpenAI chat-completions shape.
 *
 * One implementation covers GLM, DeepSeek, Together, OpenRouter, Groq and a
 * self-hosted vLLM — that last one being the answer for a client who will not
 * send production source code to a third party at all.
 *
 * It deliberately reuses this product's rubric, schema, evidence packet and
 * parser rather than defining its own. The evidence a model gets, and the
 * checks applied to what it returns, must not depend on who is serving it:
 * the only variable is the model. In particular the cited-commit filter in
 * saveBrief still applies, which matters more with a cheaper model, not less.
 */

/** Rates vary per provider, so a deployment supplies its own. */
function pricing(env: Env): { in: number; out: number } | null {
  const input = Number(env.OPENAI_PRICE_IN);
  const output = Number(env.OPENAI_PRICE_OUT);
  if (!Number.isFinite(input) || !Number.isFinite(output)) return null;
  return { in: input, out: output };
}

/**
 * Models wrap JSON in prose or in a fenced block often enough that trusting
 * the body verbatim loses briefs that were otherwise fine.
 */
function extractJson(text: string): unknown {
  const trimmed = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/```$/, "");
  try {
    return JSON.parse(trimmed);
  } catch {
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start < 0 || end <= start) {
      throw new Error(`model did not return JSON: ${trimmed.slice(0, 160)}`);
    }
    return JSON.parse(trimmed.slice(start, end + 1));
  }
}

export function openAICompatibleDiagnoser(env: Env): Diagnoser {
  const base = (env.OPENAI_BASE_URL ?? "").replace(/\/+$/, "");
  const model = env.OPENAI_MODEL || "gpt-4o-mini";

  async function complete(evidence: string, strictSchema: boolean): Promise<Response> {
    return callExternal(`${base}/chat/completions`, {
      what: `${model} (${new URL(base).host})`,
      // Not idempotent in cost terms, and a duplicate brief is worse than a
      // late one; the timeout is what this is protecting against.
      retry: false,
      // Inference, not a metadata call — see MODEL_TIMEOUT_MS.
      timeoutMs: MODEL_TIMEOUT_MS,
      method: "POST",
      headers: {
        authorization: `Bearer ${env.OPENAI_API_KEY ?? ""}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model,
        max_tokens: 4000,
        messages: [
          { role: "system", content: RUBRIC },
          { role: "user", content: evidence },
        ],
        response_format: strictSchema
          ? {
              type: "json_schema",
              json_schema: { name: "incident_brief", strict: true, schema: SCHEMA },
            }
          : { type: "json_object" },
      }),
    });
  }

  return {
    name: "openai-compatible",

    async diagnose(evidence) {
      const started = Date.now();
      const packet = evidencePacket(evidence);

      /**
       * `json_schema` is the stronger guarantee but is not universal across
       * OpenAI-compatible servers. Rather than maintain a list of who supports
       * what, ask for it and fall back once — the failure is a 400 naming
       * response_format, and it is deterministic per endpoint.
       */
      let res = await complete(packet, true);
      if (res.status === 400) {
        res = await complete(packet, false);
      }

      if (!res.ok) {
        const detail = (await res.text().catch(() => "")).slice(0, 200);
        throw new Error(`${model} ${res.status}: ${detail}`);
      }

      const body = (await res.json()) as {
        choices?: Array<{ message?: { content?: string }; finish_reason?: string }>;
        usage?: { prompt_tokens?: number; completion_tokens?: number };
      };

      const choice = body.choices?.[0];
      if (choice?.finish_reason === "length") {
        throw new Error(`${model} ran out of output tokens before finishing the brief`);
      }

      const content = choice?.message?.content;
      if (!content) throw new Error(`${model} returned no content`);

      const price = pricing(env);
      const usage = body.usage ?? {};
      return {
        brief: fromRaw(
          extractJson(content),
          evidence.frame ? toRepoPath(evidence.frame.file) : null,
        ),
        source: "openai-compatible",
        model,
        // Zero means "not priced", not "free" — /metrics says so.
        spendUsd: price
          ? ((usage.prompt_tokens ?? 0) * price.in + (usage.completion_tokens ?? 0) * price.out) /
            1_000_000
          : 0,
        durationMs: Date.now() - started,
      };
    },
  };
}
