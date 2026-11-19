// Family Recipe Box: asks Claude for the website (reading posts, filling in recipes,
// categories, nutrition, grocery lists). Only callers with the family key get through,
// and the Anthropic API key stays here as a secret, never in the website's code.
import Anthropic from "npm:@anthropic-ai/sdk@1.8.0";

const MODEL = "claude-sonnet-5-5";
const PICK_MODEL = "claude-haiku-5-5"; // choosing a cover photo is a quick visual judgment
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

// Accounts edition: the page sends the signed-in person's own token. Check it, and charge their daily allowance.
async function userOk(token: string): Promise<boolean> {
  const url = Deno.env.get("SUPABASE_URL"), anon = Deno.env.get("SUPABASE_ANON_KEY");
  if (!url || !anon || !token) return false;
  try { const res = await fetch(`${url}/auth/v1/user`, { headers: { apikey: anon, Authorization: `Bearer ${token}` } }); return res.ok; } catch { return false; }
}
// Returns null when allowed (and the units left), or a message when the daily allowance is used up.
async function chargeUnits(token: string, cost: number): Promise<{ left?: number; over?: boolean }> {
  const url = Deno.env.get("SUPABASE_URL"), anon = Deno.env.get("SUPABASE_ANON_KEY");
  if (!url || !anon) return {};
  const res = await fetch(`${url}/rest/v1/rpc/sv_use`, { method: "POST", headers: { apikey: anon, Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify({ cost }) });
  if (res.ok) { try { const j = await res.json(); return { left: Number(j.left) }; } catch { return {}; } }
  const t = await res.text(); return /daily_limit/.test(t) ? { over: true } : {};
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
function imagesFromHtml(html: string, base: string): string[] {
  const out: string[] = [];
  const add = (u: string | null | undefined) => {
    if (!u) return; try { const x = new URL(u.replace(/&amp;/g, "&").replace(/\\\//g, "/"), base).toString(); if (!out.includes(x)) out.push(x); } catch { /* skip */ } };
  for (const attr of ["og:image", "og:image:url", "og:image:secure_url", "twitter:image", "twitter:image:src"]) {
    const re = new RegExp(`<meta[^>]+(?:property|name)=["']${attr}["'][^>]*>`, "gi");
    for (const m of html.match(re) || []) { const c = m.match(/content=["']([^"']+)["']/i); add(c && c[1]); }
  }
  // Recipe pages list the dish photo in their structured data, often in several shapes (1:1, 4:3, 16:9).
  for (const block of html.match(/"image"\s*:\s*(\[[^\]]*\]|\{[^}]*\}|"[^"]+")/gi) || []) {
    for (const m of block.match(/https?:[^"\s]+?\.(?:jpe?g|png|webp)(?:\?[^"\s]*)?(?=")/gi) || []) add(m);
  }
  return out.slice(0, 6);
}
// Width and height straight from the file header (JPEG, PNG, GIF, WebP).
function imageSize(b: Uint8Array): { w: number; h: number } | null {
  const u16 = (i: number) => (b[i] << 8) | b[i + 1], le16 = (i: number) => b[i] | (b[i + 1] << 8);
  if (b[0] === 0x89 && b[1] === 0x50) return { w: (b[16] << 24 | b[17] << 16 | b[18] << 8 | b[19]) >>> 0, h: (b[20] << 24 | b[21] << 16 | b[22] << 8 | b[23]) >>> 0 };
  if (b[0] === 0x47 && b[1] === 0x49) return { w: le16(6), h: le16(8) };
  if (b[0] === 0x52 && b[8] === 0x57) { const t = String.fromCharCode(b[12], b[13], b[14], b[15]);
    if (t === "VP8X") return { w: 1 + (b[24] | b[25] << 8 | b[26] << 16), h: 1 + (b[27] | b[28] << 8 | b[29] << 16) };
    if (t === "VP8 ") return { w: le16(26) & 0x3fff, h: le16(28) & 0x3fff };
    if (t === "VP8L") { const v = b[21] | b[22] << 8 | b[23] << 16 | b[24] << 24; return { w: 1 + (v & 0x3fff), h: 1 + ((v >> 14) & 0x3fff) }; } }
  if (b[0] === 0xff && b[1] === 0xd8) { let i = 2;
    while (i + 9 < b.length) { if (b[i] !== 0xff) { i++; continue; } const m = b[i + 1];
      if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return { h: u16(i + 5), w: u16(i + 7) };
      i += 2 + u16(i + 2); } }
  return null;
}
const b64 = (bytes: Uint8Array) => { let s = ""; for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000)); return btoa(s); };
type Photo = { page: string; site: string; media_type: string; data: string; w: number; h: number; fit: "fill" | "whole"; chosenBy?: string };
// Without Claude: prefer pictures close to the card's 4:3 shape and large enough to look sharp.
const shapeScore = (p: Photo) => -Math.abs(Math.log((p.w / p.h) / (4 / 3))) + Math.min(p.w, 1600) / 4000;
// YouTube pages can't be read, but every video's own thumbnail sits at a fixed address.
const ytId = (u: URL): string | null => {
  const h = u.hostname.toLowerCase().replace(/^(www|m|music)\./, "");
  let id: string | null = null;
  if (h === "youtu.be") id = u.pathname.slice(1).split("/")[0];
  else if (h === "youtube.com") { if (u.pathname === "/watch") id = u.searchParams.get("v"); else { const m = u.pathname.match(/^\/(shorts|embed|live)\/([\w-]+)/); if (m) id = m[2]; } }
  return id && /^[\w-]{6,15}$/.test(id) ? id : null;
};
async function findPhotos(urls: string[], apiKey?: string, dish?: string): Promise<Photo[]> {
  const pages = [...new Set(urls)].map(safePage).filter((x): x is URL => !!x).slice(0, 5);
  const perPage = await Promise.all(pages.map(async (page) => {
    const yt = ytId(page);
    let imgs: URL[];
    if (yt) imgs = ["maxresdefault", "hq720", "sddefault"].map((n) => safePage(`https://i.ytimg.com/vi/${yt}/${n}.jpg`)).filter((x): x is URL => !!x);
    else {
      const html = await fetchLimited(page, 2_000_000, "text/html");
      if (!html || !/html/.test(html.type)) return [];
      imgs = imagesFromHtml(new TextDecoder().decode(html.bytes), html.url || page.toString()).map(safePage).filter((x): x is URL => !!x).slice(0, 3);
    }
    const got = await Promise.all(imgs.map(async (iu) => {
      const img = await fetchLimited(iu, 3_500_000, "image/*");
      if (!img || !/^image\/(jpeg|png|webp|gif)$/.test(img.type) || img.bytes.length < 5000) return null;
      const sz = imageSize(img.bytes); if (!sz || sz.w < 300 || sz.h < 200) return null;
      const ratio = sz.w / sz.h;
      return { page: page.toString(), site: yt ? "youtube.com" : page.hostname.replace(/^www\./, ""), media_type: img.type, data: b64(img.bytes), w: sz.w, h: sz.h,
        fit: (ratio < 1.05 || ratio > 2.1 ? "whole" : "fill") as "fill" | "whole" };
    }));
    return got.filter((x): x is Photo => !!x);
  }));
  const seen = new Set<string>();
  let photos = perPage.flat().filter((f) => !seen.has(f.data.slice(0, 300)) && seen.add(f.data.slice(0, 300)));
  photos.sort((a, b) => shapeScore(b) - shapeScore(a));
  photos = photos.slice(0, 6);
  if (!apiKey) photos = photos.map((p) => ({ ...p, chosenBy: "shape: no key" }));
  else if (photos.length > 1) {
    try { photos = await claudePick(photos, apiKey, dish); } catch (e) { console.log("pick failed", String(e).slice(0, 300)); photos = photos.map((p) => ({ ...p, chosenBy: "shape: " + String(e).slice(0, 160) })); }
  }
  return photos.slice(0, 4);
}
// Claude looks at the candidates and puts the most appetizing, best-framed picture of the dish first.
async function claudePick(photos: Photo[], apiKey: string, dish?: string): Promise<Photo[]> {
  const client = new Anthropic({ apiKey });
  const content: Anthropic.ContentBlockParam[] = [];
  photos.forEach((p, i) => {
    content.push({ type: "text", text: `Photo ${i + 1} (${p.w}×${p.h}, from ${p.site}):` });
    content.push({ type: "image", source: { type: "base64", media_type: p.media_type as "image/jpeg", data: p.data } });
  });
  content.push({ type: "text", text: `These photos come from recipe pages${dish ? ` for "${dish}"` : ""}. Pick the ones to use as the recipe's cover photo on a 4:3 card, best first.
A good cover shows the finished dish looking appetizing: the whole plate or bowl in view (not an extreme close-up of a few pieces), well lit, in focus, and no text, logos, collages, step-by-step grids or people's faces covering it. Leave out photos that don't show the finished dish at all.
For each photo you keep, say "fill" if cropping it to 4:3 from the center keeps the dish fully in frame, or "whole" if a crop would cut the dish off (then the full photo is shown with soft edges).
Return ONLY JSON: {"order":[{"photo": number, "fit": "fill" | "whole"}]}` });
  const res = await client.messages.create({ model: PICK_MODEL, max_tokens: 4000, messages: [{ role: "user", content }] });
  const text = res.content.filter((b) => b.type === "text").map((b) => (b as { text: string }).text).join("");
  const fallback = (why: string) => photos.map((p) => ({ ...p, chosenBy: "shape: " + why }));
  const m = text.match(/\{[\s\S]*\}/); if (!m) return fallback("no json (" + res.stop_reason + "): " + text.slice(0, 120));
  let parsed: unknown; try { parsed = JSON.parse(m[0]); } catch { return fallback("bad json: " + m[0].slice(0, 120)); }
  const raw = ((parsed as { order?: unknown[] }).order || []) as unknown[];
  // Accept [{"photo":2,"fit":"fill"}, ...] or a plain list of numbers [2, 1, ...]
  const order = raw.map((o) => typeof o === "number" || typeof o === "string" ? { photo: Number(o) } : (o as { photo?: number; fit?: string }));
  const picked: Photo[] = [];
  const used = new Set<number>();
  for (const o of order) { const i = Number(o.photo) - 1, p = photos[i]; if (p && !used.has(i)) { used.add(i); picked.push({ ...p, fit: o.fit === "whole" ? "whole" : o.fit === "fill" ? "fill" : p.fit, chosenBy: "claude" }); } }
  if (!picked.length) return fallback("empty order: " + m[0].slice(0, 120));
  console.log(JSON.stringify({ pick: order, of: photos.length }));
  return [...picked, ...photos.filter((p) => !picked.some((q) => q.data === p.data))];
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return reply(405, { code: "invalid_argument", message: "POST only" });

  let body: { k?: string; prompt?: string; images?: { media_type: string; data: string }[]; ping?: boolean; web?: boolean; photos?: string[]; dish?: string; effort?: string; maxSearch?: number; maxFetch?: number; nudge?: boolean; fast?: boolean };
  try { body = await req.json(); } catch { return reply(400, { code: "invalid_argument", message: "Bad JSON" }); }

  // Two ways in: a signed-in account (a token), or the old family link (a key) while it is still in use.
  const bearer = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  const isUser = !body.k && !!bearer && bearer !== req.headers.get("apikey") && bearer !== Deno.env.get("SUPABASE_ANON_KEY");
  if (isUser) { if (!(await userOk(bearer))) return reply(401, { code: "not_granted", message: "Please sign in again." }); }
  else if (!(await keyOk(String(body.k || "")))) return reply(401, { code: "not_granted", message: "Family key not accepted" });
  let unitsLeft: number | undefined;
  const ok200 = (o: Record<string, unknown>) => reply(200, unitsLeft === undefined ? o : { ...o, units_left: unitsLeft });
  const charge = async (cost: number): Promise<Response | null> => {
    if (!isUser || !cost) return null;
    const c = await chargeUnits(bearer, cost);
    if (c.over) return reply(429, { code: "daily_limit", message: "You have used today's Claude lookups. They reset overnight." });
    if (c.left !== undefined) unitsLeft = c.left;
    return null;
  };

  if (Array.isArray(body.photos)) { const over = await charge(1); if (over) return over; }
  if (Array.isArray(body.photos)) return ok200({ photos: await findPhotos(body.photos.map(String), Deno.env.get("ANTHROPIC_API_KEY"), String(body.dish || "").slice(0, 120)) });

  const apiKey = Deno.env.get("ANTHROPIC_API_KEY");
  if (!apiKey) return reply(503, { code: "not_configured", message: "Claude isn't switched on yet: the Anthropic API key hasn't been added." });
  if (body.ping) return ok200({ ok: true, model: MODEL });

  const prompt = String(body.prompt || "").slice(0, 60000);
  if (!prompt) return reply(400, { code: "invalid_argument", message: "Empty prompt" });
  const images = (Array.isArray(body.images) ? body.images : []).slice(0, 4)
    .filter((i) => i && /^image\/(jpeg|png|gif|webp)$/.test(i.media_type) && typeof i.data === "string" && i.data.length < 4_000_000);

  { const over = await charge(body.fast ? 1 : body.web ? 5 : 1); if (over) return over; }
  const content: Anthropic.Beta.BetaContentBlockParam[] = [
    ...images.map((i) => ({ type: "image" as const, source: { type: "base64" as const, media_type: i.media_type as "image/jpeg", data: i.data } })),
    { type: "text" as const, text: prompt },
  ];

  // Recipe lookups get web search (find real recipes for the dish) and web fetch (read the
  // linked page or a search result). Facebook, TikTok and Instagram block outside readers.
  const t0 = Date.now();
  const lim = (v: unknown, d: number) => { const n = Number(v); return Number.isFinite(n) ? Math.min(d, Math.max(1, Math.round(n))) : d; };
  const fast = !!body.fast; // a quick draft: the small model, no web search
  const tools = body.web && !fast
    ? [{ type: "web_search_20260209", name: "web_search", max_uses: lim(body.maxSearch, 5) }, { type: "web_fetch_20260209", name: "web_fetch", max_uses: lim(body.maxFetch, 4) }]
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
        ...(fast
          ? { model: PICK_MODEL, max_tokens: 3000 }
          : { model: MODEL, max_tokens: 16000, output_config: { effort: body.effort === "low" ? "low" : "medium" }, betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" }),
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
      if (tools && body.nudge !== false && !searched && !nudged && response.stop_reason === "end_turn") {
        nudged = true;
        messages.push({ role: "assistant", content: response.content as Anthropic.Beta.BetaContentBlockParam[] });
        messages.push({ role: "user", content: "You answered without searching. Use web_search now to find two or three real published recipes for this dish (and the creator's own recipe if it exists), read the best one with web_fetch, then send the complete JSON again based on what you found, with basedOn listing those pages." });
        continue;
      }
      break;
    }
    console.log(JSON.stringify({ fast, web: !!tools, searched, fetched, nudged, stop: response?.stop_reason, ms: Date.now() - t0 }));
    if (!response) return reply(500, { code: "unavailable", message: "No answer" });
    if (response.stop_reason === "refusal") {
      return reply(422, { code: "refused", message: "Claude declined this request." });
    }
    // Keep only the answer written after the last search or fetch, not the commentary in between.
    const blocks = response.content as { type: string; text?: string }[];
    let last = -1;
    blocks.forEach((b, i) => { if (b.type === "server_tool_use" || b.type.endsWith("_tool_result")) last = i; });
    const text = blocks.slice(last + 1).filter((b) => b.type === "text").map((b) => b.text || "").join("");
    return ok200({ text, truncated: response.stop_reason === "max_tokens", searches: searched, fetches: fetched });
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
