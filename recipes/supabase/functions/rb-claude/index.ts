// Family Recipe Box: asks Claude for the website (reading posts, filling in recipes,
// categories, nutrition, grocery lists). Only callers with the family key get through,
// and the Anthropic API key stays here as a secret, never in the website's code.
import Anthropic from "npm:@anthropic-ai/sdk@1.8.0";

const MODEL = "claude-sonnet-5-5";
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const reply = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });

// Same check the website's data uses: the family key must match the stored hash.
async function keyOk(k: string): Promise<boolean> {
  const url = Deno.env.get("SUPABASE_URL");
  const anon = Deno.env.get("SUPABASE_ANON_KEY");
  if (!url || !anon || !k) return false;
  const res = await fetch(`${url}/rest/v1/rpc/rb_now`, {
    method: "POST",
    headers: { apikey: anon, Authorization: `Bearer ${anon}`, "Content-Type": "application/json" },
    body: JSON.stringify({ k }),
  });
  return res.ok;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return reply(405, { code: "invalid_argument", message: "POST only" });

  let body: { k?: string; prompt?: string; images?: { media_type: string; data: string }[]; ping?: boolean };
  try { body = await req.json(); } catch { return reply(400, { code: "invalid_argument", message: "Bad JSON" }); }

  if (!(await keyOk(String(body.k || "")))) return reply(401, { code: "not_granted", message: "Family key not accepted" });

  const apiKey = Deno.env.get("ANTHROPIC_API_KEY");
  if (!apiKey) return reply(503, { code: "not_configured", message: "Claude isn't switched on yet: the Anthropic API key hasn't been added." });
  if (body.ping) return reply(200, { ok: true, model: MODEL });

  const prompt = String(body.prompt || "").slice(0, 60000);
  if (!prompt) return reply(400, { code: "invalid_argument", message: "Empty prompt" });
  const images = (Array.isArray(body.images) ? body.images : []).slice(0, 4)
    .filter((i) => i && /^image\/(jpeg|png|gif|webp)$/.test(i.media_type) && typeof i.data === "string" && i.data.length < 4_000_000);

  const content: Anthropic.Beta.BetaContentBlockParam[] = [
    ...images.map((i) => ({ type: "image" as const, source: { type: "base64" as const, media_type: i.media_type as "image/jpeg", data: i.data } })),
    { type: "text" as const, text: prompt },
  ];

  const client = new Anthropic({ apiKey });
  try {
    const response = await client.beta.messages.create({
      model: MODEL,
      max_tokens: 16000,
      output_config: { effort: "medium" },
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      messages: [{ role: "user", content }],
    } as Anthropic.Beta.MessageCreateParamsNonStreaming);

    if (response.stop_reason === "refusal") {
      return reply(422, { code: "refused", message: "Claude declined this request." });
    }
    const text = response.content.filter((b) => b.type === "text").map((b) => (b as { text: string }).text).join("");
    return reply(200, { text, truncated: response.stop_reason === "max_tokens" });
  } catch (err) {
    if (err instanceof Anthropic.RateLimitError) return reply(429, { code: "rate_limited", message: "Claude is busy. Try again in a minute." });
    if (err instanceof Anthropic.AuthenticationError) return reply(503, { code: "not_configured", message: "The Anthropic API key was not accepted." });
    if (err instanceof Anthropic.APIConnectionError) return reply(503, { code: "unavailable", message: "Couldn't reach Claude." });
    if (err instanceof Anthropic.APIError) {
      const status = err.status ?? 500;
      const msg = String(err.message || "");
      const code = status === 402 || /credit|balance|billing/i.test(msg) ? "no_credit" : status >= 500 ? "unavailable" : "invalid_argument";
      return reply(code === "invalid_argument" ? 400 : 503, { code, message: msg.slice(0, 300) });
    }
    return reply(500, { code: "unavailable", message: String((err as Error)?.message || err).slice(0, 300) });
  }
});
