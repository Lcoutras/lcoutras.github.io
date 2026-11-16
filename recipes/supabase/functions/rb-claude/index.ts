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

  let body: { k?: string; prompt?: string; images?: { media_type: string; data: string }[]; ping?: boolean; web?: boolean };
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

  // Recipe lookups get web search (find real recipes for the dish) and web fetch (read the
  // linked page or a search result). Facebook, TikTok and Instagram block outside readers.
  const tools = body.web
    ? [{ type: "web_search_20260209", name: "web_search", max_uses: 5 }, { type: "web_fetch_20260209", name: "web_fetch", max_uses: 4 }]
    : undefined;
  const client = new Anthropic({ apiKey });
  try {
    const messages: Anthropic.Beta.BetaMessageParam[] = [{ role: "user", content }];
    let response;
    // The server-side search loop can pause; resend the turn so it resumes (at most a few times).
    for (let round = 0; round < 4; round++) {
      response = await client.beta.messages.create({
        model: MODEL,
        max_tokens: 16000,
        output_config: { effort: "medium" },
        betas: ["server-side-fallback-2026-07-01"],
        fallbacks: "default",
        ...(tools ? { tools } : {}),
        messages,
      } as Anthropic.Beta.MessageCreateParamsNonStreaming);
      if (response.stop_reason !== "pause_turn") break;
      if (messages.length > 1) messages.pop();
      messages.push({ role: "assistant", content: response.content as Anthropic.Beta.BetaContentBlockParam[] });
    }
    if (!response) return reply(500, { code: "unavailable", message: "No answer" });
    if (response.stop_reason === "refusal") {
      return reply(422, { code: "refused", message: "Claude declined this request." });
    }
    // Keep only the answer written after the last search or fetch, not the commentary in between.
    const blocks = response.content as { type: string; text?: string }[];
    let last = -1;
    blocks.forEach((b, i) => { if (b.type === "server_tool_use" || b.type.endsWith("_tool_result")) last = i; });
    const text = blocks.slice(last + 1).filter((b) => b.type === "text").map((b) => b.text || "").join("");
    const searches = (response.usage as { server_tool_use?: { web_search_requests?: number; web_fetch_requests?: number } })?.server_tool_use;
    return reply(200, { text, truncated: response.stop_reason === "max_tokens", searches: searches?.web_search_requests || 0, fetches: searches?.web_fetch_requests || 0 });
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
