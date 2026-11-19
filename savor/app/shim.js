/* Savor with accounts. Everyone signs in (email, Google or Apple); every recipe book belongs to the
   people in it. This gives the app the same storage, people, photo and Claude features it already uses,
   backed by Supabase, with each request carrying the signed-in person's own token. */
(() => {
  const CFG = window.RECIPE_BOX_CONFIG || {};
  const BASE = (CFG.supabaseUrl || '').replace(/\/+$/, '');
  const API = BASE + '/rest/v1/rpc/', AUTH = BASE + '/auth/v1/', FN = BASE + '/functions/v1/rb-claude';
  const LS = {
    get(k, d){ try{ const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); }catch{ return d; } },
    set(k, v){ try{ localStorage.setItem(k, JSON.stringify(v)); }catch{} },
    del(k){ try{ localStorage.removeItem(k); }catch{} }
  };
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const realFetch = window.fetch.bind(window);

  /* Refresh adds ?fresh=… to fetch a new copy; an invite link adds ?join=…; tidy them away once read */
  const url = new URL(location.href);
  if(url.searchParams.get('join')) LS.set('sv:join', String(url.searchParams.get('join')).replace(/[^A-Za-z0-9]/g, '').slice(0, 40));
  if(url.searchParams.has('fresh') || url.searchParams.has('join')){ url.searchParams.delete('fresh'); url.searchParams.delete('join'); history.replaceState(null, '', url.pathname + url.search + url.hash); }

  /* ---------- the session ---------- */
  let session = LS.get('sv:session', null);
  let oauthError = '';
  (function takeOAuthReturn(){
    const h = location.hash.replace(/^#/, ''); if(!/access_token=|error_description=/.test(h)) return;
    const q = new URLSearchParams(h);
    if(q.get('access_token')){
      session = { access_token: q.get('access_token'), refresh_token: q.get('refresh_token') || '', expires_at: Date.now() + (Number(q.get('expires_in')) || 3600) * 1000, user: null };
      LS.set('sv:session', session);
    } else oauthError = (q.get('error_description') || 'Sign-in didn’t finish.').replace(/\+/g, ' ');
    history.replaceState(null, '', location.pathname + location.search);   /* never leave tokens in the address bar */
  })();
  const saveSession = s => { session = s; if(s) LS.set('sv:session', s); else LS.del('sv:session'); };
  const gotrue = async (path, body, method = 'POST', token) => {
    const headers = { 'Content-Type': 'application/json', apikey: CFG.supabaseKey };
    if(token) headers.Authorization = 'Bearer ' + token;
    let res; try{ res = await realFetch(AUTH + path, { method, headers, body: method === 'GET' ? undefined : JSON.stringify(body || {}) }); }
    catch{ throw { code: 'unavailable', message: 'No connection. Check your internet and try again.' }; }
    let out = {}; try{ out = await res.json(); }catch{}
    if(!res.ok) throw { code: 'auth', status: res.status, message: out.error_description || out.msg || out.message || ('Error ' + res.status) };
    return out;
  };
  const toSession = o => ({ access_token: o.access_token, refresh_token: o.refresh_token || '', expires_at: Date.now() + (Number(o.expires_in) || 3600) * 1000, user: o.user || null });
  let refreshing = null;
  async function freshToken(force){
    if(!session) return '';
    if(!force && session.expires_at - Date.now() > 60000) return session.access_token;
    if(!session.refresh_token) return force ? '' : session.access_token;
    refreshing = refreshing || gotrue('token?grant_type=refresh_token', { refresh_token: session.refresh_token })
      .then(o => { saveSession({ ...toSession(o), user: o.user || session.user }); return session.access_token; })
      .catch(e => { if(e.status === 400 || e.status === 401 || e.status === 403){ saveSession(null); } return ''; })
      .finally(() => { refreshing = null; });
    return refreshing;
  }

  /* ---------- talking to the database (every call carries your own token) ---------- */
  let signedOutHandler = () => {};
  async function rpc(fn, args, retried){
    const token = await freshToken(false);
    if(!token){ signedOutHandler(); throw { code: 'not_granted', message: 'Please sign in again.' }; }
    let res;
    try{ res = await realFetch(API + fn, { method: 'POST', headers: { 'Content-Type': 'application/json', apikey: CFG.supabaseKey, Authorization: 'Bearer ' + token }, body: JSON.stringify(args || {}) }); }
    catch{ throw { code: 'unavailable', message: 'No connection' }; }
    if(!res.ok){
      let body = {}; try{ body = await res.json(); }catch{}
      if((res.status === 401 || /not_signed_in|JWT/i.test(body.message || '')) && !retried){ const t = await freshToken(true); if(t) return rpc(fn, args, true); saveSession(null); signedOutHandler(); throw { code: 'not_granted', message: 'Please sign in again.' }; }
      throw { code: res.status >= 500 ? 'unavailable' : 'invalid_argument', message: body.message || ('HTTP ' + res.status) };
    }
    const t = await res.text(); return t ? JSON.parse(t) : null;
  }

  /* ---------- who I am, and which book is open ---------- */
  let me = { id: '', name: '', email: '' }, books = [], activeBook = '', importsLeft = null, weeklyLimit = 10, unlimited = false;
  const roleOf = id => ((books.find(b => b.id === id) || {}).role) || '';
  const phys = p => p === 'app/home' ? 'users/' + me.id + '/home' : p.startsWith('data/users/' + me.id + '/') ? 'users/' + me.id + '/' + p.slice(('data/users/' + me.id + '/').length) : p;
  const logical = p => p === 'users/' + me.id + '/home' ? 'app/home' : p;
  function applyMe(j){ if(!j) return; me.id = j.id; me.name = j.name || ''; books = j.books || []; activeBook = j.home || activeBook; importsLeft = j.imports_left; weeklyLimit = j.weekly_limit || 10; unlimited = !!j.unlimited; }

  /* ---------- local mirror of the database, kept fresh by polling for changes ---------- */
  const mirror = new Map(), loadedParents = new Set(), subs = new Set();
  let since = null, polling = null, lastPoll = 0;
  const parentOf = p => p.replace(/\/[^/]+$/, '');
  const snapDoc = (path, fromCache) => { const v = mirror.get(path);
    return { id: path.split('/').pop(), exists: v !== undefined, data: () => v, metadata: { fromCache: !!fromCache, hasPendingWrites: false } }; };
  function snapCol(col, order, lim, filters, fromCache){
    let docs = [];
    for(const [p, v] of mirror) if(parentOf(p) === col) docs.push(snapDoc(p, fromCache));
    for(const [f, op, val] of (filters || [])) docs = docs.filter(d => { const x = (d.data() || {})[f];
      return op === '==' ? x === val : op === '!=' ? x !== val : op === '<' ? x < val : op === '<=' ? x <= val : op === '>' ? x > val : op === '>=' ? x >= val
        : op === 'in' ? (val || []).includes(x) : op === 'array-contains' ? Array.isArray(x) && x.includes(val) : true; });
    if(order){ const [f, dir] = order; docs.sort((a, b) => { const x = (a.data() || {})[f], y = (b.data() || {})[f];
      const c = x == null ? 1 : y == null ? -1 : x < y ? -1 : x > y ? 1 : 0; return dir === 'desc' ? -c : c; }); }
    else docs.sort((a, b) => a.id < b.id ? -1 : 1);
    if(lim) docs = docs.slice(0, lim);
    return { docs, size: docs.length, metadata: { fromCache: !!fromCache }, docChanges: () => [] };
  }
  function notify(paths){
    const parents = new Set([...paths].map(parentOf));
    for(const s of subs){
      if(s.kind === 'doc' && paths.has(s.path)) s.fn(snapDoc(s.path));
      if(s.kind === 'col' && parents.has(s.path)) s.fn(snapCol(s.path, s.order, s.lim, s.filters));
    }
  }
  async function loadCollection(col){
    if(loadedParents.has(col)) return;
    const rows = await rpc('sv_list', { par: phys(col) }) || [];
    for(const r of rows) mirror.set(logical(r.path), r.data);
    loadedParents.add(col);
  }
  async function poll(){
    if(!session || (document.hidden && Date.now() - lastPoll < 60000)) return;
    lastPoll = Date.now();
    try{
      const rows = await rpc('sv_changes', { since: since || '1970-01-01T00:00:00Z' }) || [];
      if(!rows.length) return;
      const changed = new Set();
      for(const r of rows){
        if(r.updated_at > (since || '')) since = r.updated_at;
        const path = logical(r.path), par = parentOf(path);
        const known = loadedParents.has(par) || [...subs].some(s => s.path === path);
        if(!known) continue;
        if(r.deleted) mirror.delete(path); else mirror.set(path, r.data);
        changed.add(path);
      }
      if(changed.size) notify(changed);
    }catch{}
  }
  function startPolling(){ if(polling) return; polling = setInterval(poll, 4000);
    if(!since) rpc('sv_now', {}).then(t => { if(!since && t) since = t; }).catch(() => {});
    document.addEventListener('visibilitychange', () => { if(!document.hidden) poll(); }); }

  const merge = (a, b) => { const out = { ...(a || {}) };
    for(const [k, v] of Object.entries(b || {})){
      if(v && typeof v === 'object' && v.__delete__ === true){ delete out[k]; continue; }
      out[k] = v && typeof v === 'object' && !Array.isArray(v) && out[k] && typeof out[k] === 'object' && !Array.isArray(out[k]) ? merge(out[k], v) : v; }
    return out; };
  const clone = v => JSON.parse(JSON.stringify(v));

  function docRef(path){
    return {
      path, id: path.split('/').pop(),
      async get(){ if(!mirror.has(path) && !loadedParents.has(parentOf(path))){ const d = await rpc('sv_get', { p: phys(path) }); if(d != null) mirror.set(path, d); } return snapDoc(path); },
      async set(data){ const d = clone(data); mirror.set(path, d); notify(new Set([path])); await rpc('sv_set', { p: phys(path), d }); },
      async update(data){ if(!mirror.has(path)){ const d = await rpc('sv_get', { p: phys(path) }); if(d == null) throw { code: 'invalid_argument', message: 'Document does not exist' }; mirror.set(path, d); }
        mirror.set(path, merge(mirror.get(path), clone(data))); notify(new Set([path])); await rpc('sv_update', { p: phys(path), d: clone(data) }); },
      async delete(){ mirror.delete(path); notify(new Set([path])); await rpc('sv_delete', { p: phys(path) }); },
      async acquire(){ return { acquired: true, expiresAt: Date.now() + 10000 }; },
      onSnapshot(fn, err){ const s = { kind: 'doc', path, fn, err }; subs.add(s); startPolling();
        (async () => { try{ if(!mirror.has(path)){ const d = await rpc('sv_get', { p: phys(path) }); if(d != null) mirror.set(path, d); } fn(snapDoc(path)); }
          catch(e){ if(err) err(e); } })();
        return () => subs.delete(s); },
      collection(sub){ return colRef(path + '/' + sub); }
    };
  }
  function colRef(col, order, lim, filters){
    const q = {
      path: col,
      doc(id){ return docRef(col + '/' + (id || ('x' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8)))); },
      async add(data){ const r = q.doc(); await r.set(data); return r; },
      orderBy(f, dir){ return colRef(col, [f, dir || 'asc'], lim, filters); },
      limit(n){ return colRef(col, order, n, filters); },
      where(f, op, v){ return colRef(col, order, lim, [...(filters || []), [f, op, v]]); },
      async get(){ await loadCollection(col); return snapCol(col, order, lim, filters); },
      onSnapshot(fn, err){ const s = { kind: 'col', path: col, order, lim, filters, fn, err }; subs.add(s); startPolling();
        (async () => { try{ await loadCollection(col); fn(snapCol(col, order, lim, filters)); } catch(e){ if(err) err(e); } })();
        return () => subs.delete(s); }
    };
    return q;
  }
  const db = Object.freeze({ doc: docRef, collection: p => colRef(p) });

  /* ---------- people ---------- */
  const names = {};
  const user = Object.freeze({
    id: async () => me.id,
    me: async () => ({ id: me.id, name: me.name, email: me.email }),
    isOwner: async () => roleOf(activeBook) === 'owner',
    canEdit: async () => roleOf(activeBook) !== 'viewer',
    can: async () => true,
    async profiles(ids){ const out = {}; const need = ids.filter(id => id !== me.id && names[id] === undefined);
      if(need.length && activeBook){ try{ const r = await rpc('sv_names', { book: activeBook, ids: need }) || {}; for(const id of need) names[id] = r[id] || ''; }catch{ for(const id of need) names[id] = ''; } }
      for(const id of ids) out[id] = { id, name: id === me.id ? (me.name || 'You') : (names[id] || '') };
      return out; },
    search: async () => []
  });
  window.RecipeBoxPeople = { me: () => me, async setName(n){ const nm = String(n || '').trim().slice(0, 40); await rpc('sv_set_name', { display_name: nm }); me.name = nm; } };

  /* ---------- photos: resized on the device, stored in the database ---------- */
  const photoCache = new Map();
  async function shrink(blob){
    try{
      const bmp = await createImageBitmap(blob);
      const scale = Math.min(1, 1280 / Math.max(bmp.width, bmp.height));
      const c = document.createElement('canvas'); c.width = Math.round(bmp.width * scale); c.height = Math.round(bmp.height * scale);
      c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
      return c.toDataURL('image/jpeg', 0.82);
    }catch{ return await new Promise((ok, no) => { const r = new FileReader(); r.onload = () => ok(r.result); r.onerror = no; r.readAsDataURL(blob); }); }
  }
  const assets = Object.freeze({
    async upload(blob){ const id = 'p' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
      const data = await shrink(blob);
      await rpc('sv_photo_put', { book: activeBook, pid: id, pdata: data }); photoCache.set(id, data);
      return { id, url: '/_blob/' + id, sizeBytes: data.length, contentType: 'image/jpeg' }; },
    async list(){ return { assets: [], usage: {} }; },
    async delete(){}
  });
  async function photo(id){
    if(photoCache.has(id)) return photoCache.get(id);
    const p = rpc('sv_photo_get', { pid: id }).then(d => { photoCache.set(id, d || ''); return d || ''; }).catch(() => { photoCache.delete(id); return ''; });
    photoCache.set(id, p); return p;
  }
  const BLANK = 'data:image/gif;base64,R0lGODlhAQABAAAAACw=';
  function fixImg(img){
    const src = img.getAttribute('src') || '';
    if(!src.startsWith('/_blob/')) return;
    const id = src.slice(7); img.setAttribute('src', BLANK); img.dataset.pid = id;
    Promise.resolve(photo(id)).then(d => { if(img.dataset.pid === id){ if(d) img.setAttribute('src', d); else img.style.visibility = 'hidden'; } });
  }
  new MutationObserver(ms => { for(const m of ms){
      if(m.type === 'attributes' && m.target.tagName === 'IMG') fixImg(m.target);
      for(const n of m.addedNodes || []){ if(n.nodeType !== 1) continue; if(n.tagName === 'IMG') fixImg(n); n.querySelectorAll && n.querySelectorAll('img[src^="/_blob/"]').forEach(fixImg); } } })
    .observe(document.documentElement, { subtree: true, childList: true, attributes: true, attributeFilter: ['src'] });
  window.fetch = async (input, init) => {
    const u = typeof input === 'string' ? input : (input && input.url) || '';
    const m = u.match(/\/_blob\/([A-Za-z0-9_-]+)$/);
    if(m){ const d = await photo(m[1]); if(!d) return new Response('', { status: 404 }); return realFetch(d); }
    return realFetch(input, init);
  };

  /* ---------- Claude: reading posts, filling in recipes, photos (your daily allowance applies) ---------- */
  async function callClaude(body){
    const token = await freshToken(false);
    let res;
    try{ res = await realFetch(FN, { method: 'POST', headers: { 'Content-Type': 'application/json', apikey: CFG.supabaseKey, Authorization: 'Bearer ' + token }, body: JSON.stringify(body) }); }
    catch{ throw { code: 'unavailable', message: 'No connection' }; }
    let out = {}; try{ out = await res.json(); }catch{}
    if(!res.ok) throw { code: out.code || (res.status === 429 ? 'rate_limited' : 'unavailable'), message: out.message || ('HTTP ' + res.status) };
    if(typeof out.imports_left === 'number'){ importsLeft = out.imports_left; refreshAcctBadge(); }
    if(out.unlimited){ unlimited = true; refreshAcctBadge(); }
    return out;
  }
  const toPrompt = input => typeof input === 'string' ? input
    : (Array.isArray(input) ? input.map(m => (m.role === 'assistant' ? 'Earlier answer: ' : '') + m.content).join('\n\n') : String(input || ''));
  async function toImages(list){
    const out = [];
    for(const b of [].concat(list || []).slice(0, 4)){ try{ const du = await shrink(b); const m = du.match(/^data:([^;]+);base64,(.*)$/); if(m) out.push({ media_type: m[1], data: m[2] }); }catch{} }
    return out;
  }
  const sample = async (input, opts = {}) => {
    const r = await callClaude({ prompt: toPrompt(input), images: await toImages(opts.images), web: !!opts.web, ...(opts.importId ? { import_id: opts.importId } : {}), ...(opts.fast ? { fast: true } : {}), ...(opts.web ? { effort: 'low', maxSearch: 3, maxFetch: 2 } : {}) });
    const text = r.text || '';
    if(typeof opts.onText === 'function'){ try{ opts.onText({ text, delta: text }); }catch{} }
    return { text, truncated: !!r.truncated };
  };
  sample.json = async (input, opts = {}) => {
    const { text } = await sample(input, opts);
    const t = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
    try{ return JSON.parse(t); }catch{}
    const a = t.indexOf('{'), b = t.lastIndexOf('}');
    if(a >= 0 && b > a){ try{ return JSON.parse(t.slice(a, b + 1)); }catch{} }
    throw { code: 'invalid_json', message: 'Claude’s answer couldn’t be read', text };
  };
  sample.limits = async () => ({ images: { maxCount: 4, maxBytes: 20000000, mediaTypes: ['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/heic', 'image/heif'] } });
  let claudeReady = null;
  const claudeOn = () => claudeReady || (claudeReady = callClaude({ ping: true })
    .then(() => { window.RecipeBoxWeb.claudeStatus = 'on'; return sample; },
          e => { window.RecipeBoxWeb.claudeStatus = (e && e.code) || 'unavailable'; return null; }));

  /* ---------- screens: sign in, account, sharing ---------- */
  const css = document.createElement('style');
  css.textContent = `
  .svscreen{position:fixed;inset:0;z-index:60;background:var(--bg);display:grid;place-items:center;padding:20px max(16px,env(safe-area-inset-left,0px));overflow:auto}
  .svbox{width:100%;max-width:420px;display:grid;gap:12px}
  .svbox h2{font-size:1.9rem;margin:0}.svbox p{margin:0;color:var(--muted)}
  .svlogo{font-family:'Playfair Display',Georgia,serif;font-size:2rem;font-weight:800;color:var(--ink)}
  .svlogo b{color:var(--accent)}
  .svtabs{display:flex;gap:6px;background:var(--sunk);padding:4px;border-radius:999px}
  .svtabs button{flex:1;border:0;background:transparent;color:var(--muted);font:inherit;font-weight:600;padding:9px 12px;border-radius:999px;cursor:pointer}
  .svtabs button[aria-selected="true"]{background:var(--surface);color:var(--ink);box-shadow:0 1px 4px rgba(0,0,0,.15)}
  .svform{display:grid;gap:10px}
  .svform label{display:grid;gap:4px;font-size:.85rem;color:var(--muted)}
  .svform input,.svinp{border:1px solid var(--line);background:var(--surface);color:var(--ink);border-radius:12px;padding:12px 14px;font:inherit;font-size:1rem;min-width:0;width:100%;box-sizing:border-box}
  .svbtn{border:1px solid var(--line);background:var(--surface);color:var(--ink);border-radius:999px;padding:12px 16px;font:inherit;font-weight:600;cursor:pointer;display:flex;gap:10px;align-items:center;justify-content:center;width:100%;box-sizing:border-box}
  .svbtn.primary{background:var(--accent);border-color:var(--accent);color:var(--accent-ink,#fff)}
  .svbtn.small{width:auto;padding:7px 12px;font-size:.85rem}
  .svbtn.danger{color:#c0392b}
  .svbtn:disabled{opacity:.6;cursor:default}
  .svor{display:flex;align-items:center;gap:10px;color:var(--muted);font-size:.8rem}.svor:before,.svor:after{content:'';flex:1;height:1px;background:var(--line)}
  .svmsg{font-size:.9rem;padding:10px 12px;border-radius:10px;background:var(--sunk)}.svmsg.err{color:#c0392b;background:color-mix(in srgb,#c0392b 10%,var(--surface))}
  .svlink{background:none;border:0;color:var(--accent);font:inherit;cursor:pointer;padding:0;text-align:left}
  .svfine{font-size:.78rem;color:var(--muted)}
  .svmodal{position:fixed;inset:0;z-index:55;background:rgba(10,14,22,.55);display:grid;place-items:center;padding:16px;overflow:auto}
  .svpanel{background:var(--bg);color:var(--ink);border:1px solid var(--line);border-radius:18px;width:100%;max-width:520px;max-height:92vh;overflow:auto;padding:18px;display:grid;gap:14px;box-sizing:border-box}
  .svpanel h3{margin:0;font-size:1.25rem}.svpanel h4{margin:4px 0 0;font-size:.8rem;text-transform:uppercase;letter-spacing:.06em;color:var(--muted)}
  .svhead{display:flex;align-items:center;gap:8px}.svhead h3{margin-right:auto}
  .svx{border:0;background:transparent;color:var(--muted);font-size:1.6rem;line-height:1;cursor:pointer}
  .svrow{display:flex;gap:8px;align-items:center;flex-wrap:wrap;padding:8px 0;border-top:1px solid var(--line)}
  .svrow:first-of-type{border-top:0}.svrow .grow{flex:1 1 140px;min-width:0}.svrow small{color:var(--muted);display:block}
  .svrow select{border:1px solid var(--line);background:var(--surface);color:var(--ink);border-radius:10px;padding:7px 8px;font:inherit}
  .svchip{display:inline-block;font-size:.72rem;border:1px solid var(--line);border-radius:999px;padding:2px 8px;color:var(--muted)}
  .svlink2{word-break:break-all;font-size:.85rem;background:var(--sunk);border-radius:10px;padding:10px}
  .svbadge{font-size:.72rem;color:var(--muted);margin:6px 4px 0}
  `;
  document.head.append(css);

  const el = (html, cls, id) => { const d = document.createElement('div'); if(cls) d.className = cls; if(id) d.id = id; d.innerHTML = html; return d; };
  const GOOGLE = '<svg width="18" height="18" viewBox="0 0 48 48" aria-hidden="true"><path fill="#EA4335" d="M24 9.5c3.5 0 6.6 1.2 9.1 3.6l6.8-6.8C35.8 2.4 30.3 0 24 0 14.6 0 6.5 5.4 2.6 13.2l7.9 6.1C12.4 13.6 17.7 9.5 24 9.5z"/><path fill="#4285F4" d="M46.1 24.5c0-1.6-.1-3.1-.4-4.5H24v9h12.4c-.5 2.9-2.2 5.3-4.6 6.9l7.2 5.6c4.3-3.9 7.1-9.7 7.1-17z"/><path fill="#FBBC05" d="M10.5 28.7a14.5 14.5 0 0 1 0-9.4l-7.9-6.1a24 24 0 0 0 0 21.6l7.9-6.1z"/><path fill="#34A853" d="M24 48c6.5 0 11.9-2.1 15.9-5.8l-7.2-5.6c-2 1.4-4.6 2.2-8.7 2.2-6.3 0-11.6-4.1-13.5-9.8l-7.9 6.1C6.5 42.6 14.6 48 24 48z"/></svg>';
  const APPLE = '<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M16.4 12.7c0-2.4 2-3.6 2.1-3.6-1.1-1.7-2.9-1.9-3.5-1.9-1.5-.2-2.9.9-3.7.9-.8 0-1.9-.9-3.1-.8-1.6 0-3.1.9-3.9 2.4-1.7 2.9-.4 7.2 1.2 9.5.8 1.2 1.7 2.5 3 2.4 1.2-.1 1.7-.8 3.100-.8 1.5 0 1.900.8 3.100.7 1.300 0 2.100-1.200 2.900-2.300.9-1.300 1.300-2.600 1.300-2.700-.1 0-2.500-1-2.500-3.800zM14 5.500c.7-.8 1.100-1.900 1-3-1 0-2.100.7-2.800 1.500-.6.700-1.200 1.800-1 2.900 1.100.1 2.100-.5 2.800-1.400z"/></svg>';

  let readyResolve; const ready = new Promise(r => { readyResolve = r; });
  let screenEl = null;
  const removeScreen = () => { if(screenEl){ screenEl.remove(); screenEl = null; } };

  async function afterSignIn(){
    const meta = (session && session.user && session.user.user_metadata) || {}, mail = (session && session.user && session.user.email) || '';
    const nice = (mail.split('@')[0] || '').replace(/[._-]+/g, ' ').replace(/\d+$/, '').trim().replace(/^./, c => c.toUpperCase()).split(' ')[0];
    try{ const j = await rpc('sv_bootstrap', { display_name: pendingName || meta.name || meta.full_name || nice || '' });
      applyMe(j); me.email = (session && session.user && session.user.email) || me.email; }
    catch(e){ showSignIn('Signed in, but your recipe book couldn’t be opened (' + (e.message || e.code) + '). Try again.'); return false; }
    pendingName = '';
    const code = LS.get('sv:join', '');
    removeScreen();   /* the sign-in screen must be gone before the join question appears */
    if(code){ const ok = await offerJoin(code); LS.del('sv:join'); if(ok) { try{ applyMe(await rpc('sv_me', {})); }catch{} } }
    removeScreen(); mountAccountUI(); readyResolve(); return true;
  }
  let pendingName = '';
  async function offerJoin(code){
    let info = null; try{ info = await rpc('sv_invite_info', { c: code }); }catch{}
    if(!info) return false;
    if(info.already) return true;
    const roleWord = { admin: 'an admin', contributor: 'a contributor (can add and edit recipes)', viewer: 'a viewer (can look, not change)' }[info.role] || info.role;
    return await new Promise(res => {
      const m = el('<div class="svpanel" role="dialog" aria-label="Join a recipe book"><h3>Join “' + esc(info.book) + '”?</h3><p>' + (info.owner ? esc(info.owner) + ' invited you' : 'You were invited') + ' as ' + roleWord + '. You’ll still keep your own book too.</p>'
        + '<button class="svbtn primary" id="jy" type="button">Join this book</button><button class="svbtn" id="jn" type="button">Not now</button></div>', 'svmodal');
      document.body.append(m);
      m.querySelector('#jn').onclick = () => { m.remove(); res(false); };
      m.querySelector('#jy').onclick = async () => { const b = m.querySelector('#jy'); b.disabled = true;
        try{ await rpc('sv_join', { c: code }); m.remove(); res(true); }catch(e){ b.disabled = false; b.textContent = 'That invite didn’t work (' + (e.message || 'expired') + ')'; } };
    });
  }

  function showSignIn(msg, startTab){
    removeScreen();
    const joinCode = LS.get('sv:join', '');
    let tab = startTab || (LS.get('sv:seen', false) ? 'in' : 'up');
    const root = el('', 'svscreen', 'svScreen'); screenEl = root; document.body.append(root);
    const keep = { name: '', email: '' };
    root.addEventListener('input', e => { if(e.target.id === 'svName') keep.name = e.target.value; if(e.target.id === 'svEmail') keep.email = e.target.value; });
    const draw = (note, isErr) => {
      root.innerHTML = '<div class="svbox"><div class="svlogo">savor<b>✳</b></div>'
        + '<p>' + (joinCode ? 'You’ve been invited to a recipe book. Sign in or create a free account to join.' : 'Save recipes from anywhere. Cook them tonight.') + '</p>'
        + '<div class="svtabs" role="tablist"><button type="button" role="tab" data-t="up" aria-selected="' + (tab === 'up') + '">Create account</button><button type="button" role="tab" data-t="in" aria-selected="' + (tab === 'in') + '">Sign in</button></div>'
        + (note ? '<div class="svmsg' + (isErr ? ' err' : '') + '" role="status">' + note + '</div>' : '')
        + '<button class="svbtn" type="button" data-oauth="google">' + GOOGLE + 'Continue with Google</button>'
        + '<button class="svbtn" type="button" data-oauth="apple">' + APPLE + 'Continue with Apple</button>'
        + '<div class="svor">or use your email</div>'
        + '<form class="svform" id="svForm" novalidate>'
        + (tab === 'up' ? '<label>Your first name<input id="svName" autocomplete="given-name" maxlength="40" placeholder="e.g. Sarah"></label>' : '')
        + '<label>Email<input id="svEmail" type="email" autocomplete="email" inputmode="email" placeholder="you@example.com"></label>'
        + '<label>Password' + (tab === 'up' ? ' (at least 8 characters)' : '') + '<input id="svPass" type="password" autocomplete="' + (tab === 'up' ? 'new-password' : 'current-password') + '"></label>'
        + '<button class="svbtn primary" type="submit" id="svGo">' + (tab === 'up' ? 'Create my account' : 'Sign in') + '</button>'
        + (tab === 'in' ? '<button class="svlink" type="button" id="svForgot">Forgot your password?</button>' : '')
        + '</form><p class="svfine">Your recipes are private to you and the people you invite.</p></div>';
      const kn = root.querySelector('#svName'), ke = root.querySelector('#svEmail'); if(kn) kn.value = keep.name; if(ke) ke.value = keep.email;
      root.querySelectorAll('[data-t]').forEach(b => b.onclick = () => { tab = b.dataset.t; draw(''); });
      root.querySelectorAll('[data-oauth]').forEach(b => b.onclick = () => oauth(b.dataset.oauth, draw));
      const form = root.querySelector('#svForm');
      form.onsubmit = async e => { e.preventDefault();
        const email = root.querySelector('#svEmail').value.trim(), pass = root.querySelector('#svPass').value, name = tab === 'up' ? root.querySelector('#svName').value.trim() : '';
        if(!/^\S+@\S+\.\S+$/.test(email)){ draw('Enter a valid email address.', true); root.querySelector('#svEmail').value = email; return; }
        if(tab === 'up' && !name){ draw('Add your first name so the family knows who saved what.', true); return; }
        if(pass.length < (tab === 'up' ? 8 : 1)){ draw(tab === 'up' ? 'Use a password with at least 8 characters.' : 'Enter your password.', true); return; }
        const go = root.querySelector('#svGo'); go.disabled = true; go.textContent = 'One moment…';
        try{
          if(tab === 'up'){
            pendingName = name;
            const o = await gotrue('signup', { email, password: pass, data: { name } });
            if(o.access_token){ saveSession(toSession(o)); LS.set('sv:seen', true); await afterSignIn(); }
            else { draw('Almost there. We sent a confirmation link to <b>' + esc(email) + '</b>. Tap it, then come back here and sign in.'); tab = 'in'; }
          } else {
            const o = await gotrue('token?grant_type=password', { email, password: pass });
            saveSession(toSession(o)); LS.set('sv:seen', true); await afterSignIn();
          }
        }catch(err){ const m = String(err.message || '');
          draw(/already registered|already been registered/i.test(m) ? 'That email already has an account. Tap Sign in instead.' : /invalid login/i.test(m) ? 'That email and password don’t match. Try again, or tap “Forgot your password?”.' : /not confirmed/i.test(m) ? 'Confirm your email first: we sent you a link when you signed up.' : esc(m), true); }
      };
      const fg = root.querySelector('#svForgot');
      if(fg) fg.onclick = async () => { const email = root.querySelector('#svEmail').value.trim();
        if(!/^\S+@\S+\.\S+$/.test(email)){ draw('Type your email above first, then tap “Forgot your password?”.', true); return; }
        try{ await gotrue('recover', { email }); draw('If that email has an account, a reset link is on its way.'); }catch(err){ draw(esc(err.message), true); } };
    };
    draw(msg || (oauthError ? esc(oauthError) : ''), !!(msg || oauthError)); oauthError = '';
  }
  function oauth(provider, draw){
    const redirect = location.origin + location.pathname;
    if(!BASE){ draw('Sign-in isn’t set up yet.', true); return; }
    LS.set('sv:seen', true);
    location.href = AUTH + 'authorize?provider=' + provider + '&redirect_to=' + encodeURIComponent(redirect);
  }
  signedOutHandler = () => { if(!document.getElementById('svScreen')) showSignIn('Your session ended. Please sign in again.', 'in'); };

  /* ---------- account menu, books, sharing ---------- */
  const ROLE_NAME = { owner: 'Owner', admin: 'Admin', contributor: 'Contributor', viewer: 'Viewer' };
  function modal(inner, label){
    const old = document.getElementById('svModal'); if(old) old.remove();
    const m = el('<div class="svpanel" role="dialog" aria-label="' + esc(label) + '">' + inner + '</div>', 'svmodal', 'svModal');
    m.addEventListener('click', e => { if(e.target === m) m.remove(); });
    document.body.append(m); m.querySelectorAll('.svx').forEach(b => b.onclick = () => m.remove());
    document.addEventListener('keydown', function k(e){ if(e.key === 'Escape'){ m.remove(); document.removeEventListener('keydown', k); } });
    return m;
  }
  const toast = t => { try{ const x = document.getElementById('toast') || document.querySelector('.toast'); if(x){ x.textContent = t; x.classList.add('show'); setTimeout(() => x.classList.remove('show'), 2600); return; } }catch{} };
  function importsText(){ return unlimited ? 'Recipe imports: unlimited' : importsLeft != null ? 'Recipe imports left this week: ' + importsLeft + ' of ' + weeklyLimit + ' · resets Monday' : ''; }
  function refreshAcctBadge(){ const b = document.getElementById('svBadge'); if(b) b.textContent = importsText(); }
  function mountAccountUI(){
    const act = document.querySelector('.header-actions');
    if(act && !document.getElementById('svAcctTop')){ const ab = document.createElement('button'); ab.id = 'svAcctTop'; ab.type = 'button'; ab.className = 'btn small outline'; ab.textContent = 'Account'; ab.setAttribute('aria-label', 'Account, books and sign out'); ab.onclick = openAccount;
      const sh = document.getElementById('shareBtn'); if(sh && sh.nextSibling) act.insertBefore(ab, sh.nextSibling); else act.append(ab); }
    const prof = document.querySelector('.profile'); if(!prof || document.getElementById('svAcct')) return;
    const b = document.createElement('button'); b.id = 'svAcct'; b.type = 'button'; b.className = 'svbtn small'; b.textContent = 'Account & books'; b.style.margin = '8px 4px 0';
    b.onclick = openAccount; prof.after(b);
    const t = document.createElement('div'); t.id = 'svBadge'; t.className = 'svbadge'; b.after(t); refreshAcctBadge();
  }
  async function openAccount(){
    try{ applyMe(await rpc('sv_me', {})); }catch{}
    const cur = books.find(x => x.id === activeBook) || {};
    const m = modal('<div class="svhead"><h3>Your account</h3><button class="svx" type="button" aria-label="Close">×</button></div>'
      + '<div class="svrow"><div class="grow"><b>' + esc(me.name || 'You') + '</b><small>' + esc(me.email) + '</small></div></div>'
      + '<label class="svform" style="display:grid;gap:4px;font-size:.85rem;color:var(--muted)">Your first name<span style="display:flex;gap:8px"><input class="svinp" id="acName" maxlength="40" value="' + esc(me.name) + '"><button class="svbtn small" type="button" id="acSave">Save</button></span></label>'
      + '<h4>Your recipe books</h4><div id="acBooks">' + books.map(b => '<div class="svrow"><div class="grow"><b>' + esc(b.name) + '</b>' + (b.id === activeBook ? ' <span class="svchip">open now</span>' : '') + '<small>' + ROLE_NAME[b.role] + '</small></div>'
        + (b.id === activeBook ? '' : '<button class="svbtn small" type="button" data-open="' + esc(b.id) + '">Open</button>') + '</div>').join('') + '</div>'
      + '<div style="display:flex;gap:8px;flex-wrap:wrap"><button class="svbtn small" type="button" id="acNew">+ New recipe book</button>'
      + (cur.role === 'owner' || cur.role === 'admin' ? '<button class="svbtn small" type="button" id="acRename">Rename this book</button>' : '') + '<button class="svbtn small" type="button" id="acShare">Share & members</button></div>'
      + '<h4>Recipe imports</h4><p class="svfine">' + (unlimited ? 'Your account has no import limit.' : (importsLeft != null ? 'You have ' + importsLeft + ' of your ' + weeklyLimit + ' free recipe imports left this week. An import is one recipe added with Claude from a link or screenshots, drafts, photos and retries included. Typing recipes in yourself is always free and unlimited. It resets every Monday.' : '')) + '</p>'
      + '<button class="svbtn danger" type="button" id="acOut">Sign out</button>', 'Your account');
    m.querySelector('#acSave').onclick = async () => { const v = m.querySelector('#acName').value.trim(); if(!v) return; try{ await window.RecipeBoxPeople.setName(v); toast('Name saved'); m.remove(); location.reload(); }catch{ toast('Couldn’t save'); } };
    m.querySelectorAll('[data-open]').forEach(x => x.onclick = async () => { try{ await rpc('sv_set_home', { book: x.dataset.open }); }catch{} location.hash = ''; location.reload(); });
    m.querySelector('#acNew').onclick = async () => { const n = prompt('Name for the new recipe book'); if(n == null) return; try{ await rpc('sv_new_book', { book_name: n }); location.hash = ''; location.reload(); }catch(e){ toast(e.message === 'too_many_books' ? 'You have the most books allowed' : 'Couldn’t create it'); } };
    const rn = m.querySelector('#acRename'); if(rn) rn.onclick = async () => { const n = prompt('New name for this recipe book', cur.name || ''); if(!n) return; try{ await rpc('sv_rename_book', { book: activeBook, new_name: n }); location.reload(); }catch{ toast('Couldn’t rename'); } };
    m.querySelector('#acShare').onclick = () => { m.remove(); openShare(); };
    m.querySelector('#acOut').onclick = async () => { try{ await realFetch(AUTH + 'logout', { method: 'POST', headers: { apikey: CFG.supabaseKey, Authorization: 'Bearer ' + (session ? session.access_token : '') } }); }catch{}
      saveSession(null); try{ Object.keys(localStorage).filter(k => k.startsWith('recipebox:') || k.startsWith('sv:since')).forEach(k => localStorage.removeItem(k)); }catch{} location.hash = ''; location.reload(); };
  }
  async function openShare(){
    const role = roleOf(activeBook), canManage = role === 'owner' || role === 'admin', bk = books.find(b => b.id === activeBook) || {};
    const m = modal('<div class="svhead"><h3>Share “' + esc(bk.name || 'this book') + '”</h3><button class="svx" type="button" aria-label="Close">×</button></div><div id="shBody"><p class="svfine">Loading…</p></div>', 'Share');
    const body = m.querySelector('#shBody');
    let members = [], invites = [];
    try{ const snap = await db.collection('books/' + activeBook + '/members').get(); members = snap.docs.map(d => ({ id: d.id, ...d.data() })); }catch{}
    if(canManage){ try{ invites = await rpc('sv_list_invites', { book: activeBook }) || []; }catch{} }
    const link = c => location.origin + location.pathname + '?join=' + c;
    const draw = () => {
      body.innerHTML = (canManage ? '<h4>Invite someone</h4><p class="svfine">They tap the link, create a free account (or sign in) and join this book. Each person keeps their own account.</p>'
        + '<div style="display:flex;gap:8px;flex-wrap:wrap"><select id="shRole" class="svinp" style="flex:1 1 150px"><option value="contributor">Contributor: can add and edit recipes</option><option value="viewer">Viewer: can look only</option>' + (role === 'owner' ? '<option value="admin">Admin: can also invite people</option>' : '') + '</select>'
        + '<button class="svbtn primary small" type="button" id="shMake">Create invite link</button></div><div id="shNew"></div>'
        + (invites.length ? '<h4>Open invite links</h4>' + invites.map(i => '<div class="svrow"><div class="grow"><span class="svchip">' + ROLE_NAME[i.role] + '</span> <small>used ' + i.uses + ' of ' + i.max_uses + ' · expires ' + new Date(i.expires_at).toLocaleDateString() + '</small></div><button class="svbtn small" type="button" data-copy="' + esc(i.code) + '">Copy link</button><button class="svbtn small danger" type="button" data-revoke="' + esc(i.code) + '">Turn off</button></div>').join('') : '') : '<p class="svfine">Only the book’s owner and admins can invite people.</p>')
        + '<h4>People in this book</h4>' + members.sort((a, b) => (a.role === 'owner' ? -1 : 1)).map(p => '<div class="svrow"><div class="grow"><b>' + esc(p.name || 'Someone') + (p.id === me.id ? ' (you)' : '') + '</b></div>'
          + (canManage && p.role !== 'owner' && p.id !== me.id && !(role === 'admin' && p.role === 'admin')
            ? '<select data-role="' + esc(p.id) + '"><option value="contributor"' + (p.role === 'contributor' ? ' selected' : '') + '>Contributor</option><option value="viewer"' + (p.role === 'viewer' ? ' selected' : '') + '>Viewer</option>' + (role === 'owner' ? '<option value="admin"' + (p.role === 'admin' ? ' selected' : '') + '>Admin</option>' : '') + '</select><button class="svbtn small danger" type="button" data-remove="' + esc(p.id) + '">Remove</button>'
            : '<span class="svchip">' + (ROLE_NAME[p.role] || p.role) + '</span>' + (p.id === me.id && p.role !== 'owner' ? '<button class="svbtn small danger" type="button" data-remove="' + esc(p.id) + '">Leave</button>' : '')) + '</div>').join('');
      const mk = body.querySelector('#shMake');
      if(mk) mk.onclick = async () => { mk.disabled = true; try{ const c = await rpc('sv_create_invite', { book: activeBook, as_role: body.querySelector('#shRole').value, days: 14, uses: 25 });
          const msg = 'Join my recipe book “' + (bk.name || '') + '” on Savor: ' + link(c);
          body.querySelector('#shNew').innerHTML = '<div class="svlink2" style="margin-top:10px">' + esc(link(c)) + '</div><div style="display:flex;gap:8px;margin-top:8px;flex-wrap:wrap"><button class="svbtn small primary" type="button" id="shCopy">Copy message</button>' + (navigator.share ? '<button class="svbtn small" type="button" id="shSend">Send…</button>' : '') + '</div><p class="svfine">Works for 14 days and up to 25 people. You can turn it off any time.</p>';
          const cp = body.querySelector('#shCopy'); cp.onclick = async () => { try{ await navigator.clipboard.writeText(msg); cp.textContent = 'Copied ✓'; }catch{ cp.textContent = 'Press and hold the link to copy'; } };
          const sd = body.querySelector('#shSend'); if(sd) sd.onclick = () => navigator.share({ title: 'Savor', text: 'Join my recipe book on Savor', url: link(c) }).catch(() => {});
          invites = await rpc('sv_list_invites', { book: activeBook }) || invites;
        }catch(e){ body.querySelector('#shNew').innerHTML = '<div class="svmsg err">Couldn’t make a link (' + esc(e.message) + ').</div>'; } mk.disabled = false; };
      body.querySelectorAll('[data-copy]').forEach(x => x.onclick = async () => { try{ await navigator.clipboard.writeText('Join my recipe book on Savor: ' + link(x.dataset.copy)); x.textContent = 'Copied ✓'; }catch{} });
      body.querySelectorAll('[data-revoke]').forEach(x => x.onclick = async () => { try{ await rpc('sv_revoke_invite', { c: x.dataset.revoke }); invites = invites.filter(i => i.code !== x.dataset.revoke); draw(); }catch{} });
      body.querySelectorAll('[data-role]').forEach(x => x.onchange = async () => { try{ await rpc('sv_set_role', { book: activeBook, member: x.dataset.role, new_role: x.value }); toast('Role changed'); }catch(e){ toast('Couldn’t change that'); } });
      body.querySelectorAll('[data-remove]').forEach(x => x.onclick = async () => { const self = x.dataset.remove === me.id;
        if(!confirm(self ? 'Leave this recipe book? You can rejoin only if someone invites you again.' : 'Remove this person from the book?')) return;
        try{ await rpc('sv_remove_member', { book: activeBook, member: x.dataset.remove }); if(self){ location.hash = ''; location.reload(); return; } members = members.filter(p => p.id !== x.dataset.remove); draw(); }catch{ toast('Couldn’t do that'); } });
    };
    draw();
  }

  /* ---------- the doorway the app uses ---------- */
  const caps = { db, user, assets };
  window.claude = Object.freeze({ use: async name => { await ready; if(name === 'sample') return claudeOn(); return caps[name] || null; } });
  window.RecipeBoxWeb = { familyLink: () => location.href, openShare, recheckClaude: () => { claudeReady = null; return claudeOn(); }, signedInAs: () => me };
  window.RecipeBoxWeb.findPhotos = async (urls, dish, importId) => {
    const r = await callClaude({ photos: (urls || []).filter(Boolean).slice(0, 5), dish: dish || '', ...(importId ? { import_id: importId } : {}) });
    return (r.photos || []).map(p => { const bin = atob(p.data); const a = new Uint8Array(bin.length); for(let i = 0; i < bin.length; i++) a[i] = bin.charCodeAt(i);
      const blob = new Blob([a], { type: p.media_type }); return { blob, url: URL.createObjectURL(blob), site: p.site, page: p.page, fit: p.fit === 'whole' ? 'whole' : 'fill', w: p.w, h: p.h }; });
  };

  /* ---------- start: signed in already, or ask ---------- */
  async function start(){
    if(!BASE){ document.body.append(el('<div class="svbox"><h2>Savor</h2><p>This copy isn’t connected to a database yet.</p></div>', 'svscreen')); return; }
    if(session){
      const t = await freshToken(false);
      if(t){ try{ const u = await gotrue('user', null, 'GET', t); if(u && u.id){ me.email = u.email || ''; session.user = u; saveSession(session); } }catch(e){ if(e.status === 401 || e.status === 403){ saveSession(null); } }
      }
    }
    if(session){ if(await afterSignIn()) return; }
    showSignIn('', LS.get('sv:join', '') ? 'up' : undefined);
  }
  if(document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
})();
