/* Service Worker — يجعل التطبيق يعمل دون إنترنت بعد أول فتح */
const VERSION = 'att-app-v6.2.1';      // غيّر الرقم عند كل تحديث لملفات التطبيق
const CDN_CACHE = 'att-cdn-v1';        // المكتبات ونماذج الوجه (~10MB) لا تُحذف عند التحديث
const CORE = ['./', './index.html', './app.js?v=6.2.1', './firebase-config.js', './manifest.webmanifest', './icons/icon-192.png', './icons/icon-512.png', './icons/maskable-192.png', './icons/maskable-512.png', './icons/apple-touch-icon.png', './icons/favicon-64.png', './icons/icon.svg'];
const CDN_HOSTS = ['cdn.jsdelivr.net', 'unpkg.com', 'cdnjs.cloudflare.com', 'www.gstatic.com', 'fonts.googleapis.com', 'fonts.gstatic.com'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(VERSION).then(c => c.addAll(CORE)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== VERSION && k !== CDN_CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

// ملفات التطبيق: من الشبكة أولاً (لتصل التحديثات) ثم من الذاكرة عند انقطاع الإنترنت
async function networkFirst(req){
  const cache = await caches.open(VERSION);
  try{
    const res = await Promise.race([fetch(req.mode === 'navigate' ? req : new Request(req, {cache:'no-cache'})), new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 4000))]);
    if (res && res.ok) cache.put(req, res.clone());
    return res;
  }catch(err){
    const hit = await cache.match(req, {ignoreSearch:true});
    if (hit) return hit;
    if (req.mode === 'navigate'){ const idx = await cache.match('./index.html'); if (idx) return idx; }
    throw err;
  }
}
// المكتبات والنماذج: من الذاكرة أولاً (لا تتغير)
async function cacheFirst(req){
  const cache = await caches.open(CDN_CACHE);
  const hit = await cache.match(req);
  if (hit) return hit;
  const res = await fetch(req);
  if (res && (res.ok || res.type === 'opaque')) cache.put(req, res.clone());
  return res;
}

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (CDN_HOSTS.includes(url.hostname)) return e.respondWith(cacheFirst(req));
  if (url.origin === self.location.origin) return e.respondWith(networkFirst(req));
  // اتصالات Firestore و Auth لا تمر بالذاكرة؛ Firestore يدير العمل دون اتصال بنفسه
});

