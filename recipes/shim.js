/* Family Recipe Box, website edition.
   Gives the app the same storage, people and photo features it had inside Claude,
   backed by a Supabase project. Access is by the family link: the key in the link
   is checked by the database on every read and write. */
(() => {
  const CFG = window.RECIPE_BOX_CONFIG || {};
  const API = (CFG.supabaseUrl || '').replace(/\/+$/, '') + '/rest/v1/rpc/';
  const LS = {
    get(k, d){ try{ const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); }catch{ return d; } },
    set(k, v){ try{ localStorage.setItem(k, JSON.stringify(v)); }catch{} }
  };

  /* The family key arrives once in the link (?k=...), then lives on this device */
  const url = new URL(location.href);
  const fromLink = url.searchParams.get('k');
  if(fromLink) LS.set('rb:key', fromLink);
  /* Can this browser keep anything? (Safari's "Block All Cookies", some in-app browsers and
     privacy modes refuse.) If not, the app still works from the key in the link. */
  const STORAGE_OK = (() => { try{ localStorage.setItem('rb:test', '1'); localStorage.removeItem('rb:test'); return true; }catch{ return false; } })();
  const KEY = String(fromLink || LS.get('rb:key', '') || '').trim();
  /* Keep the family key in the address, so sharing the page any way (Safari's Share, copying the
     address bar) always sends a link that works for the person receiving it. */
  if(KEY && fromLink !== KEY){ url.searchParams.set('k', KEY); history.replaceState(null, '', url.pathname + url.search + url.hash); }

  async function rpc(fn, args){
    const headers = { 'Content-Type': 'application/json', apikey: CFG.supabaseKey };
    if(/^eyJ/.test(CFG.supabaseKey || '')) headers.Authorization = 'Bearer ' + CFG.supabaseKey;
    let res;
    try{ res = await fetch(API + fn, { method: 'POST', headers, body: JSON.stringify({ k: KEY, ...args }) }); }
    catch{ throw { code: 'unavailable', message: 'No connection' }; }
    if(!res.ok){
      let body = {}; try{ body = await res.json(); }catch{}
      if(/bad_key/.test(body.message || '')){ showKeyScreen('bad'); throw { code: 'not_granted', message: 'This link’s key is not valid' }; }
      throw { code: res.status >= 500 ? 'unavailable' : 'invalid_argument', message: body.message || ('HTTP ' + res.status) };
    }
    const t = await res.text(); return t ? JSON.parse(t) : null;
  }

  /* ---------- local mirror of the database, kept fresh by polling for changes ---------- */
  const mirror = new Map();          // path -> data
  const loadedParents = new Set();   // collections fully loaded
  const subs = new Set();            // { kind:'doc'|'col', path, fn, err }
  let since = LS.get('rb:since', null), polling = null, lastPoll = 0;
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
    const rows = await rpc('rb_list', { par: col }) || [];
    for(const r of rows) mirror.set(r.path, r.data);
    loadedParents.add(col);
    if(!since) since = rows.reduce((m, r) => r.updated_at > (m || '') ? r.updated_at : m, since);
  }
  async function poll(){
    if(document.hidden && Date.now() - lastPoll < 60000) return;
    lastPoll = Date.now();
    try{
      const rows = await rpc('rb_changes', { since: since || '1970-01-01T00:00:00Z' }) || [];
      if(!rows.length) return;
      const changed = new Set();
      for(const r of rows){
        if(r.updated_at > (since || '')) since = r.updated_at;
        const known = loadedParents.has(r.parent) || [...subs].some(s => s.path === r.path);
        if(!known) continue;
        if(r.deleted) mirror.delete(r.path); else mirror.set(r.path, r.data);
        changed.add(r.path);
      }
      LS.set('rb:since', since);
      if(changed.size) notify(changed);
    }catch{}
  }
  function startPolling(){ if(polling) return; polling = setInterval(poll, 4000);
    if(!since) rpc('rb_now', {}).then(t => { if(!since && t) since = t; }).catch(()=>{});
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
      async get(){ if(!mirror.has(path) && !loadedParents.has(parentOf(path))){ const d = await rpc('rb_get', { p: path }); if(d != null) mirror.set(path, d); } return snapDoc(path); },
      async set(data){ const d = clone(data); mirror.set(path, d); notify(new Set([path])); await rpc('rb_set', { p: path, d }); },
      async update(data){ if(!mirror.has(path)){ const d = await rpc('rb_get', { p: path }); if(d == null) throw { code: 'invalid_argument', message: 'Document does not exist' }; mirror.set(path, d); }
        mirror.set(path, merge(mirror.get(path), clone(data))); notify(new Set([path])); await rpc('rb_update', { p: path, d: clone(data) }); },
      async delete(){ mirror.delete(path); notify(new Set([path])); await rpc('rb_delete', { p: path }); },
      async acquire(){ return { acquired: true, expiresAt: Date.now() + 10000 }; },
      onSnapshot(fn, err){ const s = { kind: 'doc', path, fn, err }; subs.add(s); startPolling();
        (async () => { try{ if(!mirror.has(path)){ const d = await rpc('rb_get', { p: path }); if(d != null) mirror.set(path, d); } fn(snapDoc(path)); }
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

  /* ---------- people: a name per device, shown as "Added by …" ---------- */
  let me = LS.get('rb:me', null);
  if(!me){ me = { id: 'u_' + Math.random().toString(36).slice(2, 12) + Date.now().toString(36), name: '' }; LS.set('rb:me', me); }
  const names = {};
  const user = Object.freeze({
    id: async () => me.id,
    me: async () => ({ id: me.id, name: me.name, email: '' }),
    isOwner: async () => true,
    canEdit: async () => true,
    can: async () => true,
    async profiles(ids){ const out = {};
      await Promise.all(ids.map(async id => { if(names[id] === undefined){ try{ const d = await rpc('rb_get', { p: 'people/' + id }); names[id] = (d && d.name) || ''; }catch{ names[id] = ''; } }
        out[id] = { id, name: id === me.id ? (me.name || 'You') : names[id] }; }));
      return out; },
    search: async () => []
  });
  window.RecipeBoxPeople = { me: () => me, async setName(n){ me.name = String(n || '').trim().slice(0, 40); LS.set('rb:me', me); names[me.id] = me.name; await rpc('rb_set', { p: 'people/' + me.id, d: { name: me.name, at: Date.now() } }); } };

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
      await rpc('rb_photo_put', { pid: id, pdata: data }); photoCache.set(id, data);
      return { id, url: '/_blob/' + id, sizeBytes: data.length, contentType: 'image/jpeg' }; },
    async list(){ return { assets: [], usage: {} }; },
    async delete(){}
  });
  async function photo(id){
    if(photoCache.has(id)) return photoCache.get(id);
    const p = rpc('rb_photo_get', { pid: id }).then(d => { photoCache.set(id, d || ''); return d || ''; });
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
  const realFetch = window.fetch.bind(window);
  window.fetch = async (input, init) => {
    const u = typeof input === 'string' ? input : (input && input.url) || '';
    const m = u.match(/\/_blob\/([A-Za-z0-9_-]+)$/);
    if(m){ const d = await photo(m[1]); if(!d) return new Response('', { status: 404 }); return realFetch(d); }
    return realFetch(input, init);
  };

  /* ---------- no key: tell people how to get in ---------- */
  function showKeyScreen(why){
    if(document.getElementById('keyScreen')) return;
    const d = document.createElement('div'); d.id = 'keyScreen'; d.className = 'keyscreen';
    const msg = why === 'bad'
      ? 'This family link isn’t accepted. It may have been cut off when it was sent, or the family link has changed. Ask whoever invited you to tap <b>Share</b> in the recipe box and send the link again.'
      : 'This recipe box is private to our family. Open it with the family link: ask whoever invited you to tap <b>Share</b> inside the recipe box and send you the link it shows.';
    d.innerHTML = '<div class="box"><h2>Family Recipe Box</h2><p>' + msg + ' If you have it, paste it below.</p>'
      + '<form id="keyForm"><input id="keyIn" class="inp" placeholder="Paste the family link" autocomplete="off" aria-label="Family link"><button class="btn primary" type="submit">Open</button></form></div>';
    document.body.append(d);
    d.querySelector('#keyForm').onsubmit = e => { e.preventDefault(); const v = d.querySelector('#keyIn').value.trim();
      let k = v; try{ k = new URL(v).searchParams.get('k') || v; }catch{}
      if(k){ LS.set('rb:key', k); const u = new URL(location.href); u.searchParams.set('k', k); location.href = u.pathname + u.search; } };
  }
  if(!KEY) document.addEventListener('DOMContentLoaded', () => showKeyScreen('missing'));
  /* Browser won't save anything: say so once, and how to keep coming back */
  if(KEY && !STORAGE_OK) document.addEventListener('DOMContentLoaded', () => setTimeout(() => {
    const n = document.createElement('div'); n.className = 'storenote'; n.setAttribute('role', 'status');
    n.innerHTML = 'This browser isn’t saving website data, so it won’t remember you. Bookmark this page, or open the link in Safari or Chrome. <button type="button" aria-label="Dismiss">×</button>';
    n.querySelector('button').onclick = () => n.remove(); document.body.append(n); }, 600));
  /* first visit on this device: ask for a name so recipes say who added them */
  function askName(){
    if(me.name || !STORAGE_OK || document.getElementById('nameScreen')) return;
    const d = document.createElement('div'); d.id = 'nameScreen'; d.className = 'keyscreen';
    d.innerHTML = '<form class="box" id="nameForm"><h2>Welcome to the Family Recipe Box</h2><p>What’s your first name? It shows on the recipes you add.</p>'
      + '<input id="nameIn" class="inp" maxlength="40" autocomplete="given-name" placeholder="e.g. Sarah" aria-label="Your first name"><button class="btn primary" type="submit">Start</button></form>';
    document.body.append(d); setTimeout(() => d.querySelector('#nameIn').focus(), 50);
    d.querySelector('#nameForm').onsubmit = async e => { e.preventDefault(); const n = d.querySelector('#nameIn').value.trim(); if(!n) return;
      try{ await window.RecipeBoxPeople.setName(n); }catch{} d.remove(); };
  }
  if(KEY) document.addEventListener('DOMContentLoaded', () => setTimeout(askName, 400));

  /* ---------- the same doorway the app used inside Claude ---------- */
  /* ---------- Claude: reading posts, filling in recipes, categories, grocery lists ----------
     Calls the rb-claude function in the same Supabase project, which holds the Anthropic key. */
  const FN = (CFG.supabaseUrl || '').replace(/\/+$/, '') + '/functions/v1/rb-claude';
  async function callClaude(body){
    let res;
    try{ res = await realFetch(FN, { method: 'POST', headers: { 'Content-Type': 'application/json', apikey: CFG.supabaseKey }, body: JSON.stringify({ k: KEY, ...body }) }); }
    catch{ throw { code: 'unavailable', message: 'No connection' }; }
    let out = {}; try{ out = await res.json(); }catch{}
    if(!res.ok) throw { code: out.code || (res.status === 429 ? 'rate_limited' : 'unavailable'), message: out.message || ('HTTP ' + res.status) };
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
    const r = await callClaude({ prompt: toPrompt(input), images: await toImages(opts.images), web: !!opts.web });
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
  /* Only offer Claude's buttons once the key has been added (the check reads nothing and costs nothing) */
  let claudeReady = null;
  const claudeOn = () => claudeReady || (claudeReady = callClaude({ ping: true })
    .then(() => { window.RecipeBoxWeb.claudeStatus = 'on'; return sample; },
          e => { window.RecipeBoxWeb.claudeStatus = (e && e.code) || 'unavailable'; return null; }));

  const caps = { db, user, assets };
  window.claude = Object.freeze({ use: async name => {
    if(!KEY || !CFG.supabaseUrl) return null;
    if(name === 'sample') return claudeOn();
    return caps[name] || null; } });
  window.RecipeBoxWeb = { familyLink: () => location.origin + location.pathname.replace(/index\.html$/, '') + '?k=' + encodeURIComponent(KEY) };
})();
