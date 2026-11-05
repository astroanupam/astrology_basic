// Lets the course open without internet.
//  - App files (index.html, manifest, icons, data/langs.js, each data/<lang>/index.js): network first (so a new build is picked up at once), the saved copy when the network is slow or missing.
//  - Course data (data/<lang>/<chunk|search|flashcards>.js?v=<hash>): cache first. The URL carries the data version, so a saved copy is never stale.
//  - The page can ask this worker to save the whole course ({type:'precache', urls:[...]} on a MessageChannel); progress comes back on the port.
// BUILD is stamped by _build\make-upload.ps1 (a hash of every file this worker can cache, and of this code): any change of the program, the data,
// the photographs or this file gives a new cache name and removes the old cache (saved course data whose version did not change is carried over).
// The SHELL line below is written by make-upload.ps1 from the package contents (page, manifest, icons, data\langs.js, data\<lang>\index.js, assets\).
const BUILD = '276c4e94f7bb';
const PREFIX = 'astrosutras-basics-';
const CACHE = PREFIX + BUILD;
const SHELL = ['./', 'index.html', 'manifest.json', 'icon.svg', 'icon-180.png', 'icon-192.png', 'icon-512.png', 'data/langs.js', 'data/en/index.js', 'assets/team/anoopam-shukla.jpg', 'assets/team/kaushik-mitra.jpg', 'assets/team/shweta-vijayvarrgiya.jpg', 'assets/team/upendra-singh-bhadoriya.jpg'];
const abs = u => new URL(u, self.registration.scope).href;

// The course index of every language that has data (data/langs.js lists them) belongs to the shell, so a language chosen on the first visit also opens offline.
async function shellList() {
  const list = SHELL.slice();
  try {
    const r = await fetch(abs('data/langs.js'), { cache: 'reload' });
    const m = r.ok ? /LANGS\s*=\s*\[([^\]]*)\]/.exec(await r.text()) : null;
    if (m) (m[1].match(/[a-z]{2,3}(?:-[a-z0-9]{2,8})?/g) || []).forEach(c => { const u = 'data/' + c + '/index.js'; if (list.indexOf(u) < 0) list.push(u); });
  } catch (err) { /* the fixed list is enough */ }
  return list;
}
self.addEventListener('install', e => e.waitUntil(
  shellList().then(list => caches.open(CACHE).then(c => Promise.all(list.map(u => c.add(new Request(abs(u), { cache: 'reload' })).catch(() => {}))))).then(() => self.skipWaiting())));
// Course data URLs carry the data version (?v=...). A saved file whose version is still the current one stays valid when only the program changed,
// so it is moved to the new cache (with the photographs): an update must not throw away the offline copy that the reader downloaded.
async function keepSavedData(oldKeys, c) {
  const cur = {};
  for (const req of await c.keys()) {
    const m = /\/data\/([^/]+)\/index\.js$/.exec(new URL(req.url).pathname);
    if (!m) continue;
    const res = await c.match(req), v = res ? /"dataVersion":"([0-9a-f]+)"/.exec(await res.text()) : null;
    if (v) cur[m[1]] = v[1];
  }
  for (const k of oldKeys) {
    const old = await caches.open(k);
    for (const req of await old.keys()) {
      const u = new URL(req.url), m = /\/data\/([^/]+)\/[^/]+\.js$/.exec(u.pathname), v = u.searchParams.get('v');
      const keep = (m && v && cur[m[1]] === v) || /\/assets\//.test(u.pathname);   // the team photographs are fetched fresh (network first) whenever they are shown
      if (keep && !(await c.match(req))) { const res = await old.match(req); if (res) await c.put(req, res); }
    }
  }
}
self.addEventListener('activate', e => e.waitUntil((async () => {
  const old = (await caches.keys()).filter(k => k.indexOf(PREFIX) === 0 && k !== CACHE);
  try { await keepSavedData(old, await caches.open(CACHE)); } catch (err) { /* only a convenience: the pages are saved again when they are opened */ }
  await Promise.all(old.map(k => caches.delete(k)));
  await self.clients.claim();
})()));

const fromCache = req => caches.match(req, { ignoreSearch: true }).then(r => r || (req.mode === 'navigate' ? caches.match(abs('index.html')) : undefined));
function networkFirst(req) {
  return new Promise(resolve => {
    let settled = false;
    const timer = setTimeout(() => { if (!settled) fromCache(req).then(r => { if (r && !settled) { settled = true; resolve(r); } }); }, 4000);   // slow link: use the saved copy
    fetch(req, { cache: 'no-cache' }).then(res => {
      clearTimeout(timer);
      if (res.ok) { const copy = res.clone(); caches.open(CACHE).then(c => c.put(req, copy)); }
      if (!settled) { settled = true; resolve(res); }
    }).catch(() => { clearTimeout(timer); fromCache(req).then(r => { if (!settled) { settled = true; resolve(r || Response.error()); } }); });
  });
}
function cacheFirst(req) {
  return caches.match(req).then(hit => {
    if (hit) return hit;
    return fetch(req).then(res => { if (res.ok) { const copy = res.clone(); caches.open(CACHE).then(c => c.put(req, copy)); } return res; });
  });
}
self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return;
  const versionedData = /\/data\//.test(url.pathname) && /[?&]v=/.test(url.search);
  e.respondWith(versionedData ? cacheFirst(req) : networkFirst(req));
});

self.addEventListener('message', e => {
  const d = e.data || {};
  if (d.type !== 'precache' || !Array.isArray(d.urls)) return;
  const port = e.ports && e.ports[0], total = d.urls.length;
  e.waitUntil((async () => {
    const c = await caches.open(CACHE), queue = d.urls.slice();
    let done = 0, failed = 0;
    async function worker() {
      while (queue.length) {
        const u = queue.shift();
        try {
          const a = abs(u); if (new URL(a).origin !== location.origin) throw new Error('foreign');
          const versioned = /[?&]v=/.test(a);
          if (!(versioned && await c.match(a))) { const res = await fetch(a, { cache: 'reload' }); if (!res.ok) throw new Error('http ' + res.status); await c.put(a, res); }
        } catch (err) { failed++; }
        done++; if (port) port.postMessage({ type: 'progress', done, total });
      }
    }
    await Promise.all([worker(), worker(), worker()]);
    if (port) port.postMessage({ type: 'done', done, total, failed });
  })());
});
