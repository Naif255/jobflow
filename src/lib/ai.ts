import "server-only";

const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";
export const MODELS = {
  /** Extraction, scoring, tailoring. */
  main: "anthropic/claude-sonnet-4.5",
  /** Cheap verification passes. */
  fast: "anthropic/claude-haiku-4.5",
} as const;

export class AIError extends Error {}

/** Strip ```json fences and any prose around the outermost JSON object/array. */
function extractJson(text: string): string {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = (fenced ? fenced[1] : text).trim();
  const start = body.search(/[{[]/);
  const end = Math.max(body.lastIndexOf("}"), body.lastIndexOf("]"));
  if (start === -1 || end < start) return body;
  return body.slice(start, end + 1);
}

/** Single entry point for every model call. Returns parsed JSON. */
export async function callAI<T>(
  system: string,
  user: string,
  { model = MODELS.main, maxTokens = 4000 }: { model?: string; maxTokens?: number } = {},
): Promise<T> {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) throw new AIError("OPENROUTER_API_KEY is not set");

  let res: Response;
  try {
    res = await fetch(OPENROUTER_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "X-Title": "jobflow",
      },
      body: JSON.stringify({
        model,
        max_tokens: maxTokens,
        temperature: 0.2,
        messages: [
          {
            role: "system",
            content: `${system}\n\nRespond with a single valid JSON value only. No markdown, no commentary.`,
          },
          { role: "user", content: user },
        ],
      }),
      signal: AbortSignal.timeout(120_000),
    });
  } catch (err) {
    throw new AIError(`فشل الاتصال بـ OpenRouter: ${(err as Error).message}`);
  }

  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new AIError(`أعاد OpenRouter الحالة ${res.status}: ${detail.slice(0, 500)}`);
  }

  const data = await res.json();
  if (data.error) throw new AIError(`خطأ من OpenRouter: ${data.error.message ?? JSON.stringify(data.error)}`);

  const content: unknown = data.choices?.[0]?.message?.content;
  if (typeof content !== "string" || !content.trim()) throw new AIError("أعاد النموذج رداً فارغاً");

  try {
    return JSON.parse(extractJson(content)) as T;
  } catch {
    throw new AIError(`لم يُرجع النموذج JSON صالحاً: ${content.slice(0, 300)}`);
  }
}
