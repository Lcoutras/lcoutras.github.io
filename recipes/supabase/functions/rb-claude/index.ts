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

// ---------- photos: the main picture from recipe pages Claude used ----------
const safePage = (u: string) => {
  try {
    const x = new URL(u);
    if (!/^https?:$/.test(x.protocol)) return null;
    const h = x.hostname.toLowerCase();
    if (h === "localhost" || h.endsWith(".local") || h.endsWith(".internal") || /^[\d.]+$/.test(h) || h.includes(":")) return null;
    return x;
  } catch { return null; }
};
async function fetchLimited(u: URL, maxBytes: number, accept: string) {
  const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 7000);
  try {
    const res = await fetch(u, { signal: ctl.signal, redirect: "follow", headers: { "User-Agent": "Mozilla/5.0 (compatible; FamilyRecipeBox/1.0)", Accept: accept } });
    if (!res.ok || !res.body) return null;
    const reader = res.body.getReader(); const chunks: Uint8Array[] = []; let n = 0;
    while (true) { const { done, value } = await reader.read(); if (done) break; n += value.length; if (n > maxBytes) { ctl.abort(); return null; } chunks.push(value); }
    const out = new Uint8Array(n); let o = 0; for (const c of chunks) { out.set(c, o); o += c.length; }
    return { bytes: out, type: (res.headers.get("content-type") || "").split(";")[0].trim().toLowerCase(), url: res.url };
  } catch { return null; } finally { clearTimeout(t); }
}
function imageFromHtml(html: string, base: string): string | null {
  const meta = (attr: string) => {
    const re = new RegExp(`<meta[^>]+(?:property|name)=["']${attr}["'][^>]*>`, "i"); const m = html.match(re);
    const c = m && m[0].match(/content=["']([^"']+)["']/i); return c ? c[1] : null; };
  let img = meta("og:image") || meta("og:image:url") || meta("twitter:image") || meta("twitter:image:src");
  if (!img) { // recipe pages often put the photo in their structured recipe data
    const ld = html.match(/"image"\s*:\s*(?:\[\s*)?(?:\{[^}]*?"url"\s*:\s*)?"([^"]+\.(?:jpe?g|png|webp)[^"]*)"/i); if (ld) img = ld[1]; }
  if (!img) return null;
  try { return new URL(img.replace(/&amp;/g, "&"), base).toString(); } catch { return null; }
}
const b64 = (bytes: Uint8Array) => { let s = ""; for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000)); return btoa(s); };
async function findPhotos(urls: string[]) {
  const pages = [...new Set(urls)].map(safePage).filter((x): x is URL => !!x).slice(0, 5);
  const found = await Promise.all(pages.map(async (page) => {
    const html = await fetchLimited(page, 2_000_000, "text/html");
    if (!html || !/html/.test(html.type)) return null;
    const imgUrl = imageFromHtml(new TextDecoder().decode(html.bytes), html.url || page.toString());
    const iu = imgUrl ? safePage(imgUrl) : null; if (!iu) return null;
    const img = await fetchLimited(iu, 3_000_000, "image/*");
    if (!img || !/^image\/(jpeg|png|webp|gif)$/.test(img.type) || img.bytes.length < 5000) return null;
    return { page: page.toString(), site: page.hostname.replace(/^www\./, ""), media_type: img.type, data: b64(img.bytes) };
  }));
  const seen = new Set<string>();
  return found.filter((f) => f && !seen.has(f.data.slice(0, 200)) && seen.add(f.data.slice(0, 200))).slice(0, 4);
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return reply(405, { code: "invalid_argument", message: "POST only" });

  let body: { k?: string; prompt?: string; images?: { media_type: string; data: string }[]; ping?: boolean; web?: boolean; photos?: string[] };
  try { body = await req.json(); } catch { return reply(400, { code: "invalid_argument", message: "Bad JSON" }); }

  if (!(await keyOk(String(body.k || "")))) return reply(401, { code: "not_granted", message: "Family key not accepted" });

  if (Array.isArray(body.photos)) return reply(200, { photos: await findPhotos(body.photos.map(String)) });

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
  // For lookups, research is the job: without this, Claude sometimes answers from memory.
  const system = tools
    ? "You are the recipe researcher for a family recipe book. Before you write any recipe you always use web_search to find real published recipes for the dish, and web_fetch to read the best one or two pages. Never answer from memory alone. List the pages you used in basedOn."
    : undefined;
  const client = new Anthropic({ apiKey });
  try {
    const messages: Anthropic.Beta.BetaMessageParam[] = [{ role: "user", content }];
    let response;
    let searched = 0, fetched = 0, nudged = false;
    for (let round = 0; round < 6; round++) {
      response = await client.beta.messages.create({
        model: MODEL,
        max_tokens: 16000,
        output_config: { effort: "medium" },
        betas: ["server-side-fallback-2026-07-01"],
        fallbacks: "default",
        ...(system ? { system } : {}),
        ...(tools ? { tools } : {}),
        messages,
      } as Anthropic.Beta.MessageCreateParamsNonStreaming);
      const use = (response.usage as { server_tool_use?: { web_search_requests?: number; web_fetch_requests?: number } })?.server_tool_use;
      searched += use?.web_search_requests || 0; fetched += use?.web_fetch_requests || 0;
      // The server-side search loop can pause; resend the turn so it resumes.
      if (response.stop_reason === "pause_turn") {
        if (messages[messages.length - 1].role === "assistant") messages.pop();
        messages.push({ role: "assistant", content: response.content as Anthropic.Beta.BetaContentBlockParam[] });
        continue;
      }
      // Answered without researching: send it back once to search before we accept the answer.
      if (tools && !searched && !nudged && response.stop_reason === "end_turn") {
        nudged = true;
        messages.push({ role: "assistant", content: response.content as Anthropic.Beta.BetaContentBlockParam[] });
        messages.push({ role: "user", content: "You answered without searching. Use web_search now to find two or three real published recipes for this dish (and the creator's own recipe if it exists), read the best one with web_fetch, then send the complete JSON again based on what you found, with basedOn listing those pages." });
        continue;
      }
      break;
    }
    console.log(JSON.stringify({ web: !!tools, searched, fetched, nudged, stop: response?.stop_reason }));
    if (!response) return reply(500, { code: "unavailable", message: "No answer" });
    if (response.stop_reason === "refusal") {
      return reply(422, { code: "refused", message: "Claude declined this request." });
    }
    // Keep only the answer written after the last search or fetch, not the commentary in between.
    const blocks = response.content as { type: string; text?: string }[];
    let last = -1;
    blocks.forEach((b, i) => { if (b.type === "server_tool_use" || b.type.endsWith("_tool_result")) last = i; });
    const text = blocks.slice(last + 1).filter((b) => b.type === "text").map((b) => b.text || "").join("");
    return reply(200, { text, truncated: response.stop_reason === "max_tokens", searches: searched, fetches: fetched });
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
