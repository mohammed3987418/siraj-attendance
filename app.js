'use strict';
/* =====================================================================
   نظام حضور الطلبة ببصمة الوجه — جامعة السراج (متعدد الكليات والأقسام)
   - التعرف على الوجه داخل المتصفح (face-api) بدون خادم
   - Firebase Auth + Firestore مع العمل دون اتصال والمزامنة التلقائية
   - إن لم تُملأ firebase-config.js يعمل بوضع محلي تجريبي
   البيانات:
     att_org/main          : الفصل الحالي + الكليات + الأقسام (مراحل/دراسة/شعب)
     att_users/{uid}       : الدور + الكلية + الأقسام
     att_packs/{dept~stage~shift} : طلبة مرحلة/دراسة مع بصماتهم (قراءة واحدة لكل محاضرة)
     att_sessions/{auto}   : محاضرة = مستند واحد
   ===================================================================== */
const APP_VERSION = '6.3.0';
const SLOT_MS = 5000; // القيمة الافتراضية لتغيّر رمز QR (يختارها التدريسي لكل محاضرة)
const QR_GRACE_MS = 20000; // يُقبل الرمز حتى ~٢٠ ثانية بعد انتهاء خانته (زمن المسح والإرسال) عند الاتصال
const QR_ACCEPT_DAYS = 3;  // مهلة رفع حضور QR المحفوظ على هاتف الطالب دون اتصال
const QR_CAPTURE_TOL = 120000; // فرق مسموح (ملّي ثانية) بين وقت المسح على الهاتف ووقت الرمز
const QR_FACE_EXTRA_MS = 45000; // وقت إضافي لإكمال سيلفي التحقق من الوجه
const FACE_MATCH_MAX = 0.55;    // أقصى مسافة لقبول تطابق وجه الطالب مع بصمته
const FACE_TOKEN_MS = 120000;   // صلاحية السيلفي قبل مسح QR (دقيقتان)
const PF_SLOT_MS = 30000;       // رمز القاعة في طريقة "الوجه من هاتف الطالب" يتغير كل ٣٠ ثانية
const MODEL_URL = 'https://cdn.jsdelivr.net/npm/@vladmandic/face-api@1/model/';
const ROLES = {super:'مدير النظام', dean:'عميد الكلية', head:'رئيس القسم', registrar:'موظف تسجيل', committee:'اللجنة الامتحانية', qa:'قسم ضمان الجودة', instructor:'تدريسي', disabled:'معطّل'};
const ACTIVE_ROLES = ['super','dean','head','registrar','committee','qa','instructor'];
const TAB_ROLES = {
  tHome:ACTIVE_ROLES, tAnn:['super','dean','head','registrar'],
  tStudents:['super','dean','head','registrar'], tSession:['super','dean','head','instructor'],
  tRecords:['super','dean','head','committee','qa','instructor'], tExcuses:['super','dean','head'],
  tSchedule:['super','dean','head','qa','instructor'], tGrades:['super','dean','head','committee','qa','instructor'],
  tQA:['super','qa','dean','head'], tUsers:['super','dean','head'], tOrg:['super'], tSettings:ACTIVE_ROLES
};
const DEFAULT_ORG = {
  term:'2026-2027 / الفصل الأول',
  colleges:{'tech-eng':{name:'الكلية التقنية الهندسية'}},
  depts:{'ai-eng':{name:'هندسة تقنيات الذكاء الاصطناعي', collegeId:'tech-eng', stages:['الأولى','الثانية','الثالثة','الرابعة'], shifts:['صباحي','مسائي'], sections:['A','B']}}
};
const normRole = r => r === 'admin' ? 'super' : r;

/* ============ أدوات عامة ============ */
// عنصر بديل عند غياب عنصر في الصفحة (مثلاً عند رفع ملفات من إصدارين مختلفين) حتى لا يتوقف التطبيق كله
const NULL_EL = document.createElement('div');
const $ = s => document.querySelector(s) || NULL_EL;
// إظهار أي خطأ برمجي على الشاشة لتسهيل التشخيص
window.addEventListener('error', e => showFatal((e.message || 'خطأ') + (e.filename ? ` (${e.filename.split('/').pop()}:${e.lineno})` : '')));
window.addEventListener('unhandledrejection', e => { const m = e.reason && (e.reason.message || e.reason.code); if (m && !/permission|network|offline|unavailable|timeout/i.test(m)) console.warn('rejection', e.reason); });
function showFatal(msg){
  let b = document.getElementById('fatalBar');
  if (!b){ b = document.createElement('div'); b.id = 'fatalBar';
    b.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:200;background:#c0392b;color:#fff;padding:8px 14px;font:14px Tahoma;direction:rtl';
    document.body.appendChild(b); }
  b.innerHTML = `⚠ خطأ في التطبيق (الإصدار ${APP_VERSION}): ${String(msg).replace(/</g, '&lt;')} — <a href="#" style="color:#fff;text-decoration:underline" onclick="location.reload();return false">إعادة التحميل</a>`;
}
// التأكد أن ملفات الصفحة والتطبيق من الإصدار نفسه، وإلا تُحدَّث تلقائياً مرة واحدة
(function versionGuard(){
  const pageVer = (document.querySelector('meta[name=app-version]') || {}).content;
  if (pageVer === APP_VERSION) { try{ sessionStorage.removeItem('fa_vfix'); }catch(e){} return; }
  let tried = false; try{ tried = sessionStorage.getItem('fa_vfix') === APP_VERSION; sessionStorage.setItem('fa_vfix', APP_VERSION); }catch(e){}
  if (!tried){
    Promise.resolve(window.caches ? caches.keys().then(ks => Promise.all(ks.filter(k => k.startsWith('att-app')).map(k => caches.delete(k)))) : 0)
      .finally(() => location.reload());
  } else setTimeout(() => showFatal(`ملفات الصفحة (${pageVer || 'قديمة'}) لا تطابق ملف التطبيق (${APP_VERSION}). ارفع كل ملفات الإصدار نفسه إلى GitHub، ثم أعد التحميل.`), 500);
})();
const $$ = s => [...document.querySelectorAll(s)];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const LS = {
  get(k, d){ try{ const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; }catch(e){ return d; } },
  set(k, v){ try{ localStorage.setItem(k, JSON.stringify(v)); return true; }catch(e){ toast('تعذّر الحفظ على الجهاز: المساحة غير متاحة', 'err'); return false; } }
};
const deviceId = (() => { let d = LS.get('fa_device', null); if (!d){ d = 'D' + Math.random().toString(36).slice(2) + Date.now().toString(36); LS.set('fa_device', d); } return d; })();
const randHex = n => Array.from(crypto.getRandomValues(new Uint8Array(n)), b => b.toString(16).padStart(2, '0')).join('');
function toast(msg, type=''){
  const t = document.createElement('div'); t.className = 'toast ' + type; t.textContent = msg;
  $('#toasts').appendChild(t); setTimeout(() => t.remove(), 4500);
}
function confirmBox(title, text, yes='تأكيد'){
  return new Promise(res => {
    $('#confirmTitle').textContent = title; $('#confirmText').textContent = text; $('#confirmYes').textContent = yes;
    $('#confirmModal').classList.add('show');
    const done = v => { $('#confirmModal').classList.remove('show'); $('#confirmYes').onclick = $('#confirmNo').onclick = null; res(v); };
    $('#confirmYes').onclick = () => done(true); $('#confirmNo').onclick = () => done(false);
  });
}
function download(name, text, mime='text/plain'){
  const blob = new Blob([text], {type: mime + ';charset=utf-8'});
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name;
  document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}
const toCSV = rows => '﻿' + rows.map(r => r.map(v => '"' + String(v ?? '').replace(/"/g,'""') + '"').join(',')).join('\r\n');
const hhmm = () => new Date().toLocaleTimeString('en-GB', {hour:'2-digit', minute:'2-digit'});
const today = () => { const d = new Date(); d.setMinutes(d.getMinutes() - d.getTimezoneOffset()); return d.toISOString().slice(0,10); };
const nowISO = () => new Date().toISOString();
const cleanId = s => String(s ?? '').trim().replace(/[٠-٩]/g, c => c.charCodeAt(0) - 1632).replace(/[۰-۹]/g, c => c.charCodeAt(0) - 1776).replace(/[^\w-]/g, '-');
const slugOk = s => /^[a-z0-9][a-z0-9-]{1,30}$/.test(s);
const splitList = s => String(s || '').split(/[,،]/).map(x => x.trim()).filter(Boolean);
const strip = o => { const {_pending, ...x} = o; return x; };
const fbErr = e => {
  const m = {
    'auth/invalid-credential':'البريد أو كلمة المرور غير صحيحة', 'auth/wrong-password':'كلمة المرور غير صحيحة',
    'auth/user-not-found':'الحساب غير موجود', 'auth/too-many-requests':'محاولات كثيرة، حاول بعد قليل',
    'auth/network-request-failed':'لا يوجد اتصال بالإنترنت', 'auth/email-already-in-use':'البريد مستخدم مسبقاً',
    'auth/weak-password':'كلمة المرور ضعيفة (٦ أحرف على الأقل)', 'auth/invalid-email':'البريد غير صالح',
    'permission-denied':'ليست لديك صلاحية لهذه العملية', 'unavailable':'الخادم غير متاح حالياً'
  };
  return (e && m[e.code]) || (e && e.message) || String(e);
};
const bg = (p, okMsg) => p.then(() => { if (okMsg) toast(okMsg, 'ok'); }).catch(e => { console.error(e); toast('فشل الحفظ على الخادم: ' + fbErr(e), 'err'); });
const onErr = e => { console.error(e); toast('خطأ في المزامنة: ' + fbErr(e), 'err'); };

/* ============ إعدادات الجهاز ============ */
const Settings = {
  get(){ return Object.assign({threshold:0.5, liveness:'turn', minFrames:3, cameraId:''}, LS.get('fa_settings', {})); },
  save(s){ LS.set('fa_settings', s); }
};

/* ============ ضغط البصمة: 128 رقماً → 172 حرفاً (int8 + base64) ============ */
function encDesc(d){
  let s = '';
  for (let i = 0; i < 128; i++){ const v = Math.max(-127, Math.min(127, Math.round(d[i] * 254))); s += String.fromCharCode(v & 255); }
  return btoa(s);
}
function decDesc(str){
  const s = atob(str), f = new Float32Array(128);
  for (let i = 0; i < 128; i++){ let v = s.charCodeAt(i); if (v > 127) v -= 256; f[i] = v / 254; }
  return f;
}

/* =====================================================================
   طبقة قاعدة البيانات: نفس الواجهة لـ Firestore وللوضع المحلي
   filters = [[field, value], ...] (تساوي فقط)
   ===================================================================== */
const DEL = {__del:true};
const isDel = v => v && typeof v === 'object' && v.__del === true;
const TS = {__ts:true}; // وقت الخادم
const isTs = v => v && typeof v === 'object' && v.__ts === true;
const tsMillis = v => v == null ? null : typeof v === 'number' ? v : (v.toMillis ? v.toMillis() : null);
const isObj = v => v && typeof v === 'object' && !Array.isArray(v);
const clone = v => JSON.parse(JSON.stringify(v));

const hasNestedArr = (v, inArr) => Array.isArray(v) ? (inArr || v.some(x => hasNestedArr(x, true))) : (v && typeof v === 'object' && !(v instanceof Date) ? Object.values(v).some(x => hasNestedArr(x, false)) : false);
const LFS = { // محاكاة محلية
  d:{}, subs:[],
  load(){ this.d = LS.get('fa3_db', {}); },
  persist(){ LS.set('fa3_db', this.d); setTimeout(() => this.subs.slice().forEach(s => s.run()), 0); },
  col(c){ return this.d[c] || (this.d[c] = {}); },
  merge(a, b){ Object.entries(b).forEach(([k, v]) => { if (isDel(v)) delete a[k]; else if (isTs(v)) a[k] = Date.now(); else if (isObj(v) && isObj(a[k])) this.merge(a[k], v); else a[k] = clone(v); }); return a; },
  async get(c, id){ const x = this.col(c)[id]; return x ? Object.assign({id}, clone(x)) : null; },
  set(c, id, data, merge){
    if (hasNestedArr(data)) return {id, p:Promise.reject(new Error('Nested arrays are not supported (Firestore)'))};
    id = id || ('L' + Date.now() + Math.random().toString(36).slice(2, 6));
    const col = this.col(c);
    col[id] = merge && col[id] ? this.merge(col[id], data) : this.merge({}, data);
    this.persist(); return {id, p:Promise.resolve()};
  },
  update(c, id, patch){
    const doc = this.col(c)[id]; if (!doc) return {p:Promise.reject(new Error('المستند غير موجود'))};
    Object.entries(patch).forEach(([k, v]) => {
      const path = k.split('.'); let o = doc;
      for (let i = 0; i < path.length - 1; i++){ if (!isObj(o[path[i]])) o[path[i]] = {}; o = o[path[i]]; }
      const last = path[path.length - 1]; if (isDel(v)) delete o[last]; else if (isTs(v)) o[last] = Date.now(); else o[last] = clone(v);
    });
    this.persist(); return {p:Promise.resolve()};
  },
  del(c, id){ delete this.col(c)[id]; this.persist(); return {p:Promise.resolve()}; },
  async query(c, f=[]){ return Object.entries(this.col(c)).filter(([, x]) => f.every(([k, v]) => x[k] === v)).map(([id, x]) => Object.assign({id}, clone(x))); },
  async queryAfter(c, field, ms){ return (await this.query(c)).filter(x => (tsMillis(x[field]) || 0) > ms); },
  listen(c, f, cb){ const s = {run:() => this.query(c, f).then(l => cb(l))}; this.subs.push(s); s.run(); return () => { this.subs = this.subs.filter(x => x !== s); }; },
  listenDoc(c, id, cb){ const s = {run:() => this.get(c, id).then(cb)}; this.subs.push(s); s.run(); return () => { this.subs = this.subs.filter(x => x !== s); }; }
};

let db = null, auth = null;
const FS = { // Firestore
  conv(v){ if (isDel(v)) return firebase.firestore.FieldValue.delete(); if (isTs(v)) return firebase.firestore.FieldValue.serverTimestamp(); if (isObj(v)){ const o = {}; Object.entries(v).forEach(([k, x]) => o[k] = this.conv(x)); return o; } return v; },
  q(c, f=[]){ let q = db.collection(c); f.forEach(([k, v]) => q = q.where(k, '==', v)); return q; },
  async get(c, id){ const d = await db.collection(c).doc(id).get(); return d.exists ? Object.assign({id:d.id}, d.data()) : null; },
  set(c, id, data, merge){ const ref = id ? db.collection(c).doc(id) : db.collection(c).doc(); let p; try{ p = ref.set(this.conv(data), {merge:!!merge}); }catch(e){ p = Promise.reject(e); } return {id:ref.id, p}; },
  update(c, id, patch){ let p; try{ p = db.collection(c).doc(id).update(this.conv(patch)); }catch(e){ p = Promise.reject(e); } return {p}; },
  del(c, id){ return {p:db.collection(c).doc(id).delete()}; },
  async query(c, f){ return (await this.q(c, f).get()).docs.map(d => Object.assign({id:d.id}, d.data())); },
  async queryAfter(c, field, ms){ return (await db.collection(c).where(field, '>', firebase.firestore.Timestamp.fromMillis(ms)).get()).docs.map(d => Object.assign({id:d.id}, d.data())); },
  listen(c, f, cb, err){
    return this.q(c, f).onSnapshot({includeMetadataChanges:true},
      s => cb(s.docs.map(d => Object.assign({id:d.id, _pending:d.metadata.hasPendingWrites}, d.data()))), err || onErr);
  },
  listenDoc(c, id, cb, err){ return db.collection(c).doc(id).onSnapshot(d => cb(d.exists ? Object.assign({id:d.id}, d.data()) : null), err || onErr); }
};
let DB = LFS;

/* =====================================================================
   حالة التطبيق والصلاحيات
   ===================================================================== */
const App = {mode:'local', user:null, org:null, dept:null, packs:{}, sessions:[], users:[], pending:0, subs:{}, term:null};
const role = () => App.user ? App.user.role : null;
const is = (...r) => r.includes(role());
const canManageStudents = () => is('super','dean','head','registrar');
function unsub(key){ if (App.subs[key]){ try{ App.subs[key](); }catch(e){} delete App.subs[key]; } }
function unsubAll(){ Object.keys(App.subs).forEach(unsub); }
const deptList = () => Object.entries((App.org || {}).depts || {}).map(([id, d]) => Object.assign({id}, d));
const collegeName = id => (((App.org || {}).colleges || {})[id] || {}).name || id || '';
const deptName = id => (((App.org || {}).depts || {})[id] || {}).name || id || '';
function allowedDepts(){
  const u = App.user, all = deptList();
  if (!u) return [];
  if (u.role === 'super' || u.role === 'qa') return all;
  if (u.role === 'dean') return all.filter(d => d.collegeId === u.collegeId);
  const ids = u.deptIds || []; return all.filter(d => ids.includes(d.id));
}
const packId = (deptId, stage, shift) => `${deptId}~${stage}~${shift}`;

/* ============ الواجهة العامة ============ */
$$('nav button').forEach(b => b.onclick = () => showTab(b.dataset.tab));
function showTab(id){
  if (id === 'tGrades' && App.user && App.org){ loadGradeSheets(); }
  if (id === 'tExcuses' && App.user && App.org){ loadExcuseList(); }
  if (id === 'tSchedule' && App.user && App.org){ renderSchedule(); renderMissing(); }
  if (id === 'tQA' && App.user && App.org){ renderQAOptions(); }
  if (id === 'tRecords' && App.user && App.org){ renderPolicy(); renderWarnings(); }
  const nb = document.querySelector(`nav button[data-tab="${id}"]`);
  $('#pageTitle').textContent = nb ? nb.textContent.trim() : '';
  $('#appView').classList.remove('sb-open');
  $$('nav button').forEach(x => x.classList.toggle('active', x.dataset.tab === id));
  $$('.tab').forEach(x => x.classList.toggle('active', x.id === id));
}
function applyRole(){
  const r = role(); let first = null;
  $$('nav button').forEach(b => {
    let ok = TAB_ROLES[b.dataset.tab].includes(r);
    b.classList.toggle('hidden', !ok); if (ok && !first) first = b.dataset.tab;
  });
  const cur = $$('nav button').find(b => b.classList.contains('active') && !b.classList.contains('hidden'));
  showTab(cur ? cur.dataset.tab : first);
  $('#userBox').textContent = App.user.name || App.user.email || ''; $('#roleBox').textContent = ROLES[r];
  $('#sbAv').textContent = (App.user.name || App.user.email || '?').replace(/^(أ\.م\.د\.?|أ\.د\.?|م\.م\.?|م\.د\.?|د\.|م\.|أ\.)\s*/, '').trim().charAt(0) || '?';
  $('#sbVer').innerHTML = `الإصدار ${APP_VERSION} <span class="dev">تطوير: د. محمد يوسف</span>`;
  $('#policyCard').classList.toggle('hidden', !is('super','dean','head','committee','qa'));
  $$('#policyCard input, #pSave').forEach(x => x.disabled = !is('super','dean','head'));
  $('#promoCard').classList.toggle('hidden', !is('super','dean','head'));
  $('#schFormCard').classList.toggle('hidden', !is('super','dean','head'));
  $('#todayCard').classList.toggle('hidden', !is('super','dean','head','instructor'));
  $('#logoutBtn').classList.toggle('hidden', App.mode === 'local');
  $('#localBanner').classList.toggle('hidden', App.mode !== 'local');
  $('#backupCard').classList.toggle('hidden', !canManageStudents());
  $('#clearAllBtn').classList.toggle('hidden', App.mode !== 'local');
  $('#overviewCard').classList.toggle('hidden', !is('super','dean'));
  $('#aboutText').innerHTML = `الإصدار ${APP_VERSION} — وضع التشغيل: ${App.mode === 'local' ? 'محلي تجريبي' : 'Firebase (مشروع ' + esc((window.FIREBASE_CONFIG || {}).projectId) + ')'}.<br>
    التعرف على الوجه يجري بالكامل داخل هذا الجهاز، ويعمل التطبيق دون إنترنت بعد أول فتح.`;
}
function showView(id){ ['loginView','studentView','appView'].forEach(v => $('#' + v).classList.toggle('hidden', v !== id)); }
function showApp(){ showView('appView'); }
function showLogin(msg){
  showView('loginView');
  if (msg !== undefined) $('#loginErr').textContent = msg;
  $('#loginBtn').disabled = false;
}
function updateConn(){
  const el = $('#conn');
  if (App.mode === 'local'){ el.textContent = 'وضع محلي'; el.className = 'pill warn'; return; }
  if (!navigator.onLine){ el.textContent = 'غير متصل — يعمل على الجهاز' + (App.pending ? ` (${App.pending} بانتظار الرفع)` : ''); el.className = 'pill warn'; return; }
  if (App.pending){ el.textContent = `جارٍ رفع ${App.pending} محاضرة...`; el.className = 'pill warn'; return; }
  el.textContent = 'متصل ✓'; el.className = 'pill ok';
}
window.addEventListener('online', updateConn); window.addEventListener('offline', updateConn);
$('#menuBtn').onclick = () => $('#appView').classList.toggle('sb-open');
$('#sbShade').onclick = () => $('#appView').classList.remove('sb-open');

/* ============ نطاق العمل (الكلية / القسم) ============ */
function renderScope(){
  const depts = allowedDepts();
  $('#noDeptBanner').classList.toggle('hidden', depts.length > 0 || is('super'));
  const colIds = [...new Set(depts.map(d => d.collegeId))];
  const saved = LS.get('fa_scope', {});
  let col = $('#scopeCollege').value || saved.collegeId;
  if (!colIds.includes(col)) col = colIds[0] || '';
  $('#scopeCollege').innerHTML = colIds.map(c => `<option value="${esc(c)}">${esc(collegeName(c))}</option>`).join('') || '<option value="">—</option>';
  $('#scopeCollege').value = col;
  const ds = depts.filter(d => d.collegeId === col);
  let dep = (App.dept && App.dept.id) || saved.deptId;
  if (!ds.some(d => d.id === dep)) dep = ds[0] ? ds[0].id : '';
  $('#scopeDept').innerHTML = ds.map(d => `<option value="${esc(d.id)}">${esc(d.name)}</option>`).join('') || '<option value="">—</option>';
  $('#scopeDept').value = dep;
  $('#termBox').textContent = App.org ? 'الفصل الحالي: \u2066' + App.org.term + '\u2069' + (is('super') ? ' ⇄' : '') : ''; $('#termBox').classList.toggle('clickable', is('super')); $('#termBox').title = is('super') ? 'اضغط للتبديل بين الفصل الأول والثاني' : '';
  setDept(dep);
}
$('#scopeCollege').onchange = () => {
  if (sess){ toast('أنهِ المحاضرة الجارية أولاً', 'err'); $('#scopeCollege').value = App.dept.collegeId; return; }
  App.dept = null; renderScope();
};
$('#scopeDept').onchange = () => setDept($('#scopeDept').value);
function setDept(id){
  if (sess){
    if (App.dept && App.dept.id !== id){ toast('أنهِ المحاضرة الجارية أولاً', 'err'); $('#scopeDept').value = App.dept.id; }
    return;
  }
  const d = deptList().find(x => x.id === id) || null;
  const changed = (App.dept && App.dept.id) !== (d && d.id) || App.term !== (App.org && App.org.term) ||
                  JSON.stringify(App.dept) !== JSON.stringify(d);
  App.dept = d;
  if (d) LS.set('fa_scope', {collegeId:d.collegeId, deptId:d.id});
  $$('.deptName').forEach(e => e.textContent = d ? d.name : '—');
  fillDeptOptions();
  if (changed){ App.term = App.org && App.org.term; subPacks(); subSessions(); subCourses(); subSchedule(); loadApprovedExcuses(); G = null; gSheets = [];
    $('#gDistCard') && $('#gDistCard').classList.add('hidden'); $('#gSheetCard') && $('#gSheetCard').classList.add('hidden');
    if ($('#tGrades') && $('#tGrades').classList.contains('active')) loadGradeSheets(); else if (App.org) renderGradesTab(); }
}
// دراسة المستخدم: صباحي / مسائي / كلاهما (فارغ = كلاهما)
const myShifts = () => (App.user && (App.user.shifts || []).length) ? App.user.shifts : null;
const shiftOK = sh => { const m = myShifts(); return !m || m.includes(sh); };
function fillDeptOptions(){
  const d0 = App.dept || {stages:[], shifts:[], sections:[]}, d = Object.assign({}, d0, {shifts:(d0.shifts || []).filter(shiftOK)});
  const opts = (arr, all) => (all ? `<option value="">${all}</option>` : '') + (arr || []).map(x => `<option>${esc(x)}</option>`).join('');
  $$('select.optStage').forEach(s => { const v = s.value; s.innerHTML = opts(d.stages); if ((d.stages || []).includes(v)) s.value = v; });
  $$('select.optShift').forEach(s => { const v = s.value; s.innerHTML = opts(d.shifts); if ((d.shifts || []).includes(v)) s.value = v; });
  $$('select.optSection').forEach(s => { const v = s.value; s.innerHTML = opts(d.sections, s.dataset.all); if ((d.sections || []).includes(v)) s.value = v; });
  $('#fStage').innerHTML = opts(d.stages, 'كل المراحل'); $('#fShift').innerHTML = opts(d.shifts, 'كل الدراسات');
  renderAsgSelect();
  fillPromoTo();
  $('#allowedVals').textContent = `المراحل: ${(d.stages || []).join('، ')} — الدراسة: ${(d.shifts || []).join('، ')} — الشعب: ${(d.sections || []).join('، ')}`;
}

/* ============ الاشتراكات ============ */
function subPacks(){
  unsub('packs'); App.packs = {};
  const d = App.dept;
  if (d && canManageStudents()){
    const f = is('dean') ? [['collegeId', d.collegeId], ['deptId', d.id]] : [['deptId', d.id]];
    App.subs.packs = DB.listen('att_packs', f, list => { App.packs = Object.fromEntries(list.map(p => [p.id, p])); renderStudents(); });
  }
  renderStudents();
}
function subCourses(){
  unsub('courses'); App.courses = null;
  const d = App.dept; if (!d){ renderCourses(); return; }
  App.subs.courses = DB.listenDoc('att_courses', d.id, doc => { App.courses = doc; renderCourses(); renderAsgCourseList(); renderPolicy(); renderWarnings(); }, e => { console.warn('courses', e); renderCourses(); });
  renderCourses();
}
function subSessions(){
  unsub('sessions'); App.sessions = []; App.pending = 0;
  const u = App.user, d = App.dept, T = App.org && App.org.term;
  let f = null;
  if (u.role === 'instructor') f = [['instructorUid', u.uid], ['term', T]];
  else if (u.role === 'registrar' || !d) f = null; // qa/super/head/committee: كل محاضرات القسم
  else if (u.role === 'dean') f = [['collegeId', d.collegeId], ['deptId', d.id], ['term', T]];
  else f = [['deptId', d.id], ['term', T]];
  if (f) App.subs.sessions = DB.listen('att_sessions', f, list => {
    App.sessions = list.filter(x => shiftOK(x.shift)); App.pending = list.filter(x => x._pending).length;
    renderRecords(); renderCourseList(); updateConn(); scheduleReconcile(); renderWarnings(); renderToday();
  });
  renderRecords(); renderCourseList(); updateConn();
}
function subUsers(){
  unsub('users'); App.users = [];
  if (!is('super','dean','head')) return;
  const f = is('super') ? [] : [['collegeId', App.user.collegeId || '']];
  App.subs.users = DB.listen('att_users', f, list => { App.users = list; renderUsers(); });
}
function subOrg(){
  unsub('org');
  App.subs.org = DB.listenDoc('att_org', 'main', doc => {
    if (!doc){
      if (is('super')){ bg(DB.set('att_org', 'main', DEFAULT_ORG).p); return; }
      $('#noDeptBanner').textContent = 'لم يُعدّ الهيكل التنظيمي بعد. راجع مدير النظام.'; $('#noDeptBanner').classList.remove('hidden');
      return;
    }
    App.org = doc; renderScope(); renderOrg(); renderOverviewOptions(); renderQAOptions();
  });
}

/* ============ إضافة حضور QR المتأخر (المرفوع من هواتف كانت دون اتصال) ============ */
let reconcileTimer = null, reconciling = false;
function scheduleReconcile(){ clearTimeout(reconcileTimer); reconcileTimer = setTimeout(reconcileQR, 3000); }
window.addEventListener('online', () => scheduleReconcile());
setInterval(() => scheduleReconcile(), 5 * 60000);
async function reconcileQR(){
  if (reconciling || !App.user || !navigator.onLine && App.mode !== 'local') return;
  reconciling = true;
  try{
    for (const s of App.sessions){
      if (!s.liveId || !s.qrSecret || s._pending || s.liveMode === 'phoneface') continue;
      if (Date.now() > Date.parse(s.acceptUntil || 0) + 3600000) continue;
      if (!(s.instructorUid === App.user.uid || is('super','dean','head'))) continue;
      const lsKey = 'fa_rc_' + s.id, since = LS.get(lsKey, 0);
      let list;
      try{ list = await DB.queryAfter(`att_live/${s.liveId}/c`, 'at', since); }catch(e){ console.warn(e); continue; }
      if (!list.length) continue;
      const q = {secret:s.qrSecret, codes:new Map(), offset:0, firstSlot:s.qrFrom, slotMs:s.qrSlotMs || SLOT_MS, face:!!s.qrFace};
      const spot = new Set(s.spotAbsent || []);
      const present = new Set((s.present || []).map(p => p.id)), devices = {};
      (s.present || []).forEach(p => { if (p.device) devices[p.device] = p.id; });
      const roster = new Set([...(s.absentees || []), ...present]), add = [];
      let maxAt = since;
      for (const c of list.sort((a, b) => (tsMillis(a.at) || 0) - (tsMillis(b.at) || 0))){
        maxAt = Math.max(maxAt, tsMillis(c.at) || 0);
        if (present.has(c.sid) || !roster.has(c.sid) || spot.has(c.sid)) continue;
        const v = await validateCheckin(q, c, null, s.qrTo);
        if (v.reason || faceReason(q, c)) continue;
        if (devices[c.deviceId] && devices[c.deviceId] !== c.sid) continue;
        devices[c.deviceId] = c.sid; present.add(c.sid);
        add.push({id:c.sid, method:'qr-off', time:new Date(+c.capturedAt).toLocaleTimeString('en-GB', {hour:'2-digit', minute:'2-digit'}), dist:null, device:c.deviceId});
      }
      if (add.length){
        const ids = new Set(add.map(a => a.id));
        await DB.update('att_sessions', s.id, {present:[...(s.present || []), ...add], absentees:(s.absentees || []).filter(x => !ids.has(x)),
          qrLate:(s.qrLate || 0) + add.length, updatedAt:nowISO()}).p;
        toast(`أُضيف ${add.length} طالب (QR دون اتصال) إلى محاضرة ${s.course} — ${s.date}`, 'ok');
      }
      LS.set(lsKey, maxAt);
    }
  }catch(e){ console.error(e); }
  reconciling = false;
}

/* ============ PWA ============ */
let deferredInstall = null;
window.addEventListener('beforeinstallprompt', e => { e.preventDefault(); deferredInstall = e; $('#installBtn').classList.remove('hidden'); });
$('#installBtn').onclick = async () => {
  if (!deferredInstall) return; deferredInstall.prompt();
  try{ await deferredInstall.userChoice; }catch(e){}
  deferredInstall = null; $('#installBtn').classList.add('hidden');
};
window.addEventListener('appinstalled', () => { $('#installBtn').classList.add('hidden'); toast('تم تثبيت التطبيق ✓', 'ok'); });
function registerSW(){
  if (!('serviceWorker' in navigator)) return;
  navigator.serviceWorker.register('./sw.js').then(reg => {
    reg.addEventListener('updatefound', () => {
      const w = reg.installing;
      w && w.addEventListener('statechange', () => { if (w.state === 'installed' && navigator.serviceWorker.controller) toast('يتوفر تحديث للتطبيق — أعد فتحه لتطبيقه', 'ok'); });
    });
  }).catch(e => console.warn('SW', e));
}

/* ============ نماذج التعرف والكاميرا ============ */
let modelsReady = false, modelsLoading = false;
function setModelStatus(t, c=''){ const el = $('#modelStatus'); el.textContent = t; el.className = 'pill ' + c; }
async function loadModels(){
  if (typeof faceapi === 'undefined'){ setModelStatus('مكتبة التعرف غير محمّلة — افتح التطبيق مع إنترنت مرة واحدة', 'err'); return; }
  if (!window.isSecureContext) toast('يجب فتح التطبيق عبر https حتى تعمل الكاميرا', 'err');
  setModelStatus('جارٍ تحميل نماذج الوجه...'); modelsLoading = true;
  try{
    if (faceapi.tf){ try{ await faceapi.tf.setBackend('webgl'); }catch(e){} await faceapi.tf.ready(); }
    await Promise.all([
      faceapi.nets.ssdMobilenetv1.loadFromUri(MODEL_URL),
      faceapi.nets.faceLandmark68Net.loadFromUri(MODEL_URL),
      faceapi.nets.faceRecognitionNet.loadFromUri(MODEL_URL)
    ]);
    modelsReady = true; setModelStatus('نماذج الوجه جاهزة ✓', 'ok');
  }catch(e){ console.error(e); setModelStatus('فشل تحميل نماذج الوجه — يلزم إنترنت لأول مرة', 'err'); }
}
async function startCamera(video){
  const s = Settings.get();
  const v = s.cameraId ? {deviceId:{exact:s.cameraId}, width:{ideal:640}, height:{ideal:480}} : {facingMode:'user', width:{ideal:640}, height:{ideal:480}};
  const stream = await navigator.mediaDevices.getUserMedia({audio:false, video:v});
  video.srcObject = stream; await video.play(); return stream;
}
function stopCamera(video){ const s = video.srcObject; if (s){ s.getTracks().forEach(t => t.stop()); video.srcObject = null; } }
const detOpts = () => new faceapi.SsdMobilenetv1Options({minConfidence:0.5, maxResults:5});
const boxArea = r => r.detection.box.width * r.detection.box.height;
async function detectFaces(input){
  const res = await faceapi.detectAllFaces(input, detOpts()).withFaceLandmarks().withFaceDescriptors();
  return res.sort((a, b) => boxArea(b) - boxArea(a));
}
function drawBoxes(canvas, video, faces, color){
  canvas.width = video.videoWidth; canvas.height = video.videoHeight;
  const ctx = canvas.getContext('2d'); ctx.clearRect(0, 0, canvas.width, canvas.height); ctx.lineWidth = 4;
  faces.forEach((f, i) => { const b = f.detection.box; ctx.strokeStyle = i === 0 ? color : '#999'; ctx.strokeRect(b.x, b.y, b.width, b.height); });
}
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
function eyeAR(p){ const e = i => (dist(p[i+1], p[i+5]) + dist(p[i+2], p[i+4])) / (2 * dist(p[i], p[i+3])); return (e(36) + e(42)) / 2; }
function yawRatio(p){ const l = p[36], r = p[45], n = p[30]; return (n.x - l.x) / (r.x - l.x); }
function buildMatcher(prints, threshold){ // prints: {id: Float32Array[]}
  const labeled = Object.entries(prints).filter(([, s]) => s && s.length).map(([id, s]) => new faceapi.LabeledFaceDescriptors(id, s));
  return labeled.length ? new faceapi.FaceMatcher(labeled, threshold) : null;
}
let audioCtx = null;
function beep(){
  try{
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    const o = audioCtx.createOscillator(), g = audioCtx.createGain();
    o.frequency.value = 880; g.gain.value = 0.12; o.connect(g); g.connect(audioCtx.destination);
    o.start(); o.stop(audioCtx.currentTime + 0.18);
  }catch(e){}
}

/* =====================================================================
   الطلبة والبصمات (لكل قسم)
   ===================================================================== */
function deptStudents(){
  const out = [];
  Object.values(App.packs).forEach(p => Object.entries(p.students || {}).forEach(([sid, s]) =>
    out.push({id:sid, name:s.n, section:s.s, stage:p.stage, shift:p.shift, prints:s.p || [], e:s.e || '', u:s.u || '', self:!!s.self, th:s.th || '', packId:p.id})));
  return out.sort((a, b) => a.id.localeCompare(b.id, 'en', {numeric:true}));
}
function addStudents(rows){
  const d = App.dept; if (!d) return {added:0, dup:0, bad:0};
  const exist = new Set(deptStudents().map(s => s.id)), groups = {}; let added = 0, dup = 0, bad = 0;
  rows.forEach(r => {
    const id = cleanId(r.id), name = String(r.name || '').trim();
    const stage = r.stage || d.stages[0], shift = r.shift || d.shifts[0], section = r.section || (d.sections || [])[0] || '';
    if (!id || !name){ return; }
    if (!d.stages.includes(stage) || !d.shifts.includes(shift) || ((d.sections || []).length && !d.sections.includes(section))){ bad++; return; }
    if (exist.has(id)){ dup++; return; } exist.add(id);
    const pid = packId(d.id, stage, shift);
    (groups[pid] = groups[pid] || {stage, shift, students:{}}).students[id] = {n:name, s:section};
    added++;
  });
  Object.entries(groups).forEach(([pid, g]) => bg(DB.set('att_packs', pid,
    {collegeId:d.collegeId, deptId:d.id, stage:g.stage, shift:g.shift, updatedAt:nowISO(), students:g.students}, true).p));
  return {added, dup, bad};
}
$('#addStudentBtn').onclick = () => {
  if (!App.dept) return toast('اختر القسم أولاً', 'err');
  const row = {id:cleanId($('#sId').value), name:$('#sName').value.trim(), email:$('#sEmail').value.trim().toLowerCase(), stage:$('#sStage').value, shift:$('#sShift').value, section:$('#sSection').value};
  if (row.email){
    if (!row.id || !row.name) return toast('أدخل الرقم الجامعي والاسم', 'err');
    $('#sId').value = $('#sName').value = $('#sEmail').value = '';
    openImport([row]); validateImport(); renderImport(); return;
  }
  const r = addStudents([row]);
  if (r.added){ toast('تمت الإضافة', 'ok'); $('#sId').value = ''; $('#sName').value = ''; $('#sId').focus(); }
  else toast(r.dup ? 'الرقم الجامعي موجود مسبقاً في القسم' : 'أدخل الرقم الجامعي والاسم', 'err');
};
$('#toggleBulk').onclick = () => $('#bulkBox').classList.toggle('hidden');
$('#bulkAddBtn').onclick = () => {
  if (!App.dept) return toast('اختر القسم أولاً', 'err');
  const rows = $('#bulkText').value.split(/\r?\n/).map(l => l.split(/\t|,|،/).map(x => x.trim())).filter(r => r.length >= 2 && r[0]);
  const r = addStudents(rows.map(x => ({id:x[0], name:x[1], stage:x[2], shift:x[3], section:x[4]})));
  toast(`تمت إضافة ${r.added} طالب` + (r.dup ? ` — ${r.dup} مكرر` : '') + (r.bad ? ` — ${r.bad} بقيم مرحلة/دراسة/شعبة غير صحيحة` : ''), r.added ? 'ok' : 'err');
  if (r.added && !r.bad) $('#bulkText').value = '';
};
['#fStage','#fShift','#fPrint','#fSearch'].forEach(s => $(s).oninput = renderStudents);
// كشف البصمات المتشابهة داخل القسم (طالب سجّل وجه زميله في حسابه مثلاً) — يقارن متوسط بصمة كل طالب
const DUP_MAX = 0.42;
let dupCache = {key:'', map:{}};
function dupMap(all){
  const withP = all.filter(s => s.prints.length), key = withP.map(s => s.id + ':' + s.prints[0].slice(0, 12)).join('|');
  if (dupCache.key === key) return dupCache.map;
  const means = withP.map(s => { const ds = s.prints.map(decDesc), m = new Float32Array(128); ds.forEach(d => { for (let i = 0; i < 128; i++) m[i] += d[i] / ds.length; }); return m; });
  const map = {};
  for (let i = 0; i < withP.length; i++) for (let j = i + 1; j < withP.length; j++){
    let d = 0; const a = means[i], b = means[j]; for (let k = 0; k < 128; k++){ const x = a[k] - b[k]; d += x * x; } d = Math.sqrt(d);
    if (d < DUP_MAX){ (map[withP[i].id] = map[withP[i].id] || []).push(withP[j]); (map[withP[j].id] = map[withP[j].id] || []).push(withP[i]); }
  }
  dupCache = {key, map}; return map;
}
function filteredStudents(){
  const st = $('#fStage').value, sh = $('#fShift').value, fp = $('#fPrint').value, q = $('#fSearch').value.trim();
  const all = deptStudents(), dups = fp === 'dup' ? dupMap(all) : null;
  return all.filter(s => shiftOK(s.shift) && (!st || s.stage === st) && (!sh || s.shift === sh) &&
    (!fp || (fp === 'yes' && s.prints.length > 0) || (fp === 'no' && !s.prints.length) || (fp === 'self' && s.self && s.prints.length) || (fp === 'dup' && dups[s.id])) &&
    (!q || s.name.includes(q) || s.id.includes(q)));
}
function accountCell(s, key){
  const h = isHeadHere();
  if (s.u) return `<span class="badge b-face">مفعّل</span> <span class="note" dir="ltr">${esc(s.e)}</span> ${h ? `<button class="btn sm light" data-reissue="${key}" title="حساب جديد بكلمة مرور جديدة (رئيس القسم)">🔑 كلمة مرور جديدة</button>` : ''} <button class="btn sm light" data-unbind="${key}" title="عند تغيير الطالب هاتفه">📱 فك ربط الهاتف</button>`;
  if (s.e) return `<span class="badge b-man">لم يُنشأ</span> <span class="note" dir="ltr">${esc(s.e)}</span>${h ? ` <button class="btn sm light" data-reissue="${key}">➕ إنشاء حساب</button>` : ''}`;
  return h ? `<button class="btn sm light" data-reissue="${key}">➕ إنشاء حساب</button>` : '<span class="note">—</span>';
}
function renderStudents(){
  if (!canManageStudents()) return;
  const all = deptStudents(), list = filteredStudents(), dups = dupMap(all), nd = Object.keys(dups).length;
  $('#studCount').textContent = `${all.length} طالب — ${all.filter(s => s.prints.length).length} لديهم بصمة` +
    ` — ${all.filter(s => s.u).length} لديهم حساب` + (nd ? ` — ⚠ ${nd} ببصمة متشابهة` : '');
  $('#studentsBody').innerHTML = list.slice(0, 800).map(s => {
    const n = s.prints.length, key = esc(s.packId + '|' + s.id);
    return `<tr><td>${isHeadHere() ? `<input type="checkbox" data-sel="${key}" ${selKeys.has(s.packId + '|' + s.id) ? 'checked' : ''} style="width:auto;margin-left:6px">` : ''}${esc(s.id)}</td><td>${esc(s.name)}</td><td>${esc(s.stage)}</td><td>${esc(s.shift)}</td><td>${esc(s.section)}</td>
    <td>${s.th ? `<img class="sf" src="${esc(s.th)}" data-zoom="1" alt=""> ` : ''}${n ? `<span class="badge b-face">مسجّلة (${n})</span>` : '<span class="badge b-abs">غير مسجّلة</span>'}${n && s.self ? ' <span class="badge b-qr" title="سجّلها الطالب من هاتفه">ذاتية</span>' : ''}
      ${dups[s.id] ? `<div><span class="badge b-dep" title="قد يكون وجه الشخص نفسه">⚠ تشبه: ${dups[s.id].map(x => esc(x.name)).join('، ')}</span></div>` : ''}</td>
    <td>${accountCell(s, key)}</td>
    <td class="row"><button class="btn sm" data-enroll="${key}">${n ? 'إعادة البصمة' : 'تسجيل البصمة'}</button>
    ${n ? `<button class="btn sm light" data-clear="${key}">حذف البصمة</button>` : ''}
    ${isHeadHere() ? `<button class="btn sm red" data-purge="${key}">🗑 حذف نهائي</button>` : ''}</td></tr>`;
  }).join('') || `<tr><td colspan="8" class="note">${App.dept ? 'لا يوجد طلبة' : 'اختر القسم'}</td></tr>`;
  renderSelBar();
}
/* ---- استيراد الطلبة من Excel وإنشاء حساباتهم ---- */
const HDR = {id:['الرقم الجامعي','الرقم','id','student id','رقم'], name:['الاسم','اسم الطالب','الاسم الرباعي','name'],
  email:['البريد الإلكتروني','البريد','الايميل','الإيميل','email','e-mail'], stage:['المرحلة','stage'], shift:['الدراسة','shift'], section:['الشعبة','section']};
const genPass = () => { const c = 'abcdefghjkmnpqrstuvwxyz23456789'; return Array.from(crypto.getRandomValues(new Uint8Array(8)), b => c[b % c.length]).join(''); };
const emailOk = e => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);
let imp = null; // {rows:[{id,name,email,stage,shift,section,pass,status,ok}], running}
function needXLSX(){ if (typeof XLSX === 'undefined'){ toast('مكتبة Excel غير محمّلة — افتح التطبيق مع إنترنت', 'err'); return false; } return true; }
// قالب Excel يملؤه رئيس القسم أو موظف التسجيل: ورقة للبيانات + ورقة تعليمات + ورقة بالقيم المسموحة للقسم
const stuDomain = () => (localStorage.getItem('att_stuDomain') || 'stu.alsiraj.edu.iq').replace(/^@/, '').trim();
$('#templateBtn').onclick = () => {
  if (!needXLSX()) return;
  if (!App.dept) return toast('اختر القسم أولاً', 'err');
  const d = App.dept, secs = d.sections || [], st = $('#fStage').value || d.stages[0], sh = $('#fShift').value || d.shifts[0];
  const data = [['الرقم الجامعي','الاسم الرباعي','البريد الإلكتروني (اختياري)','المرحلة','الدراسة','الشعبة']];
  for (let i = 0; i < 60; i++) data.push(['', '', '', st, sh, secs[0] || '']); // صفوف جاهزة بقيم القسم الافتراضية
  const ws = XLSX.utils.aoa_to_sheet(data);
  for (let r = 2; r <= 61; r++){ const c = ws['A' + r] = ws['A' + r] || {t:'s', v:''}; c.t = 's'; c.z = '@'; } // الرقم الجامعي نصاً كي لا تضيع الأصفار
  ws['!cols'] = [{wch:16},{wch:34},{wch:32},{wch:12},{wch:10},{wch:8}];
  const help = XLSX.utils.aoa_to_sheet([
    ['تعليمات تعبئة قالب الطلبة — ' + d.name],
    [],
    ['1', 'املأ ورقة "الطلبة": طالب واحد في كل صف. لا تغيّر عناوين الأعمدة ولا ترتيبها.'],
    ['2', 'الرقم الجامعي والاسم إلزاميان. الرقم الجامعي يجب ألا يتكرر.'],
    ['3', `البريد الإلكتروني اختياري: إن تُرك فارغاً يُنشأ تلقائياً بالشكل (الرقم الجامعي@${stuDomain()}) ويكون اسم دخول الطالب.`],
    ['4', 'المرحلة والدراسة والشعبة: اكتبها كما في ورقة "القيم المسموحة" تماماً. الصفوف مُعبّأة مسبقاً بقيم افتراضية يمكنك تغييرها.'],
    ['5', 'الصفوف التي لا تحوي رقماً ولا اسماً تُتجاهل تلقائياً.'],
    ['6', 'احفظ الملف، ثم من النظام: تبويب الطلبة ← "استيراد الطلبة من Excel" ← اختر الملف ← "إنشاء الحسابات".'],
    ['7', 'بعد الإنشاء نزّل ملف حسابات الطلبة (فيه كلمات المرور) ووزّعه. يدخل كل طالب ويسجّل بصمة وجهه بنفسه من هاتفه.'],
    [],
    ['مثال', '2025001 | أحمد محمد علي حسن | (فارغ) | ' + [st, sh, secs[0] || ''].join(' | ')]]);
  help['!cols'] = [{wch:6},{wch:110}];
  const n = Math.max(d.stages.length, d.shifts.length, secs.length);
  const allowed = XLSX.utils.aoa_to_sheet([['المرحلة','الدراسة','الشعبة'], ...Array.from({length:n}, (_, i) => [d.stages[i] || '', d.shifts[i] || '', secs[i] || ''])]);
  allowed['!cols'] = [{wch:14},{wch:12},{wch:10}];
  const wb = XLSX.utils.book_new(); wb.Workbook = {Views:[{RTL:true}]};
  XLSX.utils.book_append_sheet(wb, ws, 'الطلبة'); XLSX.utils.book_append_sheet(wb, help, 'التعليمات'); XLSX.utils.book_append_sheet(wb, allowed, 'القيم المسموحة');
  XLSX.writeFile(wb, `قالب_طلبة_${d.name}.xlsx`);
};
$('#syncPrintsBtn').onclick = async () => {
  const list = deptStudents().filter(s => s.u && s.prints.length);
  if (!list.length) return toast('لا يوجد طلبة لديهم حساب وبصمة وجه معاً', 'err');
  if (!(await confirmBox('مزامنة البصمات', `ستُنسخ بصمة الوجه إلى حساب ${list.length} طالب، ليتحقق هاتف كل طالب من وجهه عند مسح QR.`, 'مزامنة'))) return;
  list.forEach(s => bg(DB.update('att_stu', s.u, {p:s.prints}).p));
  toast('تمت المزامنة', 'ok');
};
$('#exportStudentsBtn').onclick = () => {
  if (!needXLSX() || !App.dept) return;
  const rows = filteredStudents().map(s => [s.id, s.name, s.e, s.stage, s.shift, s.section, s.prints.length ? 'نعم' : 'لا', s.u ? 'نعم' : 'لا']);
  const ws = XLSX.utils.aoa_to_sheet([['الرقم الجامعي','الاسم','البريد الإلكتروني','المرحلة','الدراسة','الشعبة','بصمة الوجه','حساب QR'], ...rows]);
  const wb = XLSX.utils.book_new(); wb.Workbook = {Views:[{RTL:true}]}; XLSX.utils.book_append_sheet(wb, ws, 'الطلبة');
  XLSX.writeFile(wb, `طلبة_${App.dept.id}_${today()}.xlsx`);
};
function openImport(rows){
  if (!App.dept) return toast('اختر القسم أولاً', 'err');
  imp = {rows:rows || [], running:false, done:false};
  $('#impStep1').classList.toggle('hidden', !!rows); $('#impFile').value = ''; $('#impDomain').value = stuDomain();
  $('#impExport').classList.add('hidden'); $('#impProgress').classList.add('hidden');
  fillDeptOptions(); renderImport(); $('#importModal').classList.add('show');
}
$('#importBtn').onclick = () => openImport(null);
$('#impClose').onclick = async () => {
  if (imp && imp.running) return toast('انتظر حتى ينتهي الإنشاء', 'err');
  if (imp && imp.done && !imp.exported && imp.rows.some(r => r.pass && r.ok) &&
      !(await confirmBox('لم تنزّل الملف', 'كلمات المرور لن تظهر مرة أخرى. هل تريد الإغلاق دون تنزيل ملف Excel؟', 'إغلاق'))) return;
  $('#importModal').classList.remove('show'); imp = null;
};
$('#impFile').onchange = async e => {
  const f = e.target.files[0]; if (!f || !needXLSX()) return;
  try{
    const wb = XLSX.read(await f.arrayBuffer(), {type:'array'});
    const aoa = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], {header:1, defval:'', raw:false});
    if (!aoa.length) throw 0;
    const head = aoa[0].map(h => String(h).trim().toLowerCase());
    const col = k => { let i = head.findIndex(h => HDR[k].some(x => h === x.toLowerCase())); if (i < 0) i = head.findIndex(h => HDR[k].some(x => h.startsWith(x.toLowerCase() + ' '))); return i; };
    const ix = {id:col('id'), name:col('name'), email:col('email'), stage:col('stage'), shift:col('shift'), section:col('section')};
    let body = aoa.slice(1);
    if (ix.name < 0){ ix.id = 0; ix.name = 1; ix.email = 2; ix.stage = 3; ix.shift = 4; ix.section = 5; body = head.some(h => emailOk(h)) ? aoa : aoa.slice(1); }
    const v = (r, k) => ix[k] >= 0 ? String(r[ix[k]] ?? '').trim() : '';
    const d = App.dept, norm = x => String(x).replace(/[أإآ]/g, 'ا').replace(/ة$/, 'ه').replace(/ى$/, 'ي').replace(/\s+/g, '').toLowerCase();
    const pick = (val, list) => (list || []).find(x => norm(x) === norm(val)) || val; // "الاولى" = "الأولى"
    const dom = ($('#impDomain').value.trim() || stuDomain()).replace(/^@/, ''); localStorage.setItem('att_stuDomain', dom);
    imp.rows = body.filter(r => v(r, 'id') || v(r, 'name')).map(r => {
      const id = cleanId(v(r, 'id')), em = v(r, 'email').toLowerCase();
      return {id, name:v(r, 'name').replace(/\s+/g, ' '), email:em || (id ? `${id.toLowerCase().replace(/[^a-z0-9._-]/g, '')}@${dom}` : ''), autoEmail:!em,
        stage:pick(v(r, 'stage') || $('#impStage').value, d.stages), shift:pick(v(r, 'shift') || $('#impShift').value, d.shifts), section:pick(v(r, 'section') || $('#impSection').value, d.sections)};
    });
    validateImport(); renderImport();
  }catch(err){ console.error(err); toast('تعذّرت قراءة الملف — تأكد أنه ملف Excel بالأعمدة المطلوبة', 'err'); }
};
function validateImport(){
  const d = App.dept, existing = Object.fromEntries(deptStudents().map(s => [s.id, s])), seenId = {}, seenEmail = {};
  deptStudents().forEach(s => { if (s.e) seenEmail[s.e] = s.id; });
  imp.rows.forEach(r => {
    r.ok = false; r.status = '';
    if (!r.id) r.status = 'الرقم الجامعي فارغ';
    else if (!r.name) r.status = 'الاسم فارغ';
    else if (!emailOk(r.email)) r.status = r.autoEmail ? 'الرقم الجامعي يجب أن يكون أرقاماً/حروفاً لاتينية لإنشاء البريد' : 'البريد غير صالح';
    else if (!d.stages.includes(r.stage) || !d.shifts.includes(r.shift) || ((d.sections || []).length && !d.sections.includes(r.section))) r.status = 'مرحلة/دراسة/شعبة غير معرّفة للقسم';
    else if (seenId[r.id]) r.status = 'رقم مكرر في الملف';
    else if (seenEmail[r.email] && seenEmail[r.email] !== r.id) r.status = 'البريد مستخدم لطالب آخر';
    else if (existing[r.id] && existing[r.id].u) r.status = 'لديه حساب مسبقاً';
    else {
      r.ok = true; r.status = existing[r.id] ? 'جاهز (موجود — سيُنشأ حسابه)' : 'جاهز';
      if (existing[r.id]){ const x = existing[r.id]; r.stage = x.stage; r.shift = x.shift; r.section = x.section; }
    }
    if (r.id) seenId[r.id] = true; if (r.email) seenEmail[r.email] = seenEmail[r.email] || r.id;
  });
}
function renderImport(){
  if (!imp) return;
  const ok = imp.rows.filter(r => r.ok).length, created = imp.rows.filter(r => r.created).length;
  $('#impSummary').textContent = imp.rows.length ? `${imp.rows.length} صف — ${ok} جاهز` + (created ? ` — ${created} حساب أُنشئ` : '') : 'اختر ملف Excel';
  $('#impBody').innerHTML = imp.rows.map((r, i) => `<tr><td>${i + 1}</td><td>${esc(r.id)}</td><td>${esc(r.name)}</td><td dir="ltr" style="text-align:right">${esc(r.email)}${r.autoEmail ? ' <small class="note">(تلقائي)</small>' : ''}</td>
    <td>${esc(r.stage)} / ${esc(r.shift)} / ${esc(r.section)}</td><td dir="ltr" style="font-family:monospace">${r.created ? esc(r.pass) : ''}</td>
    <td><span class="badge ${r.created ? 'b-face' : r.ok ? 'b-gray' : 'b-abs'}">${esc(r.status)}</span></td></tr>`).join('');
  $('#impRun').disabled = imp.running || imp.done || !ok;
  $('#impExport').classList.toggle('hidden', !imp.rows.some(r => r.created));
}
async function createStudentAccount(r){
  if (App.mode === 'local') return 'L' + Date.now() + Math.random().toString(36).slice(2, 6);
  const sec = firebase.apps.find(a => a.name === 'secondary') || firebase.initializeApp(window.FIREBASE_CONFIG, 'secondary');
  const cred = await sec.auth().createUserWithEmailAndPassword(r.email, r.pass);
  const uid = cred.user.uid; await sec.auth().signOut(); return uid;
}
$('#impRun').onclick = async () => {
  const d = App.dept, rows = imp.rows.filter(r => r.ok && !r.created);
  if (!rows.length) return;
  if (App.mode !== 'local' && !navigator.onLine) return toast('إنشاء الحسابات يحتاج اتصالاً بالإنترنت', 'err');
  imp.running = true; renderImport(); $('#impProgress').classList.remove('hidden');
  // ١) إضافة الطلبة الجدد إلى قوائم القسم
  const exist = new Set(deptStudents().map(s => s.id));
  addStudents(rows.filter(r => !exist.has(r.id)));
  let n = 0, stopped = false;
  for (const r of rows){
    $('#impProgress').textContent = `جارٍ الإنشاء ${++n} / ${rows.length}`;
    r.pass = genPass(); r.status = 'جارٍ...'; renderImport();
    try{
      const cr = await createWithFallback(r.email, r.pass), uid = cr.uid, pid = packId(d.id, r.stage, r.shift);
      if (cr.email !== r.email){ r.email = cr.email; r.altEmail = true; }
      await DB.set('att_stu', uid, {sid:r.id, name:r.name, email:r.email, deptId:d.id, collegeId:d.collegeId, stage:r.stage, shift:r.shift, section:r.section, createdAt:nowISO(), createdBy:App.user.uid}).p;
      bg(DB.set('att_packs', pid, {collegeId:d.collegeId, deptId:d.id, stage:r.stage, shift:r.shift, updatedAt:nowISO(),
        students:{[r.id]:{n:r.name, s:r.section, e:r.email, u:uid}}}, true).p);
      saveCred(uid, d, r.id, r.email, r.pass);
      r.created = true; r.status = r.altEmail ? 'تم ✓ (بريد بديل لأن القديم مستخدم)' : 'تم إنشاء الحساب ✓';
    }catch(e){
      console.error(e); r.pass = '';
      if (e.code === 'auth/too-many-requests' || e.code === 'auth/quota-exceeded'){ r.status = 'توقف: تجاوز حد Firebase'; stopped = true; }
      else r.status = e.code === 'auth/email-already-in-use' ? 'البريد له حساب مسبقاً في النظام' : fbErr(e);
    }
    renderImport();
    if (stopped) break;
    await new Promise(res => setTimeout(res, 250));
  }
  imp.running = false; imp.done = !stopped; $('#impProgress').textContent = stopped ? 'توقف' : 'انتهى';
  if (stopped){ imp.done = false; toast('أوقف Firebase الإنشاء مؤقتاً (حد ١٠٠ حساب في الساعة من نفس الشبكة). نزّل الملف الآن، ثم أكمل لاحقاً أو ارفع الحد من لوحة Firebase.', 'err'); }
  renderImport();
  if (imp.rows.some(r => r.created)) toast('نزّل ملف Excel الآن — كلمات المرور لن تظهر مرة أخرى. بعد التسليم يدخل كل طالب ويسجّل بصمة وجهه بنفسه.', 'ok');
};
$('#impExport').onclick = () => {
  if (!needXLSX()) return;
  const d = App.dept, link = location.origin + location.pathname.replace(/index\.html$/, '');
  const rows = imp.rows.filter(r => r.created).map(r => [r.id, r.name, r.email, r.pass, r.stage, r.shift, r.section]);
  const ws = XLSX.utils.aoa_to_sheet([['رابط النظام', link], ['التعليمات', 'يفتح الطالب الرابط في Chrome أو Safari، ويدخل بالبريد وكلمة المرور، ثم يسجّل بصمة وجهه بنفسه (مرة واحدة)، ويثبّت التطبيق.'], [],
    ['الرقم الجامعي','الاسم','البريد الإلكتروني (اسم الدخول)','كلمة المرور','المرحلة','الدراسة','الشعبة'], ...rows]);
  ws['!cols'] = [{wch:14},{wch:30},{wch:32},{wch:14},{wch:10},{wch:10},{wch:8}];
  const wb = XLSX.utils.book_new(); wb.Workbook = {Views:[{RTL:true}]}; XLSX.utils.book_append_sheet(wb, ws, 'حسابات الطلبة');
  XLSX.writeFile(wb, `حسابات_الطلبة_${d.id}_${today()}.xlsx`); imp.exported = true;
};
const findStudent = key => { const [pid, sid] = key.split('|'); return deptStudents().find(s => s.packId === pid && s.id === sid); };
$('#studentsBody').onclick = async e => {
  const b = e.target.closest('button'); if (!b) return;
  if (b.dataset.enroll) return openEnroll(findStudent(b.dataset.enroll));
  if (b.dataset.unbind){
    const st = findStudent(b.dataset.unbind); if (!st || !st.u) return;
    if (!(await confirmBox('فك ربط الهاتف', `سيُفك ربط حساب ${st.name} بهاتفه الحالي، فيستطيع الدخول من هاتف جديد (عند تغيير الهاتف أو مسح بياناته).`, 'فك الربط'))) return;
    try{
      const d = await DB.get('att_stu', st.u);
      if (d && d.boundDevice) bg(DB.del('att_devices', d.boundDevice).p);
      await DB.update('att_stu', st.u, {boundDevice:DEL, boundAt:DEL, updatedAt:nowISO()}).p;
      toast('تم فك ربط الهاتف — يدخل الطالب الآن من هاتفه الجديد', 'ok'); audit('فك ربط هاتف طالب', `${st.name} (${st.id})`);
    }catch(e){ toast('تعذّر: ' + fbErr(e), 'err'); }
  }
  if (b.dataset.reset){
    const st = findStudent(b.dataset.reset); if (!st || !st.e) return;
    if (App.mode === 'local') return toast('متاح بعد ربط Firebase', 'err');
    if (!(await confirmBox('تغيير كلمة مرور الطالب', `سيُرسل رابط تعيين كلمة مرور جديدة إلى ${st.e}.`, 'إرسال'))) return;
    try{ await auth.sendPasswordResetEmail(st.e); toast('أُرسل الرابط إلى بريد الطالب', 'ok'); }catch(e){ toast('تعذّر الإرسال: ' + fbErr(e), 'err'); }
  }
  if (b.dataset.clear && await confirmBox('حذف البصمة', 'سيتم حذف بصمة وجه هذا الطالب نهائياً.', 'حذف')){
    const s = findStudent(b.dataset.clear);
    bg(DB.update('att_packs', s.packId, {[`students.${s.id}.p`]:DEL, [`students.${s.id}.c`]:DEL, updatedAt:nowISO()}).p);
    if (s.u) bg(DB.update('att_stu', s.u, {p:DEL, pAt:DEL, pSelf:DEL, pThumb:DEL}).p); // يستطيع الطالب إعادة تسجيلها
    bg(DB.update('att_packs', s.packId, {[`students.${s.id}.self`]:DEL, [`students.${s.id}.th`]:DEL}).p);
    audit('حذف بصمة طالب', `${s.name} (${s.id})`);
  }
  if (b.dataset.purge){ const s = findStudent(b.dataset.purge); if (s) openAcct('purge', [s]); }
  if (b.dataset.reissue){ const s = findStudent(b.dataset.reissue); if (s) openAcct('reissue', [s]); }
};

/* ---- إدارة حسابات الطلبة: حذف نهائي وإعادة إنشاء الحساب بكلمة مرور جديدة (رئيس القسم حصراً) ---- */
const isHeadHere = () => is('head') && !!App.dept && (App.user.deptIds || []).includes(App.dept.id);
let selKeys = new Set(), ac = null;
const secApp = () => firebase.apps.find(a => a.name === 'secondary') || firebase.initializeApp(window.FIREBASE_CONFIG, 'secondary');
const autoEmailOf = sid => `${String(sid).toLowerCase().replace(/[^a-z0-9._-]/g, '')}@${stuDomain()}`;
const altEmail = (email, n) => { const [l, d] = email.split('@'); return `${l.replace(/\+r\d+$/, '')}+r${n}@${d}`; };
// إنشاء حساب؛ إن كان البريد مستخدماً (حساب قديم لم يُحذف) يُستخدم بريد بديل: name+r2@...
async function createWithFallback(email, pass){
  if (App.mode === 'local') return {uid:'L' + Date.now() + Math.random().toString(36).slice(2, 6), email};
  const sec = secApp(); let e = email;
  for (let n = 2; n <= 15; n++){
    try{ const cr = await sec.auth().createUserWithEmailAndPassword(e, pass); const uid = cr.user.uid; await sec.auth().signOut(); return {uid, email:e}; }
    catch(err){ if (err.code !== 'auth/email-already-in-use') throw err; e = altEmail(email, n); }
  }
  throw new Error('تعذّر إيجاد بريد متاح');
}
// حفظ كلمة المرور الأولية (يقرؤها رئيس القسم فقط) — تتيح لاحقاً حذف الحساب من Firebase نهائياً
const saveCred = (uid, d, sid, email, pw) => bg(DB.set('att_cred', uid, {sid, email, pw, deptId:d.id, collegeId:d.collegeId, at:nowISO(), by:App.user.uid}).p);
// حذف حساب الدخول نفسه من Firebase Authentication (ممكن إذا حُفظت كلمة مروره عند إنشائه)
async function tryDeleteAuth(uid, email){
  if (App.mode === 'local') return true;
  let c = null; try{ c = await DB.get('att_cred', uid); }catch(e){}
  if (!c || !c.pw) return false;
  const sec = secApp();
  try{ const cr = await sec.auth().signInWithEmailAndPassword(c.email || email, c.pw); await cr.user.delete(); return true; }
  catch(e){ console.warn('auth delete', e.code); try{ await sec.auth().signOut(); }catch(_){} return false; }
}
async function purgeStudent(s, d){
  let authDel = !s.u;
  if (s.u){
    authDel = await tryDeleteAuth(s.u, s.e);
    const st = await DB.get('att_stu', s.u).catch(() => null);
    if (st && st.boundDevice) await DB.del('att_devices', st.boundDevice).p.catch(() => {});
    if (st) await DB.del('att_stu', s.u).p;
    bg(DB.del('att_cred', s.u).p);
  }
  await DB.update('att_packs', s.packId, {[`students.${s.id}`]:DEL, updatedAt:nowISO()}).p;
  return {authDel};
}
// حذف كل سجلات الطلبة المحذوفين: الحضور، الدرجات، الأعذار وصورها، النتائج، الإشعارات
async function wipeRecords(sids, uids, d){
  const out = {sessions:0, grades:0, excuses:0, results:0, notifs:0}, f = [['deptId', d.id]];
  const q = c => DB.query(c, f).catch(e => { console.warn(c, e); return []; });
  const [sess, grades, exc, res, nts] = await Promise.all([q('att_sessions'), q('att_grades'), q('att_excuses'), q('att_results'), q('att_notif')]);
  for (const x of sess){
    const pr = (x.present || []).filter(p => !sids.has(p.id)), ab = (x.absentees || []).filter(id => !sids.has(id));
    if (pr.length !== (x.present || []).length || ab.length !== (x.absentees || []).length){ await DB.update('att_sessions', x.id, {present:pr, absentees:ab, updatedAt:nowISO()}).p; out.sessions++; }
  }
  for (const g of grades){
    const patch = {};
    ['marks','overrides','finals','finals2','totals','names'].forEach(k => Object.keys(g[k] || {}).forEach(id => { if (sids.has(id)) patch[`${k}.${id}`] = DEL; }));
    if (Object.keys(patch).length){ await DB.update('att_grades', g.id, patch).p; out.grades++; }
  }
  for (const x of exc.filter(x => sids.has(x.sid))){ await DB.del('att_excuses', x.id).p; bg(DB.del('att_excuse_img', x.id).p); out.excuses++; }
  for (const x of res.filter(x => sids.has(x.sid))){ await DB.del('att_results', x.id).p; out.results++; }
  for (const x of nts.filter(x => sids.has(x.sid) || uids.has(x.uid))){ bg(DB.del('att_notif', x.id).p); out.notifs++; }
  return out;
}
async function reissueStudent(s, d, resetFace){
  const old = s.u ? await DB.get('att_stu', s.u).catch(() => null) : null;
  const authDel = s.u ? await tryDeleteAuth(s.u, s.e) : true;
  const base = (s.e || (old && old.email) || autoEmailOf(s.id)).replace(/\+r\d+@/, '@');
  const pass = genPass(), {uid, email} = await createWithFallback(base, pass);
  const data = {sid:s.id, name:s.name, email, deptId:d.id, collegeId:d.collegeId, stage:s.stage, shift:s.shift, section:s.section || '', createdAt:nowISO(), createdBy:App.user.uid, reissuedAt:nowISO()};
  if (!resetFace && old && (old.p || []).length) Object.assign(data, {p:old.p}, old.pSelf ? {pSelf:true} : {}, old.pThumb ? {pThumb:old.pThumb} : {});
  await DB.set('att_stu', uid, data).p;
  if (s.u){
    if (old && old.boundDevice) bg(DB.del('att_devices', old.boundDevice).p);
    if (old) bg(DB.del('att_stu', s.u).p);
    bg(DB.del('att_cred', s.u).p);
  }
  const patch = {[`students.${s.id}.u`]:uid, [`students.${s.id}.e`]:email, updatedAt:nowISO()};
  if (resetFace) Object.assign(patch, {[`students.${s.id}.p`]:DEL, [`students.${s.id}.c`]:DEL, [`students.${s.id}.self`]:DEL, [`students.${s.id}.th`]:DEL});
  await DB.update('att_packs', s.packId, patch).p;
  saveCred(uid, d, s.id, email, pass);
  return {email, pass, authDel, changed:email !== base};
}
function openAcct(mode, list){
  if (!isHeadHere()) return toast('هذه العملية لرئيس القسم فقط', 'err');
  if (!list.length) return toast('حدّد طالباً واحداً على الأقل', 'err');
  if (App.mode !== 'local' && !navigator.onLine) return toast('هذه العملية تحتاج اتصالاً بالإنترنت', 'err');
  ac = {mode, rows:list.map(s => ({s, status:'', email:'', pass:''})), running:false, done:false};
  const purge = mode === 'purge';
  $('#acTitle').textContent = purge ? `🗑 حذف نهائي — ${list.length} طالب` : `🔁 إعادة إنشاء الحسابات بكلمات مرور جديدة — ${list.length} طالب`;
  $('#acDesc').innerHTML = purge
    ? 'سيُحذف كل ما يخص الطالب نهائياً: حسابه وبريده (اسم الدخول) وكلمة مروره، واسمه من قائمة القسم، وبصمة وجهه، وربط هاتفه، وإشعاراته. يمكنك تسجيله مرة ثانية لاحقاً باستيراده من Excel بالبريد نفسه.'
    : 'يُلغى حساب الطالب القديم وكلمة مروره، ويُنشأ له حساب جديد بكلمة مرور جديدة، ويُفك ربط هاتفه. بعد التنفيذ نزّل ملف Excel بالحسابات الجديدة ووزّعه.';
  $('#acFaceRow').classList.toggle('hidden', purge); $('#acFace').checked = false;
  $('#acConfirmRow').classList.toggle('hidden', !purge); $('#acConfirm').value = '';
  $('#acAllRow').classList.toggle('hidden', !purge); $('#acAll').checked = true; $('#acManual').classList.add('hidden');
  $('#acRun').textContent = purge ? '🗑 حذف نهائي' : '🔁 إنشاء الحسابات الجديدة'; $('#acRun').className = 'btn ' + (purge ? 'red' : 'green');
  $('#acProg').textContent = ''; renderAcct(); $('#acctModal').classList.add('show');
}
function renderAcct(){
  const purge = ac.mode === 'purge';
  $('#acHead').innerHTML = `<tr><th>الرقم</th><th>الاسم</th>${purge ? '' : '<th>اسم الدخول الجديد</th><th>كلمة المرور</th>'}<th>الحالة</th></tr>`;
  $('#acBody').innerHTML = ac.rows.map(r => `<tr><td>${esc(r.s.id)}</td><td>${esc(r.s.name)}</td>${purge ? '' : `<td dir="ltr" style="text-align:right">${esc(r.email)}</td><td dir="ltr" style="font-family:monospace">${esc(r.pass)}</td>`}
    <td><span class="badge ${r.ok ? 'b-face' : r.err ? 'b-abs' : 'b-gray'}">${esc(r.status || 'بانتظار التنفيذ')}</span></td></tr>`).join('');
  $('#acRun').classList.toggle('hidden', ac.done); $('#acRun').disabled = ac.running;
  $('#acExport').classList.toggle('hidden', purge || !ac.rows.some(r => r.ok));
  const man = (ac.manual || []);
  $('#acManual').classList.toggle('hidden', !man.length || App.mode === 'local');
  if (man.length){
    const pid = (window.FIREBASE_CONFIG || {}).projectId || '';
    $('#acManual').innerHTML = `<b>⚠ ${man.length} بريد أُنشئ قبل الإصدار 5.3 ولا يستطيع النظام حذفه من Firebase بنفسه.</b> هذه الحسابات معطّلة ولا تدخل النظام، لكن لحذف البريد نهائياً:
      افتح <a href="https://console.firebase.google.com/project/${esc(pid)}/authentication/users" target="_blank" rel="noopener">Firebase ← Authentication ← Users</a>، وابحث عن كل بريد، ثم ⋮ ← <b>Delete account</b>.
      <div dir="ltr" style="text-align:left;margin-top:6px;font-family:monospace;user-select:all;white-space:pre-wrap">${esc(man.join('\n'))}</div>
      <button class="btn sm light" id="acCopy" style="margin-top:6px">📋 نسخ القائمة</button>`;
    $('#acCopy').onclick = () => { navigator.clipboard && navigator.clipboard.writeText(man.join('\n')).then(() => toast('نُسخت ✓', 'ok')); };
  }
}
$('#acRun').onclick = async () => {
  const purge = ac.mode === 'purge', d = App.dept;
  if (purge && $('#acConfirm').value.trim() !== 'حذف') return toast('اكتب كلمة «حذف» للتأكيد', 'err');
  ac.running = true; renderAcct(); let n = 0, stopped = false, oldKept = 0; const gone = new Set(), goneU = new Set(), manual = [];
  for (const r of ac.rows){
    $('#acProg').textContent = `جارٍ التنفيذ ${++n} / ${ac.rows.length}`; r.status = 'جارٍ...'; renderAcct();
    try{
      if (purge){ const x = await purgeStudent(r.s, d); r.ok = true; gone.add(r.s.id); if (r.s.u) goneU.add(r.s.u);
        r.status = x.authDel ? 'حُذف نهائياً مع البريد ✓' : 'حُذف ✓ — البريد يُحذف يدوياً من Firebase'; if (!x.authDel){ oldKept++; manual.push(r.s.e); } }
      else { const x = await reissueStudent(r.s, d, $('#acFace').checked); Object.assign(r, {ok:true, email:x.email, pass:x.pass, status:x.changed ? 'حساب جديد ✓ (اسم دخول جديد)' : 'حساب جديد ✓'}); if (!x.authDel) oldKept++; }
      selKeys.delete(r.s.packId + '|' + r.s.id);
    }catch(e){
      console.error(e); r.err = true;
      if (e.code === 'auth/too-many-requests' || e.code === 'auth/quota-exceeded'){ r.status = 'توقف: تجاوز حد Firebase'; stopped = true; }
      else r.status = fbErr(e) || e.message;
    }
    renderAcct(); if (stopped) break;
    await new Promise(res => setTimeout(res, 250));
  }
  if (purge && gone.size && $('#acAll').checked){
    $('#acProg').textContent = '⏳ جارٍ حذف سجلات الحضور والدرجات والأعذار...';
    try{ const w = await wipeRecords(gone, goneU, d); ac.wiped = w; }catch(e){ console.error(e); toast('تعذّر حذف بعض السجلات: ' + fbErr(e), 'err'); }
  }
  ac.manual = manual.filter(Boolean);
  ac.running = false; ac.done = true;
  const ok = ac.rows.filter(r => r.ok).length;
  $('#acProg').textContent = `انتهى — ${ok} من ${ac.rows.length}` + (ac.wiped ? ` — حُذف الطالب من ${ac.wiped.sessions} محاضرة و${ac.wiped.grades} جدول درجات و${ac.wiped.excuses} عذر و${ac.wiped.results} نتيجة` : '');
  audit(purge ? 'حذف طلبة نهائياً' : 'إعادة إنشاء حسابات طلبة', ac.rows.filter(r => r.ok).map(r => `${r.s.name} (${r.s.id})`).join('، ').slice(0, 900));
  renderAcct();
  if (!purge && ok) toast('نزّل ملف Excel الآن — كلمات المرور الجديدة لن تظهر مرة أخرى', 'ok');
  if (oldKept && App.mode !== 'local' && !purge) toast(`${oldKept} حساب قديم أُنشئ قبل الإصدار 5.3 بقي معطّلاً في Firebase. احذفه يدوياً من Firebase ← Authentication إن أردت.`, 'ok');
  if (stopped) toast('أوقف Firebase الإنشاء مؤقتاً (حد ١٠٠ حساب في الساعة). نزّل الملف وأكمل البقية بعد ساعة.', 'err');
};
$('#acExport').onclick = () => {
  if (!needXLSX()) return;
  const d = App.dept, link = location.origin + location.pathname.replace(/index\.html$/, '');
  const rows = ac.rows.filter(r => r.ok).map(r => [r.s.id, r.s.name, r.email, r.pass, r.s.stage, r.s.shift, r.s.section]);
  const ws = XLSX.utils.aoa_to_sheet([['رابط النظام', link], ['التعليمات', 'حساب جديد: يدخل الطالب بالبريد وكلمة المرور الجديدين. الحساب القديم لم يعد يعمل.'], [],
    ['الرقم الجامعي','الاسم','البريد الإلكتروني (اسم الدخول)','كلمة المرور','المرحلة','الدراسة','الشعبة'], ...rows]);
  ws['!cols'] = [{wch:14},{wch:30},{wch:34},{wch:14},{wch:10},{wch:10},{wch:8}];
  const wb = XLSX.utils.book_new(); wb.Workbook = {Views:[{RTL:true}]}; XLSX.utils.book_append_sheet(wb, ws, 'الحسابات الجديدة');
  XLSX.writeFile(wb, `حسابات_جديدة_${d.id}_${today()}.xlsx`); ac.exported = true;
};
$('#acClose').onclick = async () => {
  if (ac && ac.running) return;
  if (ac && ac.mode === 'reissue' && ac.rows.some(r => r.ok) && !ac.exported && !(await confirmBox('لم تنزّل ملف الحسابات', 'كلمات المرور الجديدة لن تظهر مرة أخرى. إغلاق دون تنزيل؟', 'إغلاق'))) return;
  $('#acctModal').classList.remove('show'); ac = null; renderStudents();
};
// شريط التحديد الجماعي
function renderSelBar(){
  const h = isHeadHere(); $('#selBar').classList.toggle('hidden', !h); if (!h) return;
  $('#selCount').textContent = selKeys.size ? `محدّد: ${selKeys.size} طالب` : 'حدّد طلبة من الجدول (مربع الاختيار بجانب الرقم)';
  $('#selReissue').disabled = $('#selPurge').disabled = $('#selNone').disabled = !selKeys.size;
}
const selList = () => [...selKeys].map(findStudent).filter(Boolean);
$('#selAll').onclick = () => { filteredStudents().slice(0, 800).forEach(s => selKeys.add(s.packId + '|' + s.id)); renderStudents(); };
$('#selNone').onclick = () => { selKeys.clear(); renderStudents(); };
$('#selReissue').onclick = () => openAcct('reissue', selList());
$('#selPurge').onclick = () => openAcct('purge', selList());
$('#studentsBody').addEventListener('change', e => { const c = e.target.closest('input[data-sel]'); if (!c) return; c.checked ? selKeys.add(c.dataset.sel) : selKeys.delete(c.dataset.sel); renderSelBar(); });

/* ============ تسجيل البصمة ============ */
let enroll = null, enrollLoop = false;
async function openEnroll(s){
  if (!s) return;
  if (!modelsReady) return toast('انتظر حتى تكتمل نماذج الوجه', 'err');
  enroll = {s, samples:[]};
  $('#enrollTitle').textContent = `تسجيل بصمة: ${s.name} (${s.id}) — ${s.stage} / ${s.shift}`;
  $('#thumbs').innerHTML = ''; $('#consentChk').checked = false; updateEnrollUI();
  $('#enrollModal').classList.add('show');
  try{ await startCamera($('#eVideo')); enrollLoop = true; enrollPreview(); }
  catch(e){ $('#ePrompt').textContent = 'تعذّر تشغيل الكاميرا — يمكنك رفع صور بدلاً من ذلك'; }
}
async function enrollPreview(){
  if (!enrollLoop) return;
  const v = $('#eVideo');
  if (v.readyState >= 2){
    try{
      const faces = await faceapi.detectAllFaces(v, detOpts());
      const c = $('#eOverlay'); c.width = v.videoWidth; c.height = v.videoHeight;
      const ctx = c.getContext('2d'); ctx.clearRect(0, 0, c.width, c.height); ctx.lineWidth = 4;
      faces.forEach(f => { ctx.strokeStyle = faces.length === 1 ? '#2ecc71' : '#e67e22'; ctx.strokeRect(f.box.x, f.box.y, f.box.width, f.box.height); });
      $('#ePrompt').textContent = faces.length === 0 ? 'لم يُكتشف وجه' : faces.length > 1 ? 'يوجد أكثر من وجه — يجب أن يظهر الطالب وحده' : 'الوجه واضح ✓ اضغط التقاط';
    }catch(e){}
  }
  setTimeout(enrollPreview, 250);
}
function updateEnrollUI(){
  const n = enroll ? enroll.samples.length : 0;
  $('#sampleCount').textContent = `${n} / 3`; $('#sampleCount').className = 'badge ' + (n >= 3 ? 'b-face' : 'b-gray');
  $('#enrollSave').disabled = !(n >= 3 && $('#consentChk').checked);
}
$('#consentChk').onchange = updateEnrollUI;
function addSample(desc, thumb){
  if (enroll.samples.length >= 6) return toast('يكفي ٦ صور كحد أقصى', 'err');
  enroll.samples.push(desc);
  if (thumb){ const img = document.createElement('img'); img.src = thumb; $('#thumbs').appendChild(img); }
  updateEnrollUI();
}
$('#captureBtn').onclick = async () => {
  const v = $('#eVideo'); if (!v.srcObject) return toast('الكاميرا غير مشغّلة', 'err');
  const faces = await detectFaces(v);
  if (!faces.length) return toast('لم يُكتشف وجه، حاول مجدداً', 'err');
  if (faces.length > 1) return toast('يجب أن يظهر وجه واحد فقط', 'err');
  const c = document.createElement('canvas'); c.width = 160; c.height = 120; c.getContext('2d').drawImage(v, 0, 0, 160, 120);
  addSample(faces[0].descriptor, c.toDataURL('image/jpeg', 0.6)); beep();
};
$('#enrollFiles').onchange = async e => {
  for (const file of e.target.files){
    try{
      const img = await faceapi.bufferToImage(file);
      const faces = await detectFaces(img);
      if (faces.length !== 1){ toast(`${file.name}: ${faces.length ? 'أكثر من وجه' : 'لا يوجد وجه'}`, 'err'); continue; }
      addSample(faces[0].descriptor, img.src);
    }catch(err){ toast('تعذّرت قراءة ' + file.name, 'err'); }
  }
  e.target.value = '';
};
function closeEnroll(){ enrollLoop = false; stopCamera($('#eVideo')); $('#enrollModal').classList.remove('show'); enroll = null; }
$('#enrollCancel').onclick = closeEnroll;
$('#enrollSave').onclick = async () => {
  const sm = enroll.samples, s = enroll.s; let maxD = 0;
  for (let i = 0; i < sm.length; i++) for (let j = i + 1; j < sm.length; j++) maxD = Math.max(maxD, faceapi.euclideanDistance(sm[i], sm[j]));
  if (maxD > 0.6 && !(await confirmBox('تحذير', 'الصور الملتقطة متباينة كثيراً وقد لا تكون لنفس الشخص. هل تريد الحفظ رغم ذلك؟', 'حفظ'))) return;
  // فحص التكرار داخل القسم
  const others = {}; deptStudents().forEach(o => { if (o.id !== s.id && o.prints.length) others[o.id] = o.prints.map(decDesc); });
  const m = buildMatcher(others, Settings.get().threshold);
  if (m){
    const best = m.findBestMatch(sm[0]);
    if (best.label !== 'unknown'){
      const o = deptStudents().find(x => x.id === best.label);
      if (!(await confirmBox('وجه مشابه!', `هذا الوجه يشبه الطالب المسجّل: ${o ? o.name : ''} (${best.label}). قد يكون تلاعباً أو تشابهاً (توأم). هل تريد الحفظ؟`, 'حفظ'))) return;
    }
  }
  bg(DB.update('att_packs', s.packId, {[`students.${s.id}.p`]:sm.map(encDesc), [`students.${s.id}.c`]:nowISO(), updatedAt:nowISO()}).p);
  if (s.u) bg(DB.update('att_stu', s.u, {p:sm.map(encDesc)}).p); // لتحقق الهاتف من وجه صاحبه عند مسح QR
  toast('تم حفظ البصمة: ' + s.name, 'ok'); closeEnroll();
};

/* =====================================================================
   أخذ الحضور
   ===================================================================== */
let sess = null, matcher = null, loopOn = false, track = {id:null};
$('#cDate').value = today();
const myAsg = () => (is('instructor') && App.dept) ? (App.user.assignments || []).filter(a => a.deptId === App.dept.id) : [];
function renderAsgSelect(){
  const limited = is('instructor') && (App.user.assignments || []).length > 0, list = myAsg();
  $('#cAsgBox').classList.toggle('hidden', !limited); $('#cNameBox').classList.toggle('hidden', limited);
  ['#cStage','#cShift','#cSection'].forEach(x => $(x).disabled = limited);
  if (!limited) return;
  $('#cAsg').innerHTML = list.length ? list.map((a, i) => `<option value="${i}">${esc(a.course)} — ${esc(a.stage)} / ${esc(a.shift)} / ${esc(a.section || 'كل الشعب')}</option>`).join('')
    : '<option value="">لا توجد مواد مسندة لك في هذا القسم</option>';
  $('#startSessionBtn').disabled = !list.length;
  applyAsg();
}
function applyAsg(){
  const a = myAsg()[+$('#cAsg').value]; if (!a) return;
  $('#cName').value = a.course; $('#cStage').value = a.stage; $('#cShift').value = a.shift; $('#cSection').value = a.section || '';
}
$('#cAsg').onchange = applyAsg;
const qrOptUI = () => { const m = $('#cMethod').value;
  $$('.qrOpt').forEach(e => e.classList.toggle('hidden', m === 'face'));
  $$('.qrOnly').forEach(e => e.classList.toggle('hidden', !(m === 'qr' || m === 'both')));
  $$('.pfOnly').forEach(e => e.classList.toggle('hidden', m !== 'phoneface')); };
$('#cMethod').onchange = qrOptUI; qrOptUI();
function renderCourseList(){
  const set = new Set(App.sessions.filter(s => !App.dept || s.deptId === App.dept.id).map(s => s.course));
  $('#courseList').innerHTML = [...set].map(c => `<option value="${esc(c)}">`).join('');
}
$('#startSessionBtn').onclick = async () => {
  const d = App.dept;
  if (!d) return toast('اختر القسم أولاً', 'err');
  const dt = $('#cDate').value || today(), past = dt < today();
  if (dt > today()) return toast('لا يمكن تسجيل حضور لتاريخ لم يأتِ بعد', 'err');
  if (past && !is('instructor')) return toast('تسجيل حضور المحاضرات السابقة يكون من التدريسي فقط', 'err');
  const method = past ? 'manual' : $('#cMethod').value, useFace = method === 'face' || method === 'both', useQR = method !== 'face' && method !== 'manual';
  if (useFace && !modelsReady) return toast('انتظر حتى تكتمل نماذج الوجه، أو اختر طريقة QR', 'err');
  const meta = {collegeId:d.collegeId, deptId:d.id, deptName:d.name, term:App.org.term,
    course:$('#cName').value.trim(), stage:$('#cStage').value, shift:$('#cShift').value, section:$('#cSection').value,
    type:$('#cType').value, hours:+$('#cHours').value || 1, date:$('#cDate').value || today(),
    instructorUid:App.user.uid, instructorName:App.user.name || App.user.email || ''};
  if (!meta.course) return toast('أدخل اسم المادة', 'err');
  if (past){
    meta.manualPast = true; meta.enteredAt = nowISO();
    const dup = App.sessions.find(x => x.date === meta.date && x.course === meta.course && x.stage === meta.stage && x.shift === meta.shift && (x.section || '') === (meta.section || ''));
    if (dup && !(await confirmBox('محاضرة مسجّلة مسبقاً', `يوجد حضور محفوظ لهذه المادة بتاريخ ${meta.date}. هل تريد تسجيل محاضرة أخرى في اليوم نفسه؟`, 'متابعة'))) return;
  }
  $('#startSessionBtn').disabled = true;
  let pack = null;
  try{ pack = await DB.get('att_packs', packId(d.id, meta.stage, meta.shift)); }
  catch(e){ $('#startSessionBtn').disabled = false; return toast('تعذّر تحميل قائمة الطلبة: ' + fbErr(e), 'err'); }
  $('#startSessionBtn').disabled = false;
  const studs = Object.entries((pack && pack.students) || {}).map(([id, s]) => ({id, name:s.n, section:s.s, prints:s.p || []}));
  const roster = studs.filter(s => !meta.section || s.section === meta.section).sort((a, b) => a.name.localeCompare(b.name, 'ar'));
  if (!roster.length) return toast('لا يوجد طلبة بهذه المرحلة/الدراسة/الشعبة (أو لم تُحمَّل بعد — افتحها مرة مع إنترنت)', 'err');
  const prints = {};
  if (useFace){
    studs.forEach(s => { if (s.prints.length) prints[s.id] = s.prints.map(decDesc); });
    matcher = buildMatcher(prints, Settings.get().threshold);
    const noPrint = roster.filter(s => !prints[s.id]).length;
    if (!matcher) toast('لا توجد بصمات مسجّلة لهذه المرحلة — سجّل الحضور يدوياً أو بـ QR', 'err');
    else if (noPrint && !useQR) toast(`${noPrint} طالب بدون بصمة — سجّلهم يدوياً`, 'err');
  } else matcher = null;
  meta.method = method;
  sess = {method, useFace, useQR, meta, names:Object.fromEntries(studs.map(s => [s.id, s.name])), hasPrint:prints,
          roster:new Map(roster.map(s => [s.id, {status:'absent', time:'', dist:null}]))};
  $('#sessionSetup').classList.add('hidden'); $('#sessionLive').classList.remove('hidden');
  $('#liveTitle').textContent = `${meta.course} — ${d.name} — ${meta.stage} / ${meta.shift}${meta.section ? ' / شعبة ' + meta.section : ''} — ${meta.type} (${meta.hours} ساعة) — ${meta.date}`;
  $('#rosterSearch').value = ''; renderRoster();
  $('#faceCard').classList.toggle('hidden', !useFace); $('#qrCard').classList.toggle('hidden', !useQR);
  $('#pauseBtn').classList.toggle('hidden', !useFace);
  $('#manualCard').classList.toggle('hidden', method !== 'manual');
  if (method === 'manual') $('#manualInfo').innerHTML = `محاضرة يوم <b>${esc(DAYS[new Date(meta.date + 'T12:00').getDay()] || '')} ${esc(meta.date)}</b> — ${roster.length} طالب. سيُحفظ أن الحضور أُدخل يدوياً لاحقاً بتاريخ اليوم.`;
  $('#rejBox').classList.add('hidden'); $('#rejBody').innerHTML = '';
  if (useQR) startQR();
  if (useFace){ if (matcher) await resumeCamera(); else showPrompt('لا توجد بصمات — التسجيل يدوي', 'warn'); }
};

/* ============ QR: رمز متغيّر يعرضه التدريسي ويمسحه الطلبة ============ */
const appBase = () => location.origin + location.pathname.replace(/index\.html$/, '');
async function codeFor(q, slot){
  if (q.codes.has(slot)) return q.codes.get(slot);
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(q.secret + ':' + slot));
  const v = new DataView(buf).getUint32(0) % 1000000, code = String(v).padStart(6, '0');
  q.codes.set(slot, code); return code;
}
function drawQR(canvas, text){
  const ctx = canvas.getContext('2d'), size = canvas.width;
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, size, canvas.height);
  if (typeof qrcode === 'undefined'){ ctx.fillStyle = '#c0392b'; ctx.font = '16px Tahoma'; ctx.textAlign = 'center'; ctx.fillText('مكتبة QR غير محمّلة — يلزم إنترنت', size / 2, size / 2); return; }
  const qr = qrcode(0, 'M'); qr.addData(text); qr.make();
  const n = qr.getModuleCount(), cell = Math.floor(size / (n + 8)), off = Math.floor((size - cell * n) / 2);
  ctx.fillStyle = '#000';
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (qr.isDark(r, c)) ctx.fillRect(off + c * cell, off + r * cell, cell, cell);
}
function startQR(){
  const m = sess.meta, secret = randHex(16), pin = String(100000 + Math.floor(Math.random() * 900000));
  const pf = sess.method === 'phoneface', mode = pf ? 'phoneface' : 'qr';
  const needCode = pf ? $('#cRoomCode').checked : true, face = pf ? true : $('#cQrFace').checked;
  const slotMs = pf ? PF_SLOT_MS : (+$('#cQrSec').value || 5) * 1000, mins = +$('#cQrMins').value;
  const endsAt = mins ? Date.now() + mins * 60000 : null;
  const w = DB.set('att_live', null, {collegeId:m.collegeId, deptId:m.deptId, deptName:m.deptName, course:m.course, stage:m.stage, shift:m.shift,
    section:m.section, instructorUid:m.instructorUid, instructorName:m.instructorName, pin, open:true, startedAt:TS, localStart:Date.now(),
    mode, needCode, slotMs, endsAt, face, acceptUntil:new Date(pf ? Date.now() : Date.now() + QR_ACCEPT_DAYS * 86400000)});
  const firstSlot = Math.floor(Date.now() / slotMs);
  const q = sess.qr = {stats:{recv:0, ok:0, rej:0}, liveId:w.id, secret, pin, slotMs, endsAt, face, mode, needCode, firstSlot, lastSlot:null, closed:false, offset:0, codes:new Map(), seen:{}, devices:{}, rejected:[], slot:null, chain:Promise.resolve()};
  bg(w.p);
  $('#qrPin').textContent = pin; $('#qrFullPin').textContent = pin;
  $('#qrFullTitle').textContent = `${m.course} — ${m.deptName} — ${m.stage} / ${m.shift}`;
  $('#qrHint').textContent = pf
    ? (needCode ? 'يفتح الطلبة التطبيق، ويلتقطون سيلفي، ثم يكتبون رمز القاعة الظاهر هنا (يتغير كل ٣٠ ثانية).' : 'يفتح الطلبة التطبيق ويلتقطون سيلفي، فيُسجَّل من يطابق وجهه صورته في النظام.')
    : `يلتقط الطالب سيلفي${face ? '' : ' (إن كانت له بصمة)'} ثم يمسح الرمز من داخل التطبيق. يتغيّر الرمز كل ${slotMs / 1000} ثوانٍ.`;
  $('#qrPin').parentElement.classList.toggle('hidden', pf);
  $('#qrStatus').textContent = App.mode === 'local' ? 'وضع محلي: للتجربة فقط' :
    navigator.onLine ? '' : '⚠ غير متصل: يحفظ الطلبة حضورهم على هواتفهم، وتُضاف أسماؤهم إلى هذه المحاضرة تلقائياً عند توفر الإنترنت.';
  App.subs.live = DB.listenDoc('att_live', q.liveId, d => {
    const st = d && tsMillis(d.startedAt);
    if (st && d.localStart && sess && sess.qr === q) q.offset = st - d.localStart; // فرق ساعة الجهاز عن الخادم
  });
  renderQrStats(q);
  App.subs.checkins = DB.listen(`att_live/${q.liveId}/c`, [], list => { q.chain = q.chain.then(() => handleCheckins(q, list)).catch(console.error); },
    e => { console.error(e); $('#qrStats').textContent = '⚠ لا يستطيع هذا الجهاز قراءة تسجيلات الطلبة: ' + fbErr(e) + ' — تأكد من نشر قواعد Firebase الجديدة.'; });
  q.timer = setInterval(() => qrTick(q), 1000); qrTick(q);
}
const mmss = ms => { const t = Math.max(0, Math.ceil(ms / 1000)); return `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`; };
async function qrTick(q){
  if (!sess || sess.qr !== q || q.closed) return;
  const now = Date.now(), slot = Math.floor(now / q.slotMs), left = q.slotMs - (now % q.slotMs);
  const lbl = q.mode === 'phoneface' ? 'التسجيل بالوجه من الهاتف' : 'التسجيل بـ QR';
  if (q.endsAt && now >= q.endsAt) return closeQRWindow(q, 'انتهى وقت ' + lbl);
  $('#qrWindow').textContent = q.endsAt ? `⏱ يتوقف ${lbl} خلال ${mmss(q.endsAt - now)}` : `⏱ ${lbl} مفتوح حتى إنهاء المحاضرة`;
  $('#qrFullWindow').textContent = q.endsAt ? `يتوقف خلال ${mmss(q.endsAt - now)}` : '';
  $('#qrBar').style.width = (left / q.slotMs * 100) + '%';
  $('#qrFullCount').textContent = `يتغير خلال ${Math.ceil(left / 1000)} ث`;
  if (slot === q.slot) return;
  q.slot = slot;
  const code = await codeFor(q, slot), text = `${appBase()}?a=${q.liveId}.${slot}.${code}${q.face ? '.f' : ''}`;
  if (q.closed) return;
  if (q.mode === 'phoneface'){ // لا QR: رمز القاعة (إن طُلب) أو رسالة
    const shown = q.needCode ? code : '';
    $('#qrCode').textContent = shown || '📱'; $('#qrFullCode').textContent = shown;
    const msg = q.needCode ? 'رمز القاعة' : 'افتحوا التطبيق والتقطوا سيلفي';
    drawCodeCanvas($('#qrCanvas'), shown, msg); if ($('#qrFull').classList.contains('show')) drawCodeCanvas($('#qrFullCanvas'), shown, msg);
    q.text = null; q.pfShown = shown; return;
  }
  $('#qrCode').textContent = code; $('#qrFullCode').textContent = code;
  drawQR($('#qrCanvas'), text);
  if ($('#qrFull').classList.contains('show')) drawQR($('#qrFullCanvas'), text);
  q.text = text;
  for (const k of q.codes.keys()) if (k < slot - 200) q.codes.delete(k);
}
function drawCodeCanvas(canvas, code, msg){
  const ctx = canvas.getContext('2d'), size = canvas.width;
  ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, size, canvas.height); ctx.textAlign = 'center'; ctx.fillStyle = '#14324f';
  ctx.font = `bold ${Math.round(size / 15)}px Cairo, Tahoma`; ctx.fillText('📱 ' + msg, size / 2, size * (code ? 0.32 : 0.5));
  if (code){ ctx.font = `bold ${Math.round(size / 5)}px monospace`; ctx.fillText(code, size / 2, size * 0.62); }
}
function drawClosed(canvas, msg){
  const ctx = canvas.getContext('2d'), size = canvas.width;
  ctx.fillStyle = '#f0f4f8'; ctx.fillRect(0, 0, size, canvas.height);
  ctx.fillStyle = '#14324f'; ctx.font = `bold ${Math.round(size / 16)}px Cairo, Tahoma`; ctx.textAlign = 'center';
  ctx.fillText('⏹', size / 2, size / 2 - size / 12); ctx.fillText(msg, size / 2, size / 2 + size / 12);
}
function closeQRWindow(q, msg){
  if (q.closed) return;
  q.closed = true; q.lastSlot = Math.floor(Date.now() / q.slotMs);
  clearInterval(q.timer);
  bg(DB.update('att_live', q.liveId, {open:false, closedAt:TS}).p);
  $('#qrCode').textContent = '------'; $('#qrFullCode').textContent = ''; $('#qrBar').style.width = '0%';
  $('#qrWindow').textContent = '⏹ ' + msg + ' — من مسح الرمز قبل التوقف يُقبل حتى لو وصل حضوره متأخراً';
  $('#qrFullWindow').textContent = msg;
  drawClosed($('#qrCanvas'), msg); if ($('#qrFull').classList.contains('show')) drawClosed($('#qrFullCanvas'), msg);
  $('#qrStopBtn').classList.add('hidden'); $('#qrExtendBtn').textContent = '↺ فتح QR مجدداً (+5 دقائق)';
  beep();
}
$('#qrStopBtn').onclick = async () => {
  const q = sess && sess.qr; if (!q || q.closed) return;
  if (await confirmBox('إيقاف QR', 'سيتوقف قبول الحضور بـ QR الآن. يبقى التسجيل اليدوي وبصمة الوجه متاحين.', 'إيقاف')) closeQRWindow(q, 'أوقف التدريسي التسجيل بـ QR');
};
$('#qrExtendBtn').onclick = () => {
  const q = sess && sess.qr; if (!q) return;
  if (q.closed){ // إعادة الفتح
    q.closed = false; q.lastSlot = null; q.slot = null; q.endsAt = Date.now() + 5 * 60000;
    bg(DB.update('att_live', q.liveId, {open:true, endsAt:q.endsAt}).p);
    $('#qrStopBtn').classList.remove('hidden'); $('#qrExtendBtn').textContent = '+5 دقائق';
    q.timer = setInterval(() => qrTick(q), 1000); qrTick(q);
    toast('أُعيد فتح التسجيل بـ QR لخمس دقائق', 'ok');
  } else {
    q.endsAt = (q.endsAt || Date.now()) + 5 * 60000;
    bg(DB.update('att_live', q.liveId, {endsAt:q.endsAt}).p); qrTick(q);
    toast('تم تمديد التسجيل بـ QR خمس دقائق', 'ok');
  }
};
async function handleCheckins(q, list){
  if (!sess || sess.qr !== q) return;
  for (const c of list){
    const at = tsMillis(c.at); if (at == null) continue; // ينتظر وقت الخادم
    const key = c.id + ':' + at; if (q.seen[key]) continue; q.seen[key] = true;
    q.stats.recv++;
    const v = await validateCheckin(q, c, at, q.lastSlot != null ? q.lastSlot : Math.floor(Date.now() / q.slotMs));
    let reason = v.reason || faceReason(q, c);
    if (!reason && !sess.roster.has(c.sid)) reason = 'ليس ضمن هذه الشعبة';
    else if (!reason && q.devices[c.deviceId] && q.devices[c.deviceId] !== c.sid) reason = 'الهاتف نفسه استُخدم لطالب آخر: ' + (sess.names[q.devices[c.deviceId]] || q.devices[c.deviceId]);
    if (reason){ q.stats.rej++; renderQrStats(q); q.rejected.unshift({sid:c.sid, name:sess.names[c.sid] || c.sid, reason, time:hhmm(), selfie:c.selfie || ''}); renderRejected(q); continue; }
    q.stats.ok++; renderQrStats(q);
    q.devices[c.deviceId] = c.sid;
    const st = sess.roster.get(c.sid);
    if (st.status === 'absent'){ // حضور دون اتصال: يُسجَّل بوقت المسح على الهاتف لا بوقت وصول الإنترنت
      st.device = c.deviceId; st.selfie = c.selfie || '';
      markPresent(c.sid, v.method, null, v.method === 'qr-off' ? new Date(+c.capturedAt).toLocaleTimeString('en-GB', {hour:'2-digit', minute:'2-digit'}) : null);
    }
  }
}
// التحقق من تسجيل QR: الرمز يجب أن يطابق الرمز السري لخانة زمنية ضمن وقت التسجيل،
// وإما أن يصل حياً خلال ~٢٠ ثانية (وقت الخادم)، أو يكون مسجّلاً على الهاتف دون اتصال بوقت مسح مطابق لوقت الرمز
async function validateCheckin(q, c, at, lastSlot){
  const code = String(c.code || ''), ms = q.slotMs || SLOT_MS, inRange = s => s >= q.firstSlot - 1 && s <= lastSlot + 1;
  if (q.mode === 'phoneface'){ // سيلفي من هاتف الطالب أثناء فتح التسجيل فقط
    if (at == null) return {reason:'وصل بعد انتهاء التسجيل'};
    if (q.needCode){
      const sNow = Math.floor((at - q.offset) / ms); let ok = false;
      for (let s = sNow + 1; s >= sNow - 3; s--) if (inRange(s) && code === await codeFor(q, s)){ ok = true; break; }
      if (!ok) return {reason:'رمز القاعة غير صحيح'};
    }
    return {method:'phone-face'};
  }
  const grace = Math.max(1, Math.ceil((QR_GRACE_MS + (q.face ? QR_FACE_EXTRA_MS : 0)) / ms));
  if (at != null){ // حيّ: بحسب وقت الخادم (لا يعتمد على ساعة هاتف الطالب)
    const sNow = Math.floor((at - q.offset) / ms);
    for (let s = sNow + 1; s >= sNow - grace; s--) if (inRange(s) && code === await codeFor(q, s)) return {method:'qr'};
  }
  const slot = +c.slot;
  if (!inRange(slot) || code !== await codeFor(q, slot)) return {reason: at != null ? 'رمز غير صحيح أو منتهي الصلاحية' : 'رمز غير صحيح'};
  const cap = +c.capturedAt || 0;
  if (Math.abs(cap - (slot * ms + ms / 2)) <= QR_CAPTURE_TOL) return {method:'qr-off'};
  return {reason:'رمز منتهي الصلاحية'};
}
// سبب رفض متعلق بسيلفي الوجه (عندما يفعّله التدريسي)
function faceReason(q, c){
  if (!q.face) return null;
  const f = c.face || {};
  if (f.ok) return null;
  return {noprint:'لا توجد بصمة وجه مسجّلة لحسابه', nomodel:'تعذّر تحميل التحقق من الوجه على هاتفه', timeout:'لم يكمل التحقق من الوجه',
          mismatch:'⚠ الوجه لا يطابق صاحب الحساب', nocam:'تعذّر تشغيل الكاميرا الأمامية'}[f.why] || 'لم يُرسل تحقق الوجه';
}
const sfImg = src => src ? `<img class="sf" src="${esc(src)}" alt="" data-zoom="1">` : '';
function renderQrStats(q){ $('#qrStats').textContent = `📶 وصل ${q.stats.recv} تسجيل — قُبل ${q.stats.ok} — رُفض ${q.stats.rej}`; }
function renderRejected(q){
  $('#rejBox').classList.toggle('hidden', !q.rejected.length);
  $('#rejBody').innerHTML = q.rejected.slice(0, 50).map(r => `<tr><td>${sfImg(r.selfie)} ${esc(r.name)} <span class="note" dir="ltr">${esc(r.sid)}</span></td><td>${esc(r.reason)}</td><td>${r.time}</td></tr>`).join('');
}
document.addEventListener('click', e => {
  const im = e.target.closest('img[data-zoom]'); if (!im) return;
  $('#spotBody').innerHTML = `<img src="${im.src}" style="width:min(320px,80vw);border-radius:14px;transform:scaleX(-1);margin:auto">`;
  $('#spotAgain').classList.add('hidden'); $('#spotModal').classList.add('show');
});
function pickSpot(){
  if (!sess) return;
  const qrIds = [...sess.roster.entries()].filter(([, st]) => ['qr','qr-off','phone-face'].includes(st.status)).map(([id]) => id);
  if (!qrIds.length){ $('#spotBody').innerHTML = '<p class="note">لا يوجد طلبة مسجّلون بـ QR بعد.</p>'; return; }
  const pick = qrIds.sort(() => Math.random() - 0.5).slice(0, Math.min(3, qrIds.length));
  $('#spotBody').innerHTML = pick.map(id => { const st = sess.roster.get(id);
    return `<div class="spot"><span>${st.selfie ? `<img src="${esc(st.selfie)}"> ` : ''}${esc(sess.names[id] || id)}</span><button class="btn sm red" data-spotno="${esc(id)}">إلغاء حضوره</button></div>`; }).join('');
}
$('#spotBtn').onclick = () => { $('#spotAgain').classList.remove('hidden'); pickSpot(); $('#spotModal').classList.add('show'); };
$('#spotAgain').onclick = pickSpot;
$('#spotClose').onclick = () => $('#spotModal').classList.remove('show');
$('#spotBody').onclick = e => {
  const b = e.target.closest('button[data-spotno]'); if (!b || !sess) return;
  const st = sess.roster.get(b.dataset.spotno); st.status = 'absent'; st.time = ''; st.flag = 'spot';
  b.closest('.spot').style.opacity = .4; b.remove(); renderRoster();
  toast('أُلغي حضوره — يمكن مراجعة الأمر مع رئيس القسم', 'err');
};
function stopQR(){
  const q = sess && sess.qr; if (!q) return;
  clearInterval(q.timer); unsub('live'); unsub('checkins');
  if (!q.closed) bg(DB.update('att_live', q.liveId, {open:false, closedAt:TS}).p);
  $('#qrStopBtn').classList.remove('hidden'); $('#qrExtendBtn').textContent = '+5 دقائق'; $('#qrWindow').textContent = '';
  $('#qrFull').classList.remove('show'); sess.qr = null;
}
$('#qrFullBtn').onclick = () => {
  const q = sess && sess.qr; if (!q) return;
  $('#qrFull').classList.add('show'); if (q.text) drawQR($('#qrFullCanvas'), q.text);
  else if (q.mode === 'phoneface') drawCodeCanvas($('#qrFullCanvas'), q.pfShown || '', q.needCode ? 'رمز القاعة' : 'افتحوا التطبيق والتقطوا سيلفي');
  try{ document.documentElement.requestFullscreen && document.documentElement.requestFullscreen(); }catch(e){}
};
function closeQrFull(){ $('#qrFull').classList.remove('show'); try{ document.fullscreenElement && document.exitFullscreen(); }catch(e){} }
$('#qrFullClose').onclick = closeQrFull;
document.addEventListener('keydown', e => { if (e.key === 'Escape') closeQrFull(); });
async function resumeCamera(){
  try{ await startCamera($('#video')); loopOn = true; track = {id:null}; $('#pauseBtn').textContent = '⏸ إيقاف الكاميرا مؤقتاً'; recognitionLoop(); }
  catch(e){ console.error(e); showPrompt('تعذّر تشغيل الكاميرا — اسمح للتطبيق باستخدامها', 'err'); }
}
$('#pauseBtn').onclick = async () => {
  if (loopOn){ loopOn = false; stopCamera($('#video')); showPrompt('الكاميرا متوقفة', ''); $('#pauseBtn').textContent = '▶ استئناف الكاميرا'; }
  else if (matcher) await resumeCamera();
};
function showPrompt(t, c){ const p = $('#prompt'); p.textContent = t; p.className = c || ''; }
async function recognitionLoop(){
  if (!loopOn) return;
  const t0 = performance.now(), v = $('#video');
  if (v.readyState >= 2){ try{ handleFaces(await detectFaces(v)); }catch(e){ console.error(e); } }
  setTimeout(recognitionLoop, Math.max(20, 110 - (performance.now() - t0)));
}
function handleFaces(faces){
  if (!sess || !loopOn) return;
  const v = $('#video'), c = $('#overlay'), S = Settings.get(), now = Date.now();
  if (!faces.length){ drawBoxes(c, v, [], ''); track = {id:null}; return showPrompt('قف أمام الكاميرا', ''); }
  const f = faces[0], m = matcher.findBestMatch(f.descriptor), p = f.landmarks.positions;
  let id = null;
  if (m.label !== 'unknown'){
    if (m.label !== track.id) track = {id:m.label, frames:0, phase:0, start:now, last:now};
    track.frames++; track.last = now; id = m.label;
  } else if (track.id && track.phase > 0 && now - track.last < 2000){
    id = track.id;
  } else {
    track = {id:null}; drawBoxes(c, v, faces, '#e74c3c');
    return showPrompt('وجه غير معروف — راجع التدريسي', 'err');
  }
  const name = sess.names[id] || id, st = sess.roster.get(id);
  if (!st){ drawBoxes(c, v, faces, '#e67e22'); return showPrompt(`${name}: ليس ضمن هذه الشعبة`, 'warn'); }
  if (st.status !== 'absent'){ drawBoxes(c, v, faces, '#2ecc71'); return showPrompt(`${name} — مسجّل حاضر ✓`, 'ok'); }
  drawBoxes(c, v, faces, '#3498db');
  if (faces.length > 1) return showPrompt('شخص واحد فقط أمام الكاميرا', 'warn');
  if (track.frames < S.minFrames) return showPrompt(`جارٍ التحقق من ${name}...`, 'act');
  if (S.liveness === 'none') return markPresent(id, 'face', m.distance);
  if (now - track.start > 9000){ track.start = now; track.phase = 0; }
  if (S.liveness === 'blink'){
    const e = eyeAR(p);
    if (track.phase === 0 && e > 0.26) track.phase = 1;
    else if (track.phase === 1 && e < 0.21) track.phase = 2;
    else if (track.phase === 2 && e > 0.25) return markPresent(id, 'face', m.distance);
    return showPrompt(`${name}: ارمش بعينيك`, 'act');
  }
  const off = Math.abs(yawRatio(p) - 0.5);
  if (track.phase === 0 && off < 0.08) track.phase = 1;
  else if (track.phase === 1 && off > 0.15) track.phase = 2;
  else if (track.phase === 2 && off < 0.09) return markPresent(id, 'face', m.distance);
  showPrompt(track.phase < 2 ? `${name}: أدِر رأسك قليلاً يميناً أو يساراً` : `${name}: انظر إلى الكاميرا مجدداً`, 'act');
}
function markPresent(id, method, d=null, time=null){
  const st = sess.roster.get(id); if (!st) return;
  st.status = method; st.time = time || hhmm(); st.dist = d;
  if (method === 'face'){ beep(); showPrompt(`✓ ${sess.names[id] || id} — حاضر`, 'ok'); }
  if (['qr','qr-off','phone-face'].includes(method)) beep();
  renderRoster();
}
$('#rosterSearch').oninput = renderRoster;
function renderRoster(){
  if (!sess) return;
  const q = $('#rosterSearch').value.trim(); let present = 0;
  sess.roster.forEach(st => { if (st.status !== 'absent') present++; });
  const rows = [...sess.roster.entries()]
    .filter(([id]) => !q || (sess.names[id] || '').includes(q) || id.includes(q))
    .sort((a, b) => (a[1].status === 'absent') - (b[1].status === 'absent'));
  $('#rosterBody').innerHTML = rows.map(([id, st]) => {
    const badge = st.status === 'phone-face' ? '<span class="badge b-face">حاضر (سيلفي)</span>' : st.status === 'qr-off' ? '<span class="badge b-qr">حاضر (QR دون اتصال)</span>' : st.status === 'qr' ? '<span class="badge b-qr">حاضر (QR)</span>' : st.status === 'face' ? '<span class="badge b-face">حاضر (وجه)</span>' : st.status === 'manual' ? '<span class="badge b-man">حاضر (يدوي)</span>' : '<span class="badge b-abs">غائب</span>';
    const btn = st.status === 'absent' ? `<button class="btn sm light" data-man="${esc(id)}">حاضر يدوياً</button>` : `<button class="btn sm light" data-undo="${esc(id)}">إلغاء</button>`;
    return `<tr><td>${sfImg(st.selfie)} ${esc(sess.names[id] || id)}${st.flag === 'spot' ? ' <span class="badge b-abs">غائب في التحقق العشوائي</span>' : ''}${(!sess.useFace || sess.hasPrint[id]) ? '' : ' <span class="badge b-gray">بلا بصمة</span>'}</td><td>${badge}</td><td>${st.time}</td><td>${btn}</td></tr>`;
  }).join('');
  $('#stPresent').textContent = present; $('#stTotal').textContent = sess.roster.size; $('#stAbsent').textContent = sess.roster.size - present;
}
$('#manAllP').onclick = () => { if (!sess) return; const t = hhmm(); sess.roster.forEach(st => { if (st.status === 'absent'){ st.status = 'manual'; st.time = t; } }); renderRoster(); };
$('#manAllA').onclick = () => { if (!sess) return; sess.roster.forEach(st => { st.status = 'absent'; st.time = ''; st.dist = null; }); renderRoster(); };
// التاريخ: المحاضرات السابقة تُسجَّل يدوياً فقط ومن التدريسي فقط
let methodBeforePast = null;
function pastUI(){
  const dt = $('#cDate').value, past = !!dt && dt < today(), fut = !!dt && dt > today(), sel = $('#cMethod'), mo = sel.querySelector('option[value="manual"]');
  if (past){ if (sel.value !== 'manual') methodBeforePast = sel.value; mo.hidden = false; sel.value = 'manual'; sel.disabled = true; }
  else { mo.hidden = true; if (sel.value === 'manual') sel.value = methodBeforePast || 'face'; sel.disabled = false; }
  qrOptUI(); if (past) $$('.qrOpt').forEach(e => e.classList.add('hidden'));
  const n = $('#pastNote'); n.classList.toggle('hidden', !past && !fut);
  n.innerHTML = fut ? '⚠ لا يمكن تسجيل الحضور لتاريخ لم يأتِ بعد.' : !is('instructor') ? '⛔ تسجيل حضور المحاضرات السابقة يكون من <b>التدريسي فقط</b>.' : `✎ <b>محاضرة سابقة (${esc(dt)})</b>: يُسجَّل الحضور يدوياً فقط — تحدّد الحاضرين والغائبين من القائمة.`;
  $('#startSessionBtn').textContent = past ? '✎ فتح قائمة الطلبة للتسجيل اليدوي' : '▶ بدء المحاضرة';
  $('#startSessionBtn').disabled = fut || (past && !is('instructor'));
}
$('#cDate').addEventListener('change', pastUI); $('#cDate').addEventListener('input', pastUI);
$('#missBody').onclick = e => {
  const b = e.target.closest('button[data-miss]'); if (!b) return;
  const o = JSON.parse(b.dataset.miss);
  showTab('tSession');
  if (!$('#cAsgBox').classList.contains('hidden')){
    const i = myAsg().findIndex(a => a.course === o.course && a.stage === o.stage && a.shift === o.shift && (a.section || '') === (o.section || ''));
    if (i < 0) return toast('هذه المادة غير مسندة إليك في حسابك — راجع رئيس القسم', 'err');
    $('#cAsg').value = i; applyAsg();
  } else { $('#cName').value = o.course; $('#cStage').value = o.stage; $('#cShift').value = o.shift; $('#cSection').value = o.section || ''; }
  $('#cType').value = o.type || 'نظري'; $('#cHours').value = o.hours || 2; $('#cDate').value = o.date; pastUI();
  $('#sessionSetup').scrollIntoView({behavior:'smooth'}); toast('تم ملء بيانات المحاضرة — اضغط «فتح قائمة الطلبة»', 'ok');
};
$('#rosterBody').onclick = e => {
  const b = e.target.closest('button'); if (!b) return;
  if (b.dataset.man) markPresent(b.dataset.man, 'manual');
  if (b.dataset.undo){ const st = sess.roster.get(b.dataset.undo); st.status = 'absent'; st.time = ''; st.dist = null; track = {id:null}; renderRoster(); }
};
function endSessionUI(){
  stopQR(); loopOn = false; stopCamera($('#video')); sess = null; matcher = null;
  $('#sessionLive').classList.add('hidden'); $('#sessionSetup').classList.remove('hidden');
}
$('#cancelSessionBtn').onclick = async () => {
  if (await confirmBox('إلغاء المحاضرة', 'سيُلغى أخذ الحضور لهذه المحاضرة دون حفظ أي شيء.', 'إلغاء دون حفظ')) endSessionUI();
};
$('#finishBtn').onclick = async () => {
  const absent = [...sess.roster.values()].filter(s => s.status === 'absent').length;
  if (!(await confirmBox('إنهاء المحاضرة', `سيُحفظ الحضور: ${sess.roster.size - absent} حاضر و${absent} غائب.`, 'حفظ'))) return;
  const entries = [...sess.roster.entries()], names = {};
  entries.forEach(([id]) => names[id] = sess.names[id] || id);
  const rec = Object.assign({}, sess.meta, {
    absentees: entries.filter(([, s]) => s.status === 'absent').map(([id]) => id),
    present: entries.filter(([, s]) => s.status !== 'absent').map(([id, s]) => Object.assign({id, method:s.status, time:s.time, dist:s.dist == null ? null : +s.dist.toFixed(3)}, s.device ? {device:s.device} : {})),
    names, createdAt:nowISO(), appVersion:APP_VERSION
  });
  if (sess.qr){ // لإضافة طلبة QR الذين يرفعون حضورهم لاحقاً (دون اتصال)
    const q = sess.qr;
    Object.assign(rec, {liveMode:q.mode || 'qr', liveId:q.liveId, qrSecret:q.secret, qrSlotMs:q.slotMs, qrFace:!!q.face,
      spotAbsent:entries.filter(([, s]) => s.flag === 'spot').map(([id]) => id), qrFrom:q.firstSlot, qrTo:q.lastSlot != null ? q.lastSlot : Math.floor(Date.now() / q.slotMs),
      acceptUntil:new Date(Date.now() + QR_ACCEPT_DAYS * 86400000).toISOString(), qrLate:0});
  }
  const w = DB.set('att_sessions', null, rec);
  audit(rec.manualPast ? 'تسجيل يدوي لمحاضرة سابقة' : 'حفظ حضور محاضرة', `${rec.course} — ${rec.stage} / ${rec.shift}${rec.section ? ' / ' + rec.section : ''} — ${rec.date} — حاضر ${rec.present.length}، غائب ${rec.absentees.length}، يدوي ${rec.present.filter(x => x.method === 'manual').length}`, rec.deptId);
  if (App.mode === 'local') toast('تم حفظ حضور المحاضرة', 'ok');
  else {
    bg(w.p, 'تم رفع حضور المحاضرة إلى الخادم ✓');
    if (!navigator.onLine) toast('لا يوجد إنترنت: حُفظ الحضور على الجهاز وسيُرفع تلقائياً عند عودة الاتصال', 'ok');
  }
  endSessionUI();
};
window.addEventListener('beforeunload', e => { if (sess){ e.preventDefault(); e.returnValue = ''; } });

/* =====================================================================
   السجلات والتقارير
   ===================================================================== */
const courseKey = s => `${s.course} | ${s.stage} | ${s.shift}` + (is('instructor') ? ` | ${s.deptName || deptName(s.deptId)}` : '');
function renderRecords(){
  if (!is('super','dean','head','instructor')) return;
  const T = App.org ? App.org.term : '';
  $('#recTitle').textContent = is('instructor') ? `محاضراتي — ${T}` : `محاضرات قسم ${App.dept ? App.dept.name : '—'} — ${T}`;
  const list = App.sessions.slice().sort((a, b) => (b.date + b.createdAt).localeCompare(a.date + a.createdAt));
  const canDel = is('super','dean','head');
  $('#sessionsBody').innerHTML = list.map(s => `<tr><td>${esc(s.date)}</td><td>${esc(s.deptName || deptName(s.deptId))}</td><td>${esc(s.course)}</td>
    <td>${esc(s.stage)} / ${esc(s.shift)} / ${esc(s.section || 'الكل')}</td><td>${esc(s.type)}</td><td>${s.hours}</td><td>${esc(s.instructorName || '')}</td>
    <td>${(s.present || []).length}${s.qrLate ? ` <span class="badge b-qr" title="أُضيفوا لاحقاً من هواتف كانت دون اتصال">+${s.qrLate} QR</span>` : ''}${s.manualPast ? ` <span class="badge b-man" title="أُدخل يدوياً بتاريخ ${esc((s.enteredAt || '').slice(0, 10))}">✎ يدوي لاحق</span>` : ''}</td><td>${(s.absentees || []).length}</td>
    <td>${App.mode === 'local' ? '<span class="badge b-gray">محلي</span>' : s._pending ? '<span class="badge b-man">بانتظار الرفع</span>' : '<span class="badge b-face">مرفوع ✓</span>'}</td>
    <td class="row"><button class="btn sm light" data-csv="${esc(s.id)}">CSV</button>${canDel ? `<button class="btn sm red" data-sdel="${esc(s.id)}">حذف</button>` : ''}</td></tr>`).join('')
    || '<tr><td colspan="11" class="note">لا توجد محاضرات محفوظة في هذا الفصل</td></tr>';
  const keys = [...new Set(App.sessions.map(courseKey))].sort();
  const cur = $('#sumCourse').value;
  $('#sumCourse').innerHTML = keys.map(k => `<option ${k === cur ? 'selected' : ''}>${esc(k)}</option>`).join('') || '<option value="">لا توجد مواد</option>';
  renderSummary();
}
$('#sessionsBody').onclick = async e => {
  const b = e.target.closest('button'); if (!b) return;
  if (b.dataset.csv){
    const s = App.sessions.find(x => x.id === b.dataset.csv);
    const nm = id => (s.names && s.names[id]) || id;
    const rows = [['القسم', s.deptName || deptName(s.deptId), 'المادة', s.course, 'التاريخ', s.date, 'الساعات', s.hours],
                  ['الرقم','الاسم','الحالة','طريقة التسجيل','الوقت']];
    (s.present || []).forEach(p => rows.push([p.id, nm(p.id), 'حاضر', {face:'بصمة وجه', qr:'QR', 'qr-off':'QR دون اتصال', 'phone-face':'سيلفي من الهاتف', manual:'يدوي'}[p.method] || p.method, p.time]));
    (s.absentees || []).forEach(id => rows.push([id, nm(id), 'غائب', '', '']));
    download(`حضور_${s.course}_${s.date}.csv`, toCSV(rows), 'text/csv');
  }
  if (b.dataset.sdel && await confirmBox('حذف المحاضرة', 'سيُحذف سجل حضور هذه المحاضرة نهائياً.', 'حذف')){ const sx = App.sessions.find(x => x.id === b.dataset.sdel); bg(DB.del('att_sessions', b.dataset.sdel).p); audit('حذف محاضرة', sx ? `${sx.course} — ${sx.date} — ${sx.instructorName || ''}` : b.dataset.sdel, sx && sx.deptId); }
};
function absenceTable(sessions){ // {key: {held, abs:{id:h}, names}}
  const out = {};
  sessions.forEach(s => {
    const k = (s.deptId || '') + '|' + s.course + '|' + s.stage + '|' + s.shift;
    const o = out[k] = out[k] || {held:0, abs:{}, names:{}, deptId:s.deptId};
    o.held += +s.hours || 0; Object.assign(o.names, s.names || {});
    (s.absentees || []).forEach(id => o.abs[id] = (o.abs[id] || 0) + (+s.hours || 0));
    (s.present || []).forEach(p => o.abs[p.id] = o.abs[p.id] || 0);
  });
  return out;
}
function summaryRows(){
  const key = $('#sumCourse').value; if (!key) return [];
  const ss = App.sessions.filter(s => courseKey(s) === key);
  const t = Object.values(absenceTable(ss))[0]; if (!t) return [];
  return Object.entries(t.abs).map(([id, h]) => ({id, name:t.names[id] || id, h, held:t.held, pct:t.held ? h / t.held * 100 : 0}))
    .sort((a, b) => b.pct - a.pct || a.name.localeCompare(b.name, 'ar'));
}
$('#sumCourse').onchange = renderSummary;
function renderSummary(){
  const rows = summaryRows();
  $('#summaryBody').innerHTML = rows.map(r => `<tr><td>${esc(r.id)}</td><td>${esc(r.name)}</td><td>${r.h}</td><td>${r.held}</td>
    <td><span class="badge ${r.pct >= 10 ? 'b-abs' : r.pct >= 5 ? 'b-man' : 'b-face'}">${r.pct.toFixed(1)}%</span></td></tr>`).join('')
    || '<tr><td colspan="5" class="note">لا توجد بيانات</td></tr>';
}
$('#sumExportBtn').onclick = () => {
  const rows = summaryRows(); if (!rows.length) return toast('لا توجد بيانات', 'err');
  download('ملخص_الغياب.csv', toCSV([['المادة', $('#sumCourse').value], ['الرقم','الاسم','ساعات الغياب','الساعات المنعقدة','نسبة الغياب %'],
    ...rows.map(r => [r.id, r.name, r.h, r.held, r.pct.toFixed(1)])]), 'text/csv');
};

/* ---- تقرير الكليات والأقسام (مدير النظام والعميد) ---- */
let ovRows = [];
function renderOverviewOptions(){
  if (!is('super','dean')) return;
  const cur = $('#ovCollege').value;
  const cols = is('super') ? Object.entries(App.org.colleges || {}) : [[App.user.collegeId, {name:collegeName(App.user.collegeId)}]];
  $('#ovCollege').innerHTML = (is('super') ? '<option value="*">كل الجامعة</option>' : '') + cols.map(([id, c]) => `<option value="${esc(id)}">${esc(c.name)}</option>`).join('');
  if (cur && [...$('#ovCollege').options].some(o => o.value === cur)) $('#ovCollege').value = cur;
}
$('#ovLoadBtn').onclick = async () => {
  const c = $('#ovCollege').value, T = App.org.term;
  const f = c === '*' ? [['term', T]] : [['collegeId', c], ['term', T]];
  $('#ovLoadBtn').disabled = true; $('#ovBody').innerHTML = '<tr><td colspan="7" class="note">جارٍ التحميل...</td></tr>';
  try{
    const list = await DB.query('att_sessions', f), per = {};
    list.forEach(s => {
      const o = per[s.deptId] = per[s.deptId] || {collegeId:s.collegeId, deptId:s.deptId, name:s.deptName || deptName(s.deptId), lec:0, hours:0, P:0, A:0, face:0, sessions:[]};
      o.lec++; o.hours += +s.hours || 0; o.P += (s.present || []).length; o.A += (s.absentees || []).length;
      o.face += (s.present || []).filter(p => p.method !== 'manual').length; o.sessions.push(s);
    });
    ovRows = Object.values(per).map(o => {
      const over = new Set();
      Object.values(absenceTable(o.sessions)).forEach(t => Object.entries(t.abs).forEach(([id, h]) => { if (t.held && h / t.held > 0.10) over.add(id); }));
      return {college:collegeName(o.collegeId), dept:o.name, lec:o.lec, hours:o.hours,
        rate:(o.P + o.A) ? o.P / (o.P + o.A) * 100 : 0, faceRate:o.P ? o.face / o.P * 100 : 0, over:over.size};
    }).sort((a, b) => a.college.localeCompare(b.college, 'ar') || a.dept.localeCompare(b.dept, 'ar'));
    $('#ovBody').innerHTML = ovRows.map(r => `<tr><td>${esc(r.college)}</td><td>${esc(r.dept)}</td><td>${r.lec}</td><td>${r.hours}</td>
      <td><span class="badge ${r.rate >= 90 ? 'b-face' : r.rate >= 80 ? 'b-man' : 'b-abs'}">${r.rate.toFixed(1)}%</span></td><td>${r.faceRate.toFixed(0)}%</td>
      <td>${r.over ? `<span class="badge b-abs">${r.over}</span>` : '0'}</td></tr>`).join('') || '<tr><td colspan="7" class="note">لا توجد محاضرات في هذا الفصل</td></tr>';
  }catch(e){ $('#ovBody').innerHTML = `<tr><td colspan="7" class="note">تعذّر التحميل: ${esc(fbErr(e))}</td></tr>`; }
  $('#ovLoadBtn').disabled = false;
};
$('#ovExportBtn').onclick = () => {
  if (!ovRows.length) return toast('اعرض التقرير أولاً', 'err');
  download(`تقرير_الحضور_${App.org.term}.csv`.replace(/[\/\s]+/g, '_'), toCSV([['الكلية','القسم','المحاضرات','الساعات','نسبة الحضور %','تسجيل آلي (وجه/QR) %','طلبة تجاوزوا 10%'],
    ...ovRows.map(r => [r.college, r.dept, r.lec, r.hours, r.rate.toFixed(1), r.faceRate.toFixed(0), r.over])]), 'text/csv');
};

/* =====================================================================
   اللجنة الامتحانية: المواد (الوحدات وتوزيع الدرجات) + السعي + النهائي + الماستر شيت
   att_courses/{deptId}  : مواد القسم {courses:{id:{stage,name,code,units,sae,final,comps:[[name,max,type]]}}}
   att_grades/{id}       : جدول درجات (قسم+مادة+مرحلة+دراسة+شعبة+فصل): السعي (التدريسي) + النهائي (اللجنة)
   ===================================================================== */
const G_STATUS = {draft:['مسودة','b-gray'], submitted:['مُرسل إلى رئيس القسم','b-man'], returned:['أُعيد للتدريسي','b-abs'], approved:['مُصادق عليه','b-face']};
const G_TPL = {
  bologna:{max:50, comps:[['الاختبارات القصيرة (Quizzes)',15,'manual','cum'],['الواجبات والتقارير',10,'manual','cum'],['المشاركة والنشاط الصفي',10,'manual','cum'],['الحضور',5,'attendance','cum'],['امتحان منتصف الفصل (Mid)',10,'manual','mid']]},
  theory:{max:40, comps:[['الامتحان الشهري',20,'manual'],['الاختبارات اليومية',10,'manual'],['الواجبات والتقارير',5,'manual'],['الحضور والمشاركة',5,'attendance']]},
  lab:{max:50, comps:[['الامتحان الشهري النظري',15,'manual'],['الامتحان العملي',15,'manual'],['تقارير المختبر',10,'manual'],['الاختبارات اليومية',5,'manual'],['الحضور',5,'attendance']]},
  simple:{max:40, comps:[['الامتحان الشهري الأول',15,'manual'],['الامتحان الشهري الثاني',15,'manual'],['الاختبارات اليومية',10,'manual']]}
};
const PASS_MARK = 50;
const gradeId = (deptId, course, stage, shift, section, term) =>
  [deptId, course, stage, shift, section || 'all', term].map(x => String(x || '').trim().replace(/[\/~.#$\[\]]/g, '-')).join('~');
let G = null, gSheets = [];
const r2 = n => Math.round(n * 100) / 100;
const canEditCourses = () => is('super','dean','head','committee');
const canEditFinals = () => is('super','head','committee');
const seesFinals = () => is('super','dean','head','committee');

/* ---------- المواد ---------- */
const normComps = comps => (comps || []).map(x => Array.isArray(x) ? x : [x.n, +x.m || 0, x.t || 'manual'].concat(x.g ? [x.g] : []));
const compsStore = comps => comps.map(c => Object.assign({n:c[0], m:c[1], t:c[2] || 'manual'}, c[3] ? {g:c[3]} : {})); // Firestore لا يقبل مصفوفة داخل مصفوفة
const courseList = () => Object.entries((App.courses && App.courses.courses) || {}).map(([id, c]) => Object.assign({id}, c, {comps:normComps(c.comps)}));
const courseDef = (name, stage) => courseList().find(c => c.name.trim() === String(name || '').trim() && c.stage === stage) || null;
function parseComps(txt){
  return String(txt || '').split(/[,،\n]/).map(x => x.trim()).filter(Boolean).map(x => {
    const m = /^(.+?)\s*[:：]\s*([\d.]+)$/.exec(x); if (!m) return null;
    let name = m[1].trim(), type = 'manual'; if (name.endsWith('*')){ type = 'attendance'; name = name.slice(0, -1).trim(); }
    return [name, +m[2], type];
  });
}
const compsText = comps => (comps || []).map(c => `${c[0]}${c[2] === 'attendance' ? '*' : ''}:${c[1]}`).join('، ');
let crEditing = null, crRows = [];
const CR_DEF = {bologna:{sae:40, mid:10, final:50, rows:[['الاختبارات القصيرة (Quizzes)',15,'manual'],['الواجبات والتقارير',10,'manual'],['المشاركة والنشاط الصفي',10,'manual'],['الحضور',5,'attendance']]},
  annual:{sae:40, mid:0, final:60, rows:[['الامتحان الشهري',20,'manual'],['الاختبارات اليومية',10,'manual'],['الواجبات والتقارير',5,'manual'],['الحضور',5,'attendance']]}};
const crSys = () => (document.querySelector('input[name=crSys]:checked') || {}).value || 'bologna';
function crSysUI(){
  const b = crSys() === 'bologna';
  $('#crMidBox').classList.toggle('hidden', !b);
  $('#crSaeLbl').textContent = b ? 'درجة التراكمي' : 'درجة السعي';
  $('#crCompsLbl').textContent = b ? 'فروع التراكمي (ما يتكوّن منه التراكمي)' : 'مكوّنات السعي';
  crSumUI();
}
function crSumUI(){
  const sum = r2(crRows.reduce((a, r) => a + (+r[1] || 0), 0)), tgt = +$('#crSae').value || 0, b = crSys() === 'bologna';
  const total = tgt + (b ? +$('#crMid').value || 0 : 0) + (+$('#crFinal').value || 0);
  $('#crSum').className = 'badge ' + (sum === tgt && total === 100 ? 'b-face' : 'b-man');
  $('#crSum').textContent = `مجموع الفروع ${sum} / ${tgt}` + (total !== 100 ? ` — المجموع الكلي ${total} (يجب 100)` : sum === tgt ? ' ✓' : ' ✗');
}
function renderCrRows(){
  $('#crCompRows').innerHTML = crRows.map((r, i) => `<tr data-ci="${i}"><td><input data-k="0" value="${esc(r[0])}" placeholder="مثال: الاختبارات القصيرة"></td>
    <td><input data-k="1" type="number" min="0" max="100" step="0.5" value="${r[1]}"></td>
    <td><label style="display:flex;gap:6px;align-items:center;margin:0;font-weight:500"><input data-k="2" type="checkbox" style="width:auto" ${r[2] === 'attendance' ? 'checked' : ''}> من الحضور</label></td>
    <td><button class="btn sm light" data-crx="${i}" type="button">✕</button></td></tr>`).join('') || '<tr><td colspan="4" class="note">لا توجد فروع — اضغط «＋ إضافة فرع»</td></tr>';
  crSumUI();
}
$('#crCompRows').oninput = $('#crCompRows').onchange = e => {
  const tr = e.target.closest('tr[data-ci]'), k = e.target.dataset.k; if (!tr || k == null) return;
  const r = crRows[+tr.dataset.ci]; if (k === '2') r[2] = e.target.checked ? 'attendance' : 'manual'; else r[+k] = k === '1' ? +e.target.value : e.target.value; crSumUI();
};
$('#crCompRows').onclick = e => { const b = e.target.closest('[data-crx]'); if (b){ crRows.splice(+b.dataset.crx, 1); renderCrRows(); } };
$('#crAddComp').onclick = () => { crRows.push(['', 0, 'manual']); renderCrRows(); const ins = $$('#crCompRows input[data-k="0"]'); ins[ins.length - 1].focus(); };
['#crSae','#crMid','#crFinal'].forEach(x => $(x).oninput = crSumUI);
$$('input[name=crSys]').forEach(r => r.onchange = () => { const d = CR_DEF[crSys()]; $('#crSae').value = d.sae; $('#crMid').value = d.mid; $('#crFinal').value = d.final; crRows = d.rows.map(x => x.slice()); renderCrRows(); crSysUI(); });
function crSetSys(sys){ $$('input[name=crSys]').forEach(r => r.checked = r.value === sys); }
const sysOf = c => c.system || (c.comps || []).some(x => x[3] === 'mid') ? (c.system || 'bologna') : 'annual';
function renderCourses(){
  if (!$('#crBody')) return;
  const ed = canEditCourses();
  $('#crsForm').classList.toggle('hidden', !ed); $('#crSave').parentElement.classList.toggle('hidden', !ed);
  if (ed && !crRows.length && !crEditing){ crSetSys('bologna'); crRows = CR_DEF.bologna.rows.map(x => x.slice()); renderCrRows(); crSysUI(); }
  const d = App.dept, order = d ? d.stages : [];
  $('#crBody').innerHTML = courseList().sort((a, b) => order.indexOf(a.stage) - order.indexOf(b.stage) || a.name.localeCompare(b.name, 'ar'))
    .map(c => { const bo = sysOf(c) === 'bologna', mid = (c.comps || []).find(x => x[3] === 'mid');
      return `<tr><td>${esc(c.stage)}</td><td><b>${esc(c.name)}</b></td><td dir="ltr">${esc(c.code || '')}</td><td>${c.units}</td>
      <td><span class="badge ${bo ? 'b-vio' : 'b-qr'}">${bo ? 'بولونيا' : 'تقليدي'}</span></td>
      <td>${bo ? `تراكمي ${r2(c.sae - (mid ? mid[1] : 0))} + منتصف ${mid ? mid[1] : 0} + نهائي ${c.final}` : `سعي ${c.sae} + نهائي ${c.final}`}</td>
      <td class="note">${esc((c.comps || []).filter(x => x[3] !== 'mid').map(x => `${x[0]}${x[2] === 'attendance' ? ' (حضور)' : ''}: ${x[1]}`).join('، '))}</td>
      <td class="row">${ed ? `<button class="btn sm light" data-cre="${esc(c.id)}">تعديل</button><button class="btn sm red" data-crd="${esc(c.id)}">حذف</button>` : ''}</td></tr>`; }).join('')
    || `<tr><td colspan="8" class="note">${d ? 'لم تُضف مواد بعد' : 'اختر القسم'}</td></tr>`;
}
function renderAsgCourseList(){
  let dl = $('#crsNames'); if (!dl){ dl = document.createElement('datalist'); dl.id = 'crsNames'; document.body.appendChild(dl); }
  dl.innerHTML = [...new Set(courseList().map(c => c.name))].map(n => `<option value="${esc(n)}">`).join('');
}
$('#crClear').onclick = () => { crEditing = null; ['#crName','#crCode'].forEach(x => $(x).value = ''); $('#crNote').textContent = '';
  const sys = crSys(), d = CR_DEF[sys]; $('#crSae').value = d.sae; $('#crMid').value = d.mid; $('#crFinal').value = d.final; crRows = d.rows.map(x => x.slice()); renderCrRows(); crSysUI(); };
$('#crSave').onclick = () => {
  const d = App.dept; if (!d) return toast('اختر القسم أولاً', 'err');
  const sys = crSys(), bo = sys === 'bologna', name = $('#crName').value.trim(), stage = $('#crStage').value, units = +$('#crUnits').value;
  const cum = +$('#crSae').value || 0, mid = bo ? +$('#crMid').value || 0 : 0, fin = +$('#crFinal').value || 0;
  if (!name) return toast('اكتب اسم المادة', 'err');
  if (cum + mid + fin !== 100) return toast(`المجموع الكلي يجب أن يكون 100 (الحالي ${cum + mid + fin})`, 'err');
  const rows = crRows.map(r => [String(r[0] || '').trim(), +r[1] || 0, r[2] === 'attendance' ? 'attendance' : 'manual']);
  if (rows.some(r => !r[0])) return toast('اكتب اسم كل فرع', 'err');
  const sum = r2(rows.reduce((a, r) => a + r[1], 0));
  if (rows.length && sum !== cum) return toast(`مجموع ${bo ? 'فروع التراكمي' : 'مكوّنات السعي'} ${sum} لا يساوي ${cum}`, 'err');
  const dup = courseList().find(c => c.name === name && c.stage === stage && c.id !== crEditing);
  if (dup) return toast('المادة موجودة مسبقاً في هذه المرحلة', 'err');
  const comps = (rows.length ? rows : [[bo ? 'التراكمي' : 'السعي', cum, 'manual']]).map(r => bo ? r.concat('cum') : r);
  if (bo && mid) comps.push(['امتحان منتصف الفصل (Mid)', mid, 'manual', 'mid']);
  const id = crEditing || ('k' + Date.now().toString(36));
  bg(DB.set('att_courses', d.id, {collegeId:d.collegeId, deptId:d.id, updatedAt:nowISO(),
    courses:{[id]:{stage, name, code:$('#crCode').value.trim(), units, system:sys, cum, mid, sae:r2(cum + mid), final:fin, comps:compsStore(comps)}}}, true).p, crEditing ? 'تم تعديل المادة' : 'تمت إضافة المادة');
  audit(crEditing ? 'تعديل مادة' : 'إضافة مادة', `${name} — ${stage} — ${bo ? 'بولونيا' : 'تقليدي'}`);
  $('#crClear').onclick();
};
$('#crBody').onclick = async e => {
  const b = e.target.closest('button'); if (!b || !App.dept) return;
  if (b.dataset.cre){
    const c = courseList().find(x => x.id === b.dataset.cre); crEditing = c.id;
    const bo = sysOf(c) === 'bologna', mid = (c.comps || []).find(x => x[3] === 'mid');
    crSetSys(bo ? 'bologna' : 'annual');
    $('#crStage').value = c.stage; $('#crName').value = c.name; $('#crCode').value = c.code || ''; $('#crUnits').value = c.units;
    $('#crSae').value = r2(c.sae - (mid ? mid[1] : 0)); $('#crMid').value = mid ? mid[1] : 0; $('#crFinal').value = c.final;
    crRows = (c.comps || []).filter(x => x[3] !== 'mid').map(x => [x[0], x[1], x[2]]); renderCrRows(); crSysUI();
    $('#crNote').textContent = 'تعديل: ' + c.name; $('#crName').focus();
  }
  if (b.dataset.crd && await confirmBox('حذف المادة', 'ستُحذف المادة من قائمة مواد القسم. جداول الدرجات المحفوظة لا تُحذف.', 'حذف'))
    bg(DB.update('att_courses', App.dept.id, {[`courses.${b.dataset.crd}`]:DEL, updatedAt:nowISO()}).p);
};

/* ---------- جداول الدرجات ---------- */
function gTargets(){
  const out = [], seen = new Set(), d = App.dept; if (!d || !App.org) return out;
  const add = (t, label) => { const id = gradeId(d.id, t.course, t.stage, t.shift, t.section, App.org.term); if (seen.has(id)) return; seen.add(id); out.push(Object.assign({id, label}, t)); };
  (App.user.assignments || []).filter(a => a.deptId === d.id).forEach(a => add(a, `📘 ${a.course} — ${a.stage} / ${a.shift} / ${a.section || 'كل الشعب'}`));
  gSheets.forEach(g => add(g, `📄 ${g.course} — ${g.stage} / ${g.shift} / ${g.section || 'كل الشعب'} — ${g.instructorName || ''}`));
  return out;
}
function renderGradesTab(){
  if (!is('super','dean','head','committee','instructor')) return;
  $('#gTerm').textContent = App.org ? App.org.term : '';
  const t = gTargets(), cur = $('#gSel').value;
  $('#gSel').innerHTML = t.map(x => `<option value="${esc(x.id)}">${esc(x.label)}</option>`).join('') || '<option value="">لا توجد جداول — المواد تُسند للتدريسي من تبويب المستخدمين</option>';
  if (t.some(x => x.id === cur)) $('#gSel').value = cur;
  const mgr = is('super','dean','head','committee');
  $('#gListBox').classList.toggle('hidden', !mgr); $('#gRefreshBtn').classList.toggle('hidden', !mgr);
  $('#masterCard').classList.toggle('hidden', !seesFinals());
  $('#gListBody').innerHTML = gSheets.map(g => { const st = G_STATUS[g.status] || G_STATUS.draft;
    return `<tr><td>${esc(g.course)}</td><td>${esc(g.stage)} / ${esc(g.shift)} / ${esc(g.section || 'الكل')}</td><td>${esc(g.instructorName || '')}</td><td>${g.maxTotal}</td>
      <td><span class="badge ${st[1]}">${st[0]}</span>${g.finals && Object.keys(g.finals).length ? ' <span class="badge b-qr">النهائي مُدخل</span>' : ''}</td><td><button class="btn sm light" data-gopen="${esc(g.id)}">فتح</button></td></tr>`; }).join('')
    || '<tr><td colspan="6" class="note">لم يُنشئ التدريسيون جداول درجات في هذا القسم بعد</td></tr>';
}
async function loadGradeSheets(){
  gSheets = [];
  const d = App.dept;
  if (d && App.org && is('super','dean','head','committee')){
    const f = is('dean') ? [['collegeId', d.collegeId], ['deptId', d.id], ['term', App.org.term]] : [['deptId', d.id], ['term', App.org.term]];
    try{ gSheets = await DB.query('att_grades', f); }catch(e){ toast('تعذّر تحميل جداول الدرجات: ' + fbErr(e), 'err'); }
  }
  renderGradesTab(); renderCourses();
}
$('#gRefreshBtn').onclick = loadGradeSheets;
$('#gListBody').onclick = e => { const b = e.target.closest('button[data-gopen]'); if (b){ $('#gSel').value = b.dataset.gopen; openGrades(); } };
$('#gOpenBtn').onclick = () => openGrades();
const compObj = (c, i, p) => Object.assign({id:p + (i + 1), name:c[0], max:c[1], type:c[2]}, c[3] ? {group:c[3]} : {});
const defComponents = def => def.comps.map((c, i) => compObj(c, i, 'k'));
async function openGrades(){
  const id = $('#gSel').value, t = gTargets().find(x => x.id === id); if (!t) return;
  const d = App.dept;
  if (G && (G.dirty || G.finDirty) && !(await confirmBox('تعديلات غير محفوظة', 'توجد تعديلات لم تُحفظ في الجدول المفتوح. هل تريد تركها؟', 'ترك'))) return;
  let doc = null;
  try{ doc = await DB.get('att_grades', id); }catch(e){ return toast('تعذّر الفتح: ' + fbErr(e), 'err'); }
  const isNew = !doc, def = courseDef(t.course, t.stage);
  if (!doc){
    if (!is('instructor','head','super','dean')) return toast('لم يُنشئ التدريسي جدول هذه المادة بعد', 'err');
    const tp = G_TPL.theory;
    doc = {collegeId:d.collegeId, deptId:d.id, deptName:d.name, term:App.org.term, course:t.course, stage:t.stage, shift:t.shift, section:t.section || '',
      instructorUid:App.user.uid, instructorName:App.user.name || App.user.email || '', maxTotal:tp.max, finalMax:100 - tp.max,
      components:tp.comps.map((c, i) => compObj(c, i, 'c')), marks:{}, overrides:{}, finals:{}, status:'draft', createdAt:nowISO()};
  }
  // تطبيق توزيع اللجنة الامتحانية على الجداول غير المُرسلة
  if (def && ['draft','returned'].includes(doc.status) && def.comps && def.comps.length){
    const nc = defComponents(def);
    if (JSON.stringify(nc) !== JSON.stringify(doc.components) || doc.maxTotal !== def.sae){ doc.components = nc; doc.maxTotal = def.sae; if (!isNew) toast('طُبّق توزيع درجات اللجنة الامتحانية على هذا الجدول', 'ok'); }
  }
  if (def){ doc.finalMax = def.final; doc.units = def.units; doc.courseId = def.id; }
  if (doc.finalMax == null) doc.finalMax = 100 - doc.maxTotal;
  let pack = null;
  try{ pack = await DB.get('att_packs', packId(d.id, doc.stage, doc.shift)); }catch(e){}
  const roster = Object.entries((pack && pack.students) || {}).filter(([, s]) => !doc.section || s.s === doc.section)
    .map(([sid, s]) => ({id:sid, name:s.n, u:s.u || ''})).sort((a, b) => a.name.localeCompare(b.name, 'ar'));
  G = {id, doc, def, roster, dirty:isNew, finDirty:false, isNew};
  doc.marks = doc.marks || {}; doc.overrides = doc.overrides || {}; doc.finals = doc.finals || {};
  $('#gDistCard').classList.remove('hidden'); $('#gSheetCard').classList.remove('hidden');
  renderDist(); renderSheet();
  if (isNew) toast(def ? 'جدول جديد بتوزيع اللجنة الامتحانية — احفظه بعد إدخال الدرجات' : 'جدول جديد — راجع توزيع الدرجات ثم احفظه', 'ok');
}
const gCanEdit = () => G && (is('super','dean','head') || (G.doc.instructorUid === App.user.uid && ['draft','returned'].includes(G.doc.status)));
const gCanEditDist = () => gCanEdit() && (!G.def || !(G.def.comps || []).length || is('super','dean','head'));
function renderDist(){
  const doc = G.doc, ed = gCanEditDist(), st = G_STATUS[doc.status] || G_STATUS.draft;
  $('#gTitle').textContent = `${doc.course} — ${doc.stage} / ${doc.shift} / ${doc.section || 'كل الشعب'} — ${doc.instructorName || ''}`;
  $('#gStatus').textContent = st[0]; $('#gStatus').className = 'badge ' + st[1];
  $('#gMax').value = doc.maxTotal; $('#gMax').disabled = !ed;
  $$('#gDistCard [data-tpl], #gAddComp, #gSaveDist').forEach(b => { b.disabled = !ed; b.classList.toggle('hidden', !ed); });
  $('#gCompBody').innerHTML = doc.components.map((c, i) => `<tr data-ci="${i}">
    <td><input data-cf="name" value="${esc(c.name)}" ${ed ? '' : 'disabled'}></td>
    <td><input data-cf="max" type="number" min="0" step="0.5" value="${c.max}" style="width:90px" ${ed ? '' : 'disabled'}></td>
    <td><select data-cf="type" ${ed ? '' : 'disabled'}><option value="manual" ${c.type !== 'attendance' ? 'selected' : ''}>يدوي</option><option value="attendance" ${c.type === 'attendance' ? 'selected' : ''}>الحضور (تلقائي)</option></select></td>
    <td>${ed ? `<button class="btn sm red" data-crm="${i}">✕</button>` : ''}</td></tr>`).join('');
  distSumNote();
  if (G.def && (G.def.comps || []).length && !ed){ $('#gSumNote').textContent = `🔒 التوزيع محدد من اللجنة الامتحانية — السعي ${G.def.sae} + النهائي ${G.def.final} — ${G.def.units} وحدات`; $('#gSumNote').style.color = 'var(--navy)'; }
}
function distSumNote(){
  const sum = r2(G.doc.components.reduce((a, c) => a + (+c.max || 0), 0)), max = +G.doc.maxTotal || 0;
  $('#gSumNote').textContent = sum === max ? `✓ مجموع المكوّنات ${sum} = مجموع السعي` : `⚠ مجموع المكوّنات ${sum} ≠ مجموع السعي ${max}`;
  $('#gSumNote').style.color = sum === max ? 'var(--green)' : 'var(--red)';
  return sum === max;
}
$('#gCompBody').oninput = $('#gCompBody').onchange = e => {
  const tr = e.target.closest('tr[data-ci]'), f = e.target.dataset.cf; if (!tr || !f) return;
  const c = G.doc.components[+tr.dataset.ci]; c[f] = f === 'max' ? +e.target.value : e.target.value; G.dirty = true; distSumNote();
  if (e.type === 'change') renderSheet();
};
$('#gCompBody').onclick = e => { const b = e.target.closest('button[data-crm]'); if (!b) return; G.doc.components.splice(+b.dataset.crm, 1); G.dirty = true; renderDist(); renderSheet(); };
$('#gMax').oninput = () => { if (G){ G.doc.maxTotal = +$('#gMax').value; G.doc.finalMax = 100 - G.doc.maxTotal; G.dirty = true; distSumNote(); } };
$('#gAddComp').onclick = () => { const n = G.doc.components.length + 1; let id = 'c' + n; while (G.doc.components.some(c => c.id === id)) id += 'x';
  G.doc.components.push({id, name:'مكوّن جديد', max:0, type:'manual'}); G.dirty = true; renderDist(); renderSheet(); };
$$('#gDistCard [data-tpl]').forEach(b => b.onclick = async () => {
  const tp = G_TPL[b.dataset.tpl]; if (!G) return;
  if (Object.keys(G.doc.marks).length && !(await confirmBox('تطبيق قالب', 'توجد درجات مُدخلة. تغيير المكوّنات قد يمسح درجات المكوّنات المحذوفة. هل تريد المتابعة؟', 'تطبيق'))) return;
  G.doc.maxTotal = tp.max; G.doc.finalMax = 100 - tp.max; G.doc.components = tp.comps.map((c, i) => compObj(c, i, 'c')); G.dirty = true; renderDist(); renderSheet();
});
$('#gSaveDist').onclick = () => { if (!distSumNote()) return toast('يجب أن يساوي مجموع المكوّنات مجموع السعي', 'err'); saveGrades('تم حفظ التوزيع'); };
// نسبة حضور الطالب في هذه المادة من سجلات المحاضرات (بالساعات)
function attendanceRatio(sid, doc){
  doc = doc || G.doc;
  const ss = App.sessions.filter(s => s.deptId === doc.deptId && s.course === doc.course && s.stage === doc.stage && s.shift === doc.shift &&
    (!doc.section || !s.section || s.section === doc.section) && s.term === doc.term);
  let held = 0, abs = 0;
  ss.forEach(s => { const inS = (s.absentees || []).includes(sid) || (s.present || []).some(p => p.id === sid); if (!inS) return;
    held += +s.hours || 0; if ((s.absentees || []).includes(sid)) abs += +s.hours || 0; });
  return held ? {ratio:(held - abs) / held, held, abs} : null;
}
function cellValue(sid, c){
  const ov = (G.doc.overrides[sid] || {})[c.id];
  if (c.type === 'attendance' && ov == null){ const a = attendanceRatio(sid); return a ? r2(c.max * a.ratio) : ''; }
  if (c.type === 'attendance') return ov;
  const v = (G.doc.marks[sid] || {})[c.id]; return v == null ? '' : v;
}
function studentTotal(sid){ return r2(G.doc.components.reduce((a, c) => { const v = cellValue(sid, c); return a + (v === '' ? 0 : +v); }, 0)); }
const finalOf = (doc, sid) => { const v = (doc.finals || {})[sid]; return v == null || v === '' ? null : +v; };
const finalOf2 = (doc, sid) => { const v = (doc.finals2 || {})[sid]; return v == null || v === '' ? null : +v; };
function resultCell(sae, fin, fin2, dep){
  if (dep) return '<span class="badge b-dep">محروم</span>';
  if (fin2 != null) return r2(sae + fin2) >= PASS_MARK ? '<span class="badge b-face">ناجح (دور ثانٍ)</span>' : '<span class="badge b-abs">راسب</span>';
  if (fin == null) return '<span class="note">—</span>';
  return r2(sae + fin) >= PASS_MARK ? '<span class="badge b-face">ناجح</span>' : '<span class="badge b-abs">راسب — دور ثانٍ</span>';
}
const shownTotal = (sae, fin, fin2, dep) => dep ? '—' : fin2 != null ? r2(sae + fin2) : fin != null ? r2(sae + fin) : '—';
function renderSheet(){
  if (!G) return;
  const doc = G.doc, ed = gCanEdit(), sf = seesFinals(), ef = canEditFinals();
  $('#gHead').innerHTML = `<tr><th>#</th><th>الرقم</th><th>الاسم</th>${doc.components.map(c => `<th>${c.group ? `<span class="grp-tag ${c.group}">${c.group === 'mid' ? 'منتصف الفصل' : 'تراكمي'}</span><br>` : ''}${esc(c.name)}<div class="note">(${c.max})${c.type === 'attendance' ? ' تلقائي' : ''}</div></th>`).join('')}<th>الحضور %</th><th>السعي<div class="note">(${doc.maxTotal})</div></th>
    ${sf ? `<th style="background:#e6eef7">النهائي<div class="note">(${doc.finalMax})</div></th><th style="background:#e6eef7">الدور الثاني<div class="note">(${doc.finalMax})</div></th><th style="background:#e6eef7">الدرجة النهائية<div class="note">(100)</div></th><th style="background:#e6eef7">النتيجة</th>` : ''}</tr>`;
  $('#gBody').innerHTML = G.roster.map((st, i) => {
    const a = attendanceRatio(st.id), sae = studentTotal(st.id), fin = finalOf(doc, st.id), fin2 = finalOf2(doc, st.id);
    const dep = courseStatus(st.id, doc.course, doc.stage, doc.shift) === 'dep';
    const r2ok = ef && !dep && (fin2 != null || (fin != null && sae + fin < PASS_MARK));
    return `<tr data-sid="${esc(st.id)}" data-dep="${dep ? 1 : ''}"><td>${i + 1}</td><td>${esc(st.id)}</td><td>${esc(st.name)}${dep ? ' <span class="badge b-dep">محروم</span>' : ''}</td>${doc.components.map(c => {
      const v = cellValue(st.id, c), auto = c.type === 'attendance' && ((G.doc.overrides[st.id] || {})[c.id] == null);
      return `<td><input data-c="${esc(c.id)}" type="number" min="0" max="${c.max}" step="0.25" value="${v}" class="${auto ? 'auto' : ''} ${v !== '' && (+v > c.max || +v < 0) ? 'bad' : ''}" ${ed ? '' : 'disabled'} title="${auto ? 'محسوب من الحضور — اكتب قيمة لتعديله يدوياً' : ''}"></td>`; }).join('')}
      <td class="note">${a ? Math.round(a.ratio * 100) + '%' : '—'}</td><td class="tot">${sae}</td>
      ${sf ? `<td><input data-fin="1" type="number" min="0" max="${doc.finalMax}" step="0.25" value="${fin == null ? '' : fin}" ${ef && !dep ? '' : 'disabled'} class="${fin != null && (fin > doc.finalMax || fin < 0) ? 'bad' : ''}"></td>
        <td><input data-fin2="1" type="number" min="0" max="${doc.finalMax}" step="0.25" value="${fin2 == null ? '' : fin2}" ${r2ok ? '' : 'disabled'}></td>
        <td class="tot fin">${shownTotal(sae, fin, fin2, dep)}</td><td class="res">${resultCell(sae, fin, fin2, dep)}</td>` : ''}</tr>`;
  }).join('') || `<tr><td colspan="${doc.components.length + 8}" class="note">لا يوجد طلبة في هذه المرحلة/الشعبة</td></tr>`;
  $('#gCount').textContent = `${G.roster.length} طالب`;
  const st = doc.status, mine = doc.instructorUid === App.user.uid, mgr = is('super','dean','head');
  $('#gSave').classList.toggle('hidden', !(ed || ef));
  $('#gSave').textContent = ed ? '💾 حفظ الدرجات' : '💾 حفظ درجات النهائي';
  $('#gSubmit').classList.toggle('hidden', !(mine && ['draft','returned'].includes(st)));
  $('#gApprove').classList.toggle('hidden', !(mgr && st === 'submitted'));
  $('#gReturn').classList.toggle('hidden', !(mgr && ['submitted','approved'].includes(st)));
  $('#gPublish').classList.toggle('hidden', !(mgr && st === 'approved'));
  $('#gNote').textContent = (st === 'approved' ? '✓ السعي مُصادق عليه من رئيس القسم.' : st === 'submitted' ? 'أُرسل السعي إلى رئيس القسم، ولا يمكن للتدريسي تعديله إلا إذا أُعيد إليه.'
    : st === 'returned' ? '↩ أعاده رئيس القسم للتعديل' + (doc.returnNote ? ': ' + doc.returnNote : '') + '.' : 'يُحفظ الجدول تلقائياً كل ٢٠ ثانية عند وجود تعديلات.')
    + (sf ? ' — درجة النهائي تُدخلها اللجنة الامتحانية، والنجاح ' + PASS_MARK + ' فأكثر.' : '');
}
$('#gBody').oninput = e => {
  const inp = e.target.closest('input'); if (!inp || !G) return;
  const tr = inp.closest('tr'), sid = tr.dataset.sid, raw = inp.value.trim();
  if (inp.dataset.fin || inp.dataset.fin2){
    const m = inp.dataset.fin2 ? (G.doc.finals2 = G.doc.finals2 || {}) : G.doc.finals;
    if (raw === '') delete m[sid]; else m[sid] = +raw;
    inp.classList.toggle('bad', raw !== '' && (+raw > G.doc.finalMax || +raw < 0)); G.finDirty = true;
    if (inp.dataset.fin){ const f2 = tr.querySelector('input[data-fin2]'), s0 = studentTotal(sid);
      if (f2 && canEditFinals() && !tr.dataset.dep) f2.disabled = !(finalOf2(G.doc, sid) != null || (raw !== '' && s0 + +raw < PASS_MARK)); }
  } else {
    const cid = inp.dataset.c, c = G.doc.components.find(x => x.id === cid);
    const tgt = c.type === 'attendance' ? G.doc.overrides : G.doc.marks;
    tgt[sid] = tgt[sid] || {};
    if (raw === '') delete tgt[sid][cid]; else tgt[sid][cid] = +raw;
    inp.classList.toggle('bad', raw !== '' && (+raw > c.max || +raw < 0)); inp.classList.remove('auto');
    tr.querySelector('td.tot').textContent = studentTotal(sid); G.dirty = true;
  }
  const fin = finalOf(G.doc, sid), fin2 = finalOf2(G.doc, sid), sae = studentTotal(sid), dep = !!tr.dataset.dep;
  if (tr.querySelector('td.fin')){ tr.querySelector('td.fin').textContent = shownTotal(sae, fin, fin2, dep); tr.querySelector('td.res').innerHTML = resultCell(sae, fin, fin2, dep); }
};
$('#gBody').onkeydown = e => {
  if (!['Enter','ArrowDown','ArrowUp'].includes(e.key)) return;
  const inp = e.target.closest('input'); if (!inp) return; e.preventDefault();
  const sel = inp.dataset.fin ? 'input[data-fin]' : inp.dataset.fin2 ? 'input[data-fin2]' : `input[data-c="${inp.dataset.c}"]`;
  const tr = e.key === 'ArrowUp' ? inp.closest('tr').previousElementSibling : inp.closest('tr').nextElementSibling;
  const nx = tr && tr.querySelector(sel); if (nx){ nx.focus(); nx.select(); }
};
function gValidate(){
  const bad = [];
  G.roster.forEach(st => { G.doc.components.forEach(c => { const v = cellValue(st.id, c); if (v !== '' && (+v > c.max || +v < 0)) bad.push(`${st.name}: ${c.name}`); });
    const f = finalOf(G.doc, st.id); if (f != null && (f > G.doc.finalMax || f < 0)) bad.push(`${st.name}: النهائي`);
    const f2 = finalOf2(G.doc, st.id); if (f2 != null && (f2 > G.doc.finalMax || f2 < 0)) bad.push(`${st.name}: الدور الثاني`); });
  return bad;
}
function sheetSummary(){
  G.doc.names = Object.fromEntries(G.roster.map(s => [s.id, s.name]));
  G.doc.totals = Object.fromEntries(G.roster.map(s => [s.id, studentTotal(s.id)]));
}
function saveGrades(msg, extra){
  if (!G) return;
  const bad = gValidate();
  if (bad.length) return toast('درجات خارج الحد المسموح: ' + bad.slice(0, 3).join('، ') + (bad.length > 3 ? '…' : ''), 'err');
  const ed = gCanEdit(), ef = canEditFinals();
  if (!ed && ef) return saveFinals(msg);
  sheetSummary();
  Object.assign(G.doc, extra || {}, {updatedAt:nowISO(), updatedBy:App.user.uid});
  const {id, ...data} = G.doc;
  if (G.isNew) bg(DB.set('att_grades', G.id, data).p, msg || 'تم حفظ الدرجات');
  else {
    const fields = ['maxTotal','finalMax','units','courseId','components','marks','overrides','names','totals','status','updatedAt','updatedBy','submittedAt','approvedAt','approvedBy','returnNote'];
    if (ef) fields.push('finals', 'finals2');
    const patch = {}; fields.forEach(k => { if (data[k] !== undefined) patch[k] = data[k]; });
    bg(DB.update('att_grades', G.id, patch).p, msg || 'تم حفظ الدرجات');
  }
  G.dirty = false; if (ef) G.finDirty = false; G.isNew = false; renderDist(); renderSheet(); syncSheetList(data);
}
function saveFinals(msg){
  if (!G || G.isNew) return toast('لم يُنشئ التدريسي هذا الجدول بعد', 'err');
  sheetSummary();
  bg(DB.update('att_grades', G.id, {finals:G.doc.finals, finals2:G.doc.finals2 || {}, totals:G.doc.totals, names:G.doc.names, finalsAt:nowISO(), finalsBy:App.user.uid}).p, msg || 'تم حفظ درجات النهائي');
  if (msg !== null) audit('حفظ درجات النهائي', `${G.doc.course} — ${G.doc.stage} / ${G.doc.shift}`, G.doc.deptId);
  G.finDirty = false; syncSheetList(G.doc);
}
function syncSheetList(data){
  const i = gSheets.findIndex(x => x.id === G.id), rec = Object.assign({}, data, {id:G.id});
  if (i >= 0) gSheets[i] = rec; else if (is('super','dean','head','committee')) gSheets.push(rec);
  renderGradesTab();
}
$('#gSave').onclick = () => {
  if (gCanEdit() && !distSumNote()) return toast('صحّح توزيع الدرجات أولاً: مجموع المكوّنات لا يساوي مجموع السعي', 'err');
  saveGrades(); if (gCanEdit()) audit('حفظ درجات السعي', `${G.doc.course} — ${G.doc.stage} / ${G.doc.shift}`, G.doc.deptId);
};
setInterval(() => {
  if (!G || G.isNew || gValidate().length) return;
  if (G.dirty && gCanEdit() && distSumNote()) saveGrades(null);
  else if (G.finDirty && canEditFinals() && !gCanEdit()) saveFinals(null);
}, 20000);
$('#gSubmit').onclick = async () => {
  if (!distSumNote()) return toast('صحّح توزيع الدرجات أولاً', 'err');
  const empty = G.roster.filter(st => G.doc.components.some(c => cellValue(st.id, c) === '')).length;
  if (!(await confirmBox('إرسال إلى رئيس القسم', (empty ? `⚠ يوجد ${empty} طالب لديه خانات فارغة (تُحسب صفراً). ` : '') + 'بعد الإرسال لا يمكنك التعديل إلا إذا أعاده رئيس القسم.', 'إرسال'))) return;
  saveGrades('أُرسل السعي إلى رئيس القسم', {status:'submitted', submittedAt:nowISO()}); audit('إرسال السعي إلى رئيس القسم', `${G.doc.course} — ${G.doc.stage} / ${G.doc.shift}`, G.doc.deptId);
};
$('#gApprove').onclick = async () => {
  if (!(await confirmBox('مصادقة السعي', 'ستُعتمد درجات السعي لهذه المادة.', 'مصادقة'))) return;
  saveGrades('تمت المصادقة ✓', {status:'approved', approvedAt:nowISO(), approvedBy:App.user.name || App.user.uid}); audit('مصادقة السعي', `${G.doc.course} — ${G.doc.stage} / ${G.doc.shift}`, G.doc.deptId);
};
$('#gReturn').onclick = async () => {
  if (!(await confirmBox('إعادة إلى التدريسي', 'سيُعاد السعي إلى التدريسي ليعدّله ثم يرسله مجدداً.', 'إعادة'))) return;
  saveGrades('أُعيد إلى التدريسي', {status:'returned', returnNote:''}); audit('إعادة السعي إلى التدريسي', `${G.doc.course} — ${G.doc.stage} / ${G.doc.shift}`, G.doc.deptId);
};
$('#gExport').onclick = () => {
  if (!G || !needXLSX()) return;
  const doc = G.doc, sf = seesFinals();
  const rows = [['جامعة السراج — ' + (sf ? 'درجات المادة' : 'درجات السعي')], ['القسم', doc.deptName || deptName(doc.deptId), 'المادة', doc.course, 'المرحلة', doc.stage, 'الدراسة', doc.shift, 'الشعبة', doc.section || 'الكل'],
    ['التدريسي', doc.instructorName || '', 'الفصل', doc.term, 'الوحدات', doc.units || '', 'الحالة', (G_STATUS[doc.status] || G_STATUS.draft)[0]], [],
    ['ت', 'الرقم الجامعي', 'الاسم', ...doc.components.map(c => `${c.name} (${c.max})`), 'نسبة الحضور %', `السعي (${doc.maxTotal})`, ...(sf ? [`النهائي (${doc.finalMax})`, 'الدور الثاني', 'الدرجة النهائية (100)', 'النتيجة'] : [])]];
  G.roster.forEach((st, i) => { const a = attendanceRatio(st.id), sae = studentTotal(st.id), fin = finalOf(doc, st.id), fin2 = finalOf2(doc, st.id);
    const dep = courseStatus(st.id, doc.course, doc.stage, doc.shift) === 'dep', tot = shownTotal(sae, fin, fin2, dep);
    const res = dep ? 'محروم' : fin2 != null ? (sae + fin2 >= PASS_MARK ? 'ناجح (دور ثانٍ)' : 'راسب') : fin == null ? '' : (sae + fin >= PASS_MARK ? 'ناجح' : 'راسب — دور ثانٍ');
    rows.push([i + 1, st.id, st.name, ...doc.components.map(c => { const v = cellValue(st.id, c); return v === '' ? '' : +v; }), a ? Math.round(a.ratio * 100) : '', sae,
      ...(sf ? [fin == null ? '' : fin, fin2 == null ? '' : fin2, tot === '—' ? '' : tot, res] : [])]); });
  const ws = XLSX.utils.aoa_to_sheet(rows); ws['!cols'] = [{wch:5},{wch:14},{wch:30}, ...doc.components.map(() => ({wch:14})), {wch:12},{wch:12},{wch:12},{wch:14},{wch:10}];
  const wb = XLSX.utils.book_new(); wb.Workbook = {Views:[{RTL:true}]}; XLSX.utils.book_append_sheet(wb, ws, 'الدرجات');
  XLSX.writeFile(wb, `درجات_${doc.course}_${doc.stage}_${doc.shift}${doc.section ? '_' + doc.section : ''}.xlsx`.replace(/[\/\\:*?"<>|]/g, '-'));
};

/* ---------- الماستر شيت ---------- */
let msData = null;
$('#msShow').onclick = async () => {
  const d = App.dept, stage = $('#msStage').value, shift = $('#msShift').value; if (!d) return;
  $('#msShow').disabled = true;
  try{
    const f = is('dean') ? [['collegeId', d.collegeId], ['deptId', d.id], ['term', App.org.term], ['stage', stage], ['shift', shift]] : [['deptId', d.id], ['term', App.org.term], ['stage', stage], ['shift', shift]];
    const [sheets, pack] = await Promise.all([DB.query('att_grades', f), DB.get('att_packs', packId(d.id, stage, shift)).catch(() => null)]);
    const defs = courseList().filter(c => c.stage === stage);
    const names = new Set([...defs.map(c => c.name), ...sheets.map(s => s.course)]);
    const courses = [...names].map(n => { const def = defs.find(c => c.name === n) || {}; return {name:n, units:+def.units || 0, code:def.code || ''}; })
      .sort((a, b) => a.name.localeCompare(b.name, 'ar'));
    const studs = Object.entries((pack && pack.students) || {}).map(([sid, s]) => ({id:sid, name:s.n, section:s.s})).sort((a, b) => a.name.localeCompare(b.name, 'ar'));
    const grade = {}; // grade[sid][course] = {sae, fin, total}
    sheets.forEach(sh => Object.keys(sh.totals || {}).forEach(sid => {
      const sae = +(sh.totals || {})[sid] || 0, fin = sh.finals && sh.finals[sid] != null ? +sh.finals[sid] : null, fin2 = sh.finals2 && sh.finals2[sid] != null ? +sh.finals2[sid] : null;
      const dep = courseStatus(sid, sh.course, sh.stage, sh.shift) === 'dep';
      (grade[sid] = grade[sid] || {})[sh.course] = {sae, fin, fin2, dep, total:dep ? 0 : fin2 != null ? r2(sae + fin2) : fin == null ? null : r2(sae + fin)};
    }));
    msData = {stage, shift, courses, studs, grade};
    renderMaster();
  }catch(e){ toast('تعذّر تحميل الماستر شيت: ' + fbErr(e), 'err'); }
  $('#msShow').disabled = false;
};
function masterRow(st){
  const g = msData.grade[st.id] || {}; let wSum = 0, uSum = 0, fails = 0, missing = 0;
  const cells = msData.courses.map(c => { const x = g[c.name];
    if (!x || x.total == null){ missing++; return null; }
    if (x.dep){ fails++; if (c.units) uSum += c.units; return 'محروم'; }
    if (x.total < PASS_MARK) fails++; if (c.units){ wSum += x.total * c.units; uSum += c.units; } return x.total + (x.fin2 != null ? ' (د٢)' : ''); });
  const avg = uSum ? r2(wSum / uSum) : null;
  const res = missing ? 'غير مكتمل' : fails === 0 ? 'ناجح' : fails <= 2 ? `مكمل (${fails})` : `راسب (${fails})`;
  return {cells, avg, res, fails, missing};
}
function renderMaster(){
  if (!msData) return;
  const {courses, studs} = msData;
  $('#msHead').innerHTML = `<tr><th>#</th><th>الرقم</th><th>الاسم</th>${courses.map(c => `<th>${esc(c.name)}<div class="note">${c.units ? c.units + ' وحدات' : 'وحدات؟'}</div></th>`).join('')}<th>المعدل</th><th>النتيجة</th></tr>`;
  $('#msBody').innerHTML = studs.map((st, i) => { const r = masterRow(st);
    return `<tr><td>${i + 1}</td><td>${esc(st.id)}</td><td>${esc(st.name)}</td>${r.cells.map(v => `<td style="${v === 'محروم' || (v != null && parseFloat(v) < PASS_MARK) ? 'color:var(--red);font-weight:700' : ''}">${v == null ? '<span class="note">—</span>' : esc(v)}</td>`).join('')}
      <td class="tot">${r.avg == null ? '—' : r.avg}</td><td><span class="badge ${r.missing ? 'b-gray' : r.fails ? 'b-abs' : 'b-face'}">${r.res}</span></td></tr>`; }).join('')
    || `<tr><td colspan="${courses.length + 5}" class="note">لا يوجد طلبة</td></tr>`;
}
$('#msExport').onclick = () => {
  if (!msData) return toast('اعرض الماستر شيت أولاً', 'err');
  if (!needXLSX()) return;
  const d = App.dept, {courses, studs} = msData;
  const rows = [['جامعة السراج — الماستر شيت'], ['القسم', d.name, 'المرحلة', msData.stage, 'الدراسة', msData.shift, 'الفصل', App.org.term], [],
    ['ت', 'الرقم الجامعي', 'الاسم', ...courses.map(c => `${c.name} (${c.units || '?'} و)`), 'المعدل', 'النتيجة']];
  studs.forEach((st, i) => { const r = masterRow(st); rows.push([i + 1, st.id, st.name, ...r.cells.map(v => v == null ? '' : v), r.avg == null ? '' : r.avg, r.res]); });
  const ws = XLSX.utils.aoa_to_sheet(rows); ws['!cols'] = [{wch:5},{wch:14},{wch:30}, ...courses.map(() => ({wch:14})), {wch:10},{wch:14}];
  const wb = XLSX.utils.book_new(); wb.Workbook = {Views:[{RTL:true}]}; XLSX.utils.book_append_sheet(wb, ws, 'الماستر شيت');
  XLSX.writeFile(wb, `ماستر_${d.id}_${msData.stage}_${msData.shift}.xlsx`);
};

/* =====================================================================
   الإضافات: سجل التعديلات، نسب الغياب والإنذارات والحرمان، الأعذار،
   الجدول الأسبوعي، لوحة ضمان الجودة، الترحيل، نشر النتائج، تجهيز دون اتصال
   ===================================================================== */
const sanitizeId = x => String(x || '').trim().replace(/[\/~.#$\[\]]/g, '-');
const DAYS = ['الأحد','الاثنين','الثلاثاء','الأربعاء','الخميس','الجمعة','السبت'];
const ST_LABEL = {ok:['منتظم','b-face'], w1:['إنذار أول','b-w1'], w2:['إنذار ثانٍ','b-w2'], dep:['محروم','b-dep']};
const ymd = d => { const x = new Date(d); x.setMinutes(x.getMinutes() - x.getTimezoneOffset()); return x.toISOString().slice(0, 10); };

/* ---------- سجل التعديلات ---------- */
function audit(action, details, deptId){
  try{
    if (!App.user) return;
    const d = deptList().find(x => x.id === (deptId || (App.dept && App.dept.id))) || App.dept || {};
    DB.set('att_audit', null, {at:TS, atISO:nowISO(), uid:App.user.uid, name:App.user.name || App.user.email || '', role:App.user.role,
      action, details:String(details || '').slice(0, 500), deptId:d.id || '', collegeId:d.collegeId || '', term:(App.org && App.org.term) || ''}).p.catch(e => console.warn('audit', e));
  }catch(e){ console.warn('audit', e); }
}

/* ---------- نسب الغياب (يحددها رئيس القسم) ---------- */
const DEFAULT_POLICY = {w1:5, w2:8, dep:10, depT:15};
const getPolicy = c => Object.assign({}, DEFAULT_POLICY, ((c || App.courses) || {}).policy || {});
function renderPolicy(){
  const p = getPolicy();
  $('#pW1').value = p.w1; $('#pW2').value = p.w2; $('#pDep').value = p.dep; $('#pDepT').value = p.depT;
  $('#pNote').textContent = (App.courses && App.courses.policy) ? 'النسب الحالية معتمدة للقسم.' : 'النسب الافتراضية — احفظها لاعتمادها.';
}
$('#pSave').onclick = () => {
  const d = App.dept; if (!d) return;
  const p = {w1:+$('#pW1').value, w2:+$('#pW2').value, dep:+$('#pDep').value, depT:+$('#pDepT').value};
  if (!(p.w1 > 0 && p.w1 < p.w2 && p.w2 < p.dep && p.dep <= p.depT)) return toast('يجب أن تكون: الإنذار الأول < الإنذار الثاني < الحرمان ≤ الحرمان الكلي', 'err');
  bg(DB.set('att_courses', d.id, {collegeId:d.collegeId, deptId:d.id, policy:p, updatedAt:nowISO()}, true).p, 'تم اعتماد نسب الغياب');
  audit('تعديل نسب الغياب', `إنذار أول ${p.w1}% — ثانٍ ${p.w2}% — حرمان ${p.dep}% — كلي ${p.depT}%`);
};
const statusOf = (pu, pt, p) => (pu >= p.dep || pt >= p.depT) ? 'dep' : pu >= p.w2 ? 'w2' : pu >= p.w1 ? 'w1' : 'ok';

/* ---------- محرك احتساب الغياب ---------- */
App.excuses = [];
async function loadApprovedExcuses(){
  App.excuses = [];
  const d = App.dept; if (!d || !App.org || is('registrar')) return;
  try{
    const f = is('dean') ? [['collegeId', d.collegeId], ['deptId', d.id], ['term', App.org.term], ['status', 'approved']]
      : [['deptId', d.id], ['term', App.org.term], ['status', 'approved']];
    App.excuses = await DB.query('att_excuses', f);
  }catch(e){ console.warn('excuses', e); }
  renderWarnings();
}
const excusedFor = (list, sid, date, course) => list.some(x => x.sid === sid && x.status === 'approved' && date >= x.from && date <= x.to && (!x.course || x.course === course));
// صفوف (طالب × مادة) مع ساعات الغياب والعذر والحالة
function absenceRowsFrom(sessions, excuses, policyOf){
  const groups = {};
  sessions.forEach(s => {
    const k = [s.deptId, s.course, s.stage, s.shift].join('|');
    const g = groups[k] = groups[k] || {deptId:s.deptId, collegeId:s.collegeId, course:s.course, stage:s.stage, shift:s.shift, st:{}, names:{}};
    Object.assign(g.names, s.names || {});
    const h = +s.hours || 0;
    (s.present || []).forEach(p => { const r = g.st[p.id] = g.st[p.id] || {held:0, abs:0, exc:0}; r.held += h; });
    (s.absentees || []).forEach(id => { const r = g.st[id] = g.st[id] || {held:0, abs:0, exc:0}; r.held += h; r.abs += h; if (excusedFor(excuses, id, s.date, s.course)) r.exc += h; });
  });
  const rows = [];
  Object.values(groups).forEach(g => {
    const p = policyOf(g.deptId);
    Object.entries(g.st).forEach(([sid, r]) => {
      const pu = r.held ? (r.abs - r.exc) / r.held * 100 : 0, pt = r.held ? r.abs / r.held * 100 : 0;
      rows.push({deptId:g.deptId, collegeId:g.collegeId, course:g.course, stage:g.stage, shift:g.shift, sid, name:g.names[sid] || sid,
        held:r.held, abs:r.abs, exc:r.exc, pu, pt, status:statusOf(pu, pt, p)});
    });
  });
  return rows;
}
const deptAbsenceRows = () => App.org ? absenceRowsFrom(App.sessions.filter(s => s.term === App.org.term && (!App.dept || s.deptId === App.dept.id)), App.excuses, () => getPolicy()) : [];
function courseStatus(sid, course, stage, shift){
  const r = deptAbsenceRows().find(x => x.sid === sid && x.course === course && x.stage === stage && x.shift === shift);
  return r ? r.status : 'ok';
}

/* ---------- الإنذارات والحرمان + الكتب ---------- */
let warnRows = [];
$('#wFilter').onchange = () => renderWarnings();
function renderWarnings(){
  if (!$('#wBody') || !App.user || !is('super','dean','head','committee','qa','instructor')) return;
  const f = $('#wFilter').value, ord = {dep:0, w2:1, w1:2};
  warnRows = deptAbsenceRows().filter(r => r.status !== 'ok' && (!f || r.status === f)).sort((a, b) => ord[a.status] - ord[b.status] || b.pu - a.pu);
  $('#wBody').innerHTML = warnRows.map((r, i) => `<tr><td>${esc(r.sid)}</td><td>${esc(r.name)}</td><td>${esc(r.course)}</td><td>${esc(r.stage)} / ${esc(r.shift)}</td>
    <td>${r.held}</td><td>${r.abs}</td><td>${r.exc}</td><td>${r.pu.toFixed(1)}%</td><td>${r.pt.toFixed(1)}%</td>
    <td><span class="badge ${ST_LABEL[r.status][1]}">${ST_LABEL[r.status][0]}</span></td><td><button class="btn sm light" data-letter="${i}">🖨 كتاب</button></td></tr>`).join('')
    || '<tr><td colspan="11" class="note">لا يوجد طلبة تجاوزوا نسب الغياب ✓</td></tr>';
}
$('#wBody').onclick = e => { const b = e.target.closest('button[data-letter]'); if (b) printLetters([warnRows[+b.dataset.letter]]); };
$('#wLetters').onclick = () => { if (!warnRows.length) return toast('لا توجد حالات', 'err'); printLetters(warnRows); };
$('#wExport').onclick = () => {
  if (!needXLSX() || !warnRows.length) return toast('لا توجد حالات', 'err');
  const ws = XLSX.utils.aoa_to_sheet([['الرقم','الاسم','المادة','المرحلة','الدراسة','الساعات المنعقدة','ساعات الغياب','بعذر','بدون عذر %','الكلي %','الحالة'],
    ...warnRows.map(r => [r.sid, r.name, r.course, r.stage, r.shift, r.held, r.abs, r.exc, +r.pu.toFixed(1), +r.pt.toFixed(1), ST_LABEL[r.status][0]])]);
  const wb = XLSX.utils.book_new(); wb.Workbook = {Views:[{RTL:true}]}; XLSX.utils.book_append_sheet(wb, ws, 'الإنذارات');
  XLSX.writeFile(wb, `الإنذارات_والحرمان_${App.dept.id}.xlsx`);
};
function printLetters(rows){
  const d = App.dept, p = getPolicy(), college = collegeName(d.collegeId), today = new Date().toLocaleDateString('ar-IQ');
  const title = {w1:'إنذار أول بالغياب', w2:'إنذار ثانٍ (نهائي) بالغياب', dep:'قرار حرمان من دخول الامتحان النهائي'};
  const body = r => r.status === 'dep'
    ? `نظراً لتجاوز نسبة غيابك في مادة <b>${esc(r.course)}</b> الحد المسموح به (${p.dep}% بدون عذر أو ${p.depT}% كلياً)، إذ بلغت نسبة غيابك بدون عذر <b>${r.pu.toFixed(1)}%</b> ونسبة غيابك الكلي <b>${r.pt.toFixed(1)}%</b>، تقرر حرمانك من دخول الامتحان النهائي لهذه المادة وفق التعليمات النافذة.`
    : `نود إعلامك بأن نسبة غيابك بدون عذر في مادة <b>${esc(r.course)}</b> بلغت <b>${r.pu.toFixed(1)}%</b> من الساعات المنعقدة. ويُوجَّه إليك هذا ${r.status === 'w1' ? 'الإنذار الأول' : 'الإنذار الثاني والنهائي'}، علماً أن تجاوز نسبة ${p.dep}% يؤدي إلى الحرمان من دخول الامتحان النهائي.`;
  const pages = rows.map(r => `<div class="pg"><div class="hd"><div>جامعة السراج<br>${esc(college)}<br>${esc(d.name)}</div><div style="text-align:left">العدد: ........<br>التاريخ: ${today}</div></div>
    <h2>${title[r.status] || ''}</h2>
    <p>إلى الطالب/ة: <b>${esc(r.name)}</b> — الرقم الجامعي: <b>${esc(r.sid)}</b><br>المرحلة: ${esc(r.stage)} — الدراسة: ${esc(r.shift)} — الفصل: ${esc(App.org.term)}</p>
    <p class="b">${body(r)}</p>
    <table><tr><th>الساعات المنعقدة</th><th>ساعات الغياب</th><th>منها بعذر</th><th>بدون عذر</th><th>النسبة بدون عذر</th></tr>
    <tr><td>${r.held}</td><td>${r.abs}</td><td>${r.exc}</td><td>${r.abs - r.exc}</td><td>${r.pu.toFixed(1)}%</td></tr></table>
    <div class="sig"><div>توقيع الطالب<br><br>..................</div><div>رئيس القسم<br><br>..................</div></div></div>`).join('');
  download(`كتب_الغياب_${d.id}_${today.replace(/\//g, '-')}.html`, `<!DOCTYPE html><html lang="ar" dir="rtl"><head><meta charset="utf-8"><title>كتب الإنذار والحرمان</title>
<style>body{font-family:Tahoma,Arial,sans-serif;margin:0}.pg{padding:18mm;min-height:250mm;page-break-after:always;font-size:13pt;line-height:2}
.hd{display:flex;justify-content:space-between;border-bottom:2px solid #14324f;padding-bottom:6mm;font-weight:bold}h2{text-align:center;color:#14324f;margin:10mm 0}
.b{text-align:justify}table{width:100%;border-collapse:collapse;margin:8mm 0}th,td{border:1px solid #555;padding:6px;text-align:center}
.sig{display:flex;justify-content:space-between;margin-top:20mm;text-align:center}</style></head><body>${pages}<script>print()<\/script></body></html>`, 'text/html');
  audit('طباعة كتب غياب', `${rows.length} كتاب`);
}

/* ---------- الأعذار (رئيس القسم) ---------- */
let exList = [];
$('#exFilter').onchange = () => renderExcuses();
$('#exRefresh').onclick = () => loadExcuseList();
async function loadExcuseList(){
  const d = App.dept; if (!d || !is('super','dean','head')) return;
  try{
    const f = is('dean') ? [['collegeId', d.collegeId], ['deptId', d.id], ['term', App.org.term]] : [['deptId', d.id], ['term', App.org.term]];
    exList = (await DB.query('att_excuses', f)).sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
  }catch(e){ toast('تعذّر تحميل الأعذار: ' + fbErr(e), 'err'); }
  renderExcuses();
}
function renderExcuses(){
  const f = $('#exFilter').value, lab = {pending:['بانتظار القرار','b-man'], approved:['مقبول','b-face'], rejected:['مرفوض','b-abs']};
  $('#exBody').innerHTML = exList.filter(x => !f || x.status === f).map(x => `<tr><td>${esc(x.name || '')} <span class="note" dir="ltr">${esc(x.sid)}</span></td>
    <td>${esc(x.stage)} / ${esc(x.shift)}</td><td>${esc(x.course || 'كل المواد')}</td><td>${esc(x.from)}</td><td>${esc(x.to)}</td><td>${esc(x.reason || '')}</td>
    <td>${x.hasImg ? `<button class="btn sm light" data-eximg="${esc(x.id)}">🖼 عرض</button>` : '—'}</td>
    <td><span class="badge ${(lab[x.status] || lab.pending)[1]}">${(lab[x.status] || lab.pending)[0]}</span></td>
    <td class="row">${x.status !== 'approved' ? `<button class="btn sm green" data-exok="${esc(x.id)}">قبول</button>` : ''}${x.status !== 'rejected' ? `<button class="btn sm red" data-exno="${esc(x.id)}">رفض</button>` : ''}</td></tr>`).join('')
    || '<tr><td colspan="9" class="note">لا توجد أعذار</td></tr>';
}
$('#exBody').onclick = async e => {
  const b = e.target.closest('button'); if (!b) return;
  if (b.dataset.eximg){
    try{ const im = await DB.get('att_excuse_img', b.dataset.eximg);
      $('#spotBody').innerHTML = im ? `<img src="${esc(im.img)}" style="max-width:100%;border-radius:10px">` : '<p class="note">لا توجد صورة</p>';
      $('#spotAgain').classList.add('hidden'); $('#spotModal').classList.add('show'); }catch(err){ toast('تعذّر تحميل الصورة: ' + fbErr(err), 'err'); }
  }
  const id = b.dataset.exok || b.dataset.exno; if (!id) return;
  const x = exList.find(y => y.id === id), status = b.dataset.exok ? 'approved' : 'rejected';
  await DB.update('att_excuses', id, {status, decidedBy:App.user.name || App.user.uid, decidedAt:nowISO()}).p.catch(err => toast('تعذّر: ' + fbErr(err), 'err'));
  x.status = status; renderExcuses(); loadApprovedExcuses();
  if (x.uid) notify([{u:x.uid, sid:x.sid}], {t:status === 'approved' ? 'exc_ok' : 'exc_no', title:status === 'approved' ? '✅ قُبل عذرك' : '⛔ رُفض عذرك',
    body:`${x.course || 'كل المواد'} — ${x.from} إلى ${x.to}${status === 'approved' ? ' — لن يُحتسب غياباً بلا عذر' : ' — راجع رئيس القسم'}`}, {id:x.deptId, collegeId:x.collegeId});
  audit(status === 'approved' ? 'قبول عذر' : 'رفض عذر', `${x.name || x.sid} — ${x.course || 'كل المواد'} — ${x.from} إلى ${x.to}`);
  toast(status === 'approved' ? 'قُبل العذر — أعيد احتساب الغياب' : 'رُفض العذر', status === 'approved' ? 'ok' : 'err');
};

/* ---------- الجدول الأسبوعي ---------- */
App.schedule = null;
const schedId = () => App.dept && App.org ? sanitizeId(App.dept.id) + '~' + sanitizeId(App.org.term) : null;
function subSchedule(){
  unsub('schedule'); App.schedule = null;
  const id = schedId(); if (!id) return;
  App.subs.schedule = DB.listenDoc('att_schedule', id, doc => { App.schedule = doc; renderSchedule(); renderToday(); }, e => console.warn('schedule', e));
}
const slotList = () => Object.entries((App.schedule && App.schedule.slots) || {}).map(([id, s]) => Object.assign({id}, s));
const dayOrder = d => (d + 1) % 7; // السبت أولاً
let scEditing = null;
function fillInstrSelect(){
  const d = App.dept; if (!d) return;
  const list = App.users.filter(u => ['instructor','head','dean'].includes(normRole(u.role)) && ((u.deptIds || []).includes(d.id) || normRole(u.role) === 'dean'));
  if (App.user && !list.some(u => u.id === App.user.uid) && is('head','dean','super')) list.unshift({id:App.user.uid, name:App.user.name || App.user.email});
  $('#scInstr').innerHTML = list.map(u => `<option value="${esc(u.id)}">${esc(u.name)}</option>`).join('') || '<option value="">لا يوجد تدريسيون</option>';
}
function renderSchedule(){
  if (!$('#scBody') || !App.user) return;
  if (is('super','dean','head')){ fillInstrSelect(); fillScCourses(); }
  const ed = is('super','dean','head');
  const list = slotList().filter(s => !is('instructor') || s.instr === App.user.uid).sort((a, b) => dayOrder(a.day) - dayOrder(b.day) || a.from.localeCompare(b.from));
  $('#scBody').innerHTML = list.map(s => `<tr><td>${DAYS[s.day]}</td><td dir="ltr" style="text-align:right">${esc(s.from)} – ${esc(s.to)}</td><td>${esc(s.course)}</td>
    <td>${esc(s.stage)} / ${esc(s.shift)} / ${esc(s.section || 'الكل')}</td><td>${esc(s.type || '')}</td><td>${esc(s.instrName || '')}</td><td>${esc(s.room || '')}</td>
    <td class="row">${ed ? `<button class="btn sm light" data-sce="${esc(s.id)}">تعديل</button><button class="btn sm red" data-scd="${esc(s.id)}">حذف</button>` : ''}</td></tr>`).join('')
    || `<tr><td colspan="8" class="note">${App.dept ? 'لا توجد محاضرات في الجدول' : 'اختر القسم'}</td></tr>`;
}
const hoursBetween = (a, b) => { const [h1, m1] = a.split(':').map(Number), [h2, m2] = b.split(':').map(Number); return Math.max(1, Math.round(((h2 * 60 + m2) - (h1 * 60 + m1)) / 60)); };
$('#scClear').onclick = () => { scEditing = null; fillScCourses(''); $('#scRoom').value = ''; $('#scNote').textContent = ''; };
$('#scAdd').onclick = () => {
  const d = App.dept, id = schedId(); if (!d || !id) return;
  const s = {day:+$('#scDay').value, from:$('#scFrom').value, to:$('#scTo').value, course:$('#scCourse').value.trim(), stage:$('#scStage').value, shift:$('#scShift').value,
    section:$('#scSection').value, type:$('#scType').value, instr:$('#scInstr').value, instrName:($('#scInstr').selectedOptions[0] || {}).textContent || '', room:$('#scRoom').value.trim()};
  if (!s.course) return toast('اختر المادة من القائمة', 'err');
  if (!s.from || !s.to || s.to <= s.from) return toast('أكمل الوقت بشكل صحيح', 'err');
  s.hours = hoursBetween(s.from, s.to);
  const sid = scEditing || ('s' + Date.now().toString(36));
  bg(DB.set('att_schedule', id, {deptId:d.id, collegeId:d.collegeId, term:App.org.term, updatedAt:nowISO(), slots:{[sid]:s}}, true).p, scEditing ? 'تم التعديل' : 'أُضيفت المحاضرة');
  audit(scEditing ? 'تعديل الجدول الأسبوعي' : 'إضافة إلى الجدول الأسبوعي', `${DAYS[s.day]} ${s.from} — ${s.course} — ${s.instrName}`);
  $('#scClear').onclick();
};
$('#scBody').onclick = async e => {
  const b = e.target.closest('button'); if (!b) return;
  if (b.dataset.sce){ const s = slotList().find(x => x.id === b.dataset.sce); scEditing = s.id;
    $('#scDay').value = s.day; $('#scFrom').value = s.from; $('#scTo').value = s.to; $('#scStage').value = s.stage; $('#scShift').value = s.shift; fillScCourses(s.course);
    $('#scSection').value = s.section || ''; $('#scType').value = s.type || 'نظري'; $('#scInstr').value = s.instr; $('#scRoom').value = s.room || ''; $('#scNote').textContent = 'تعديل: ' + s.course; }
  if (b.dataset.scd && await confirmBox('حذف من الجدول', 'ستُحذف هذه المحاضرة من الجدول الأسبوعي.', 'حذف')){
    bg(DB.update('att_schedule', schedId(), {[`slots.${b.dataset.scd}`]:DEL, updatedAt:nowISO()}).p); audit('حذف من الجدول الأسبوعي', b.dataset.scd); }
};
$('#scExport').onclick = () => {
  if (!needXLSX()) return;
  const rows = slotList().sort((a, b) => dayOrder(a.day) - dayOrder(b.day) || a.from.localeCompare(b.from)).map(s => [DAYS[s.day], s.from, s.to, s.course, s.stage, s.shift, s.section || 'الكل', s.type, s.instrName, s.room]);
  const ws = XLSX.utils.aoa_to_sheet([['اليوم','من','إلى','المادة','المرحلة','الدراسة','الشعبة','النوع','التدريسي','القاعة'], ...rows]);
  const wb = XLSX.utils.book_new(); wb.Workbook = {Views:[{RTL:true}]}; XLSX.utils.book_append_sheet(wb, ws, 'الجدول'); XLSX.writeFile(wb, `الجدول_الأسبوعي_${App.dept.id}.xlsx`);
};
// محاضرات اليوم للتدريسي: ضغطة تملأ بيانات المحاضرة
function renderToday(){
  if (!$('#todayList') || !App.user) return;
  const dow = new Date().getDay();
  const list = slotList().filter(s => s.day === dow && (s.instr === App.user.uid || is('head','dean','super') && !slotList().some(x => x.instr === App.user.uid))).sort((a, b) => a.from.localeCompare(b.from));
  const doneToday = s => App.sessions.some(x => x.date === today() && x.course === s.course && x.stage === s.stage && x.shift === s.shift && (!s.section || !x.section || x.section === s.section));
  const asg = myAsg(), inSched = a => list.some(s => s.course === a.course && s.stage === a.stage && s.shift === a.shift && (s.section || '') === (a.section || ''));
  const rest = asg.map((a, i) => ({a, i})).filter(x => !inSched(x.a));
  $('#todayList').innerHTML = (list.map(s => `<button class="chip" data-today="${esc(s.id)}"><b>${esc(s.from)}</b> — ${esc(s.course)}<br><span class="note">${esc(s.stage)} / ${esc(s.shift)} / ${esc(s.section || 'الكل')} — ${esc(s.room || '')}</span> ${doneToday(s) ? '<span class="badge b-face">✓ سُجّل</span>' : ''}</button>`).join('')
    || `<span class="note">${asg.length ? 'لا توجد محاضرات لك اليوم في الجدول الأسبوعي (أو الجدول غير مكتمل) — اختر المادة من موادك:' : 'لا توجد محاضرات لك اليوم في الجدول الأسبوعي.'}</span>`)
    + (rest.length ? `<div style="width:100%"><div class="note" style="margin-top:6px">${list.length ? 'موادك الأخرى:' : ''}</div><div class="asg-chips">${rest.map(({a, i}) => `<button class="chip" data-asgi="${i}">📘 <b>${esc(a.course)}</b><br><span class="note">${esc(a.stage)} / ${esc(a.shift)} / ${esc(a.section || 'كل الشعب')}</span></button>`).join('')}</div></div>` : '');
}
$('#todayList').onclick = e => {
  const ai = e.target.closest('button[data-asgi]');
  if (ai){ $('#cAsg').value = ai.dataset.asgi; applyAsg(); const def = courseDef(myAsg()[+ai.dataset.asgi].course, myAsg()[+ai.dataset.asgi].stage);
    $('#cDate').value = today(); pastUI(); $('#sessionSetup').scrollIntoView({behavior:'smooth'}); toast('تم اختيار المادة — اختر طريقة التسجيل واضغط بدء', 'ok'); return; }
  const b = e.target.closest('button[data-today]'); if (!b) return;
  const s = slotList().find(x => x.id === b.dataset.today); if (!s) return;
  if (!$('#cAsgBox').classList.contains('hidden')){
    const i = myAsg().findIndex(a => a.course === s.course && a.stage === s.stage && a.shift === s.shift && (a.section || '') === (s.section || ''));
    if (i < 0) return toast('هذه المحاضرة غير مسندة إليك في حسابك — راجع رئيس القسم', 'err');
    $('#cAsg').value = i; applyAsg();
  } else { $('#cName').value = s.course; $('#cStage').value = s.stage; $('#cShift').value = s.shift; $('#cSection').value = s.section || ''; }
  $('#cType').value = s.type || 'نظري'; $('#cHours').value = s.hours || 2; $('#cDate').value = today(); pastUI();
  toast('تم ملء بيانات المحاضرة — اختر طريقة التسجيل واضغط بدء', 'ok');
};
// المحاضرات المجدولة التي لم يُسجَّل حضورها
function scheduledOccurrences(slots, sessions, from, to){
  const out = []; if (!from) return out;
  const start = new Date(from + 'T00:00:00'), end = new Date(to + 'T00:00:00');
  for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)){
    const date = ymd(d), dow = d.getDay();
    slots.filter(s => s.day === dow).forEach(s => out.push(Object.assign({date, done:sessions.some(x => x.date === date && x.deptId === s.deptId && x.course === s.course && x.stage === s.stage && x.shift === s.shift && (!s.section || !x.section || x.section === s.section))}, s)));
  }
  return out;
}
function renderMissing(){
  const start = App.org && App.org.termStart;
  if (!start){ $('#missBody').innerHTML = '<tr><td colspan="6" class="note">حدّد "بداية الفصل" من تبويب الهيكل التنظيمي (مدير النظام)</td></tr>'; return; }
  const y = new Date(); y.setDate(y.getDate() - 1);
  const occ = scheduledOccurrences(slotList().map(s => Object.assign({deptId:App.dept.id}, s)), App.sessions, start, ymd(y)).filter(o => !o.done && (!is('instructor') || o.instr === App.user.uid))
    .sort((a, b) => b.date.localeCompare(a.date));
  $('#missBody').innerHTML = occ.slice(0, 400).map(o => `<tr><td>${o.date}</td><td>${DAYS[o.day]}</td><td>${esc(o.course)}</td><td>${esc(o.stage)} / ${esc(o.shift)} / ${esc(o.section || 'الكل')}</td><td>${esc(o.instrName || '')}</td>
    <td>${is('instructor') && o.instr === App.user.uid ? `<button class="btn sm" data-miss="${esc(JSON.stringify({date:o.date, course:o.course, stage:o.stage, shift:o.shift, section:o.section || '', type:o.type, hours:o.hours}))}">✎ تسجيل الحضور يدوياً</button>` : ''}</td></tr>`).join('')
    || '<tr><td colspan="6" class="note">✓ كل المحاضرات المجدولة سُجّل حضورها</td></tr>';
}
$('#msgMissing').onclick = renderMissing;

/* ---------- تجهيز الجهاز للعمل دون اتصال ---------- */
$('#prefetchBtn').onclick = async () => {
  if (!navigator.onLine && App.mode !== 'local') return toast('التجهيز يحتاج اتصالاً بالإنترنت', 'err');
  const out = $('#prefetchOut'); out.innerHTML = '⏳ جارٍ التجهيز...';
  const targets = [];
  if (is('instructor')) (App.user.assignments || []).forEach(a => targets.push({deptId:a.deptId, stage:a.stage, shift:a.shift, label:a.course}));
  else { const d = App.dept; if (d) d.stages.forEach(st => d.shifts.forEach(sh => targets.push({deptId:d.id, stage:st, shift:sh, label:`${st} / ${sh}`}))); }
  const seen = new Set(), lines = [];
  for (const t of targets){
    const pid = packId(t.deptId, t.stage, t.shift); if (seen.has(pid)) continue; seen.add(pid);
    try{ const p = await DB.get('att_packs', pid); const n = Object.keys((p && p.students) || {}).length, f = Object.values((p && p.students) || {}).filter(s => (s.p || []).length).length;
      lines.push(`✓ ${esc(deptName(t.deptId))} — ${esc(t.stage)} / ${esc(t.shift)}: ${n} طالب، ${f} ببصمة`); }
    catch(e){ lines.push(`✗ ${esc(t.stage)} / ${esc(t.shift)}: ${esc(fbErr(e))}`); }
  }
  if (!modelsReady){ lines.push('⏳ تحميل نماذج الوجه...'); out.innerHTML = lines.join('<br>'); await loadModels(); lines.pop(); }
  lines.push(modelsReady ? '✓ نماذج الوجه محفوظة على الجهاز' : '✗ لم تكتمل نماذج الوجه');
  out.innerHTML = lines.join('<br>') + '<br><b>الجهاز جاهز للعمل دون اتصال.</b>';
};

/* ---------- ترحيل الطلبة ---------- */
function fillPromoTo(){
  const d = App.dept; if (!d) return;
  const i = d.stages.indexOf($('#prFrom').value), next = d.stages.slice(i + 1);
  $('#prTo').innerHTML = next.map(s => `<option value="${esc(s)}">${esc(s)}</option>`).join('') + '<option value="__grad">🎓 تخرّج</option>';
}
$('#prFrom').onchange = fillPromoTo;
$('#prRun').onclick = async () => {
  const d = App.dept; if (!d) return;
  const from = $('#prFrom').value, shift = $('#prShift').value, to = $('#prTo').value;
  const src = Object.values(App.packs).find(p => p.stage === from && p.shift === shift);
  const studs = Object.entries((src && src.students) || {});
  if (!studs.length) return toast('لا يوجد طلبة في هذه المرحلة', 'err');
  const tgt = to === '__grad' ? null : Object.values(App.packs).find(p => p.stage === to && p.shift === shift);
  const clash = tgt ? studs.filter(([sid]) => (tgt.students || {})[sid]).length : 0;
  if (!(await confirmBox('ترحيل الطلبة', `سيُنقل ${studs.length} طالب من المرحلة ${from} (${shift}) إلى ${to === '__grad' ? 'التخرّج (حذف من القوائم)' : 'المرحلة ' + to}.` + (clash ? ` ⚠ ${clash} منهم موجودون مسبقاً في المرحلة الهدف.` : '') + (tgt && Object.keys(tgt.students || {}).length ? ' ⚠ المرحلة الهدف فيها طلبة حالياً — رحّل المراحل الأعلى أولاً.' : ''), 'ترحيل'))) return;
  if (to !== '__grad') bg(DB.set('att_packs', packId(d.id, to, shift), {collegeId:d.collegeId, deptId:d.id, stage:to, shift, updatedAt:nowISO(), students:Object.fromEntries(studs)}, true).p);
  bg(DB.update('att_packs', src.id, Object.assign({updatedAt:nowISO()}, Object.fromEntries(studs.map(([sid]) => [`students.${sid}`, DEL])))).p);
  studs.forEach(([, s]) => { if (s.u) bg(DB.update('att_stu', s.u, to === '__grad' ? {graduated:true} : {stage:to}).p); });
  audit('ترحيل الطلبة', `${studs.length} طالب: ${from} (${shift}) ← ${to === '__grad' ? 'تخرّج' : to}`);
  toast(`تم ترحيل ${studs.length} طالب`, 'ok');
};

/* ---------- نشر النتائج للطلبة ---------- */
$('#gPublish').onclick = async () => {
  if (!G) return;
  const doc = G.doc;
  if (!(await confirmBox('نشر النتائج', `سيرى كل طالب في حسابه درجة السعي${Object.keys(doc.finals || {}).length ? ' والنهائي والنتيجة' : ''} لمادة ${doc.course}.`, 'نشر'))) return;
  G.roster.forEach(st => {
    const sae = studentTotal(st.id), fin = finalOf(doc, st.id), fin2 = finalOf2(doc, st.id), dep = courseStatus(st.id, doc.course, doc.stage, doc.shift) === 'dep';
    const total = dep ? null : fin2 != null ? r2(sae + fin2) : fin != null ? r2(sae + fin) : null;
    const result = dep ? 'محروم' : total == null ? '' : total >= PASS_MARK ? (fin2 != null ? 'ناجح (دور ثانٍ)' : 'ناجح') : (fin2 != null ? 'راسب' : 'راسب (دور ثانٍ)');
    bg(DB.set('att_results', [doc.deptId, doc.term, st.id].map(sanitizeId).join('~'), {sid:st.id, deptId:doc.deptId, collegeId:doc.collegeId, term:doc.term, stage:doc.stage, shift:doc.shift,
      updatedAt:nowISO(), courses:{[sanitizeId(doc.course)]:{name:doc.course, units:doc.units || null, sae, saeMax:doc.maxTotal, final:fin, final2:fin2, finalMax:doc.finalMax, total, result, at:nowISO()}}}, true).p);
  });
  audit('نشر النتائج للطلبة', `${doc.course} — ${doc.stage} / ${doc.shift} — ${G.roster.length} طالب`);
  notify(G.roster.map(st => ({u:st.u, sid:st.id})), {t:'res', title:`🎓 نُشرت نتيجة ${doc.course}`, body:'اضغط لعرض درجتك في «درجاتي»'}, {id:doc.deptId, collegeId:doc.collegeId});
  toast('نُشرت النتائج للطلبة ✓', 'ok');
};

/* ---------- لوحة ضمان الجودة ---------- */
let qaData = null;
function renderQAOptions(){
  if (!$('#qaCollege') || !App.org) return;
  $('#qaTerm').textContent = App.org.term;
  const cols = Object.entries(App.org.colleges || {});
  if (is('super','qa')) $('#qaCollege').innerHTML = '<option value="*">كل الجامعة</option>' + cols.map(([id, c]) => `<option value="${esc(id)}">${esc(c.name)}</option>`).join('');
  else if (is('dean')) $('#qaCollege').innerHTML = `<option value="${esc(App.user.collegeId)}">${esc(collegeName(App.user.collegeId))}</option>`;
  else $('#qaCollege').innerHTML = `<option value="dept">${esc(App.dept ? App.dept.name : 'القسم المختار')}</option>`;
}
$('#qaLoad').onclick = async () => {
  const T = App.org.term, c = $('#qaCollege').value, d = App.dept;
  const scope = c === 'dept' ? [['deptId', d.id]] : c === '*' ? [] : [['collegeId', c]];
  $('#qaLoad').disabled = true; $('#qaKpi').innerHTML = '<span class="note">جارٍ التحميل...</span>';
  try{
    const [sessions, sheets, schedules, courseDocs, excuses] = await Promise.all([
      DB.query('att_sessions', [...scope, ['term', T]]), DB.query('att_grades', [...scope, ['term', T]]),
      DB.query('att_schedule', [...scope, ['term', T]]), c === 'dept' ? DB.get('att_courses', d.id).then(x => x ? [x] : []) : DB.query('att_courses', scope),
      DB.query('att_excuses', [...scope, ['term', T], ['status', 'approved']])]);
    const pol = {}; courseDocs.forEach(x => pol[x.deptId || x.id] = getPolicy(x));
    const rows = absenceRowsFrom(sessions, excuses, dep => pol[dep] || DEFAULT_POLICY);
    const y = new Date(); y.setDate(y.getDate() - 1);
    const occ = scheduledOccurrences([].concat(...schedules.map(sc => Object.entries(sc.slots || {}).map(([id, s]) => Object.assign({id, deptId:sc.deptId, collegeId:sc.collegeId}, s)))),
      sessions, App.org.termStart, ymd(y));
    const per = {};
    const D = k => per[k] = per[k] || {deptId:k, lec:0, P:0, A:0, occ:0, done:0, warn:new Set(), dep:new Set(), sheets:0, appr:0, pass:0, graded:0};
    sessions.forEach(s => { const o = D(s.deptId); o.lec++; o.P += (s.present || []).length; o.A += (s.absentees || []).length; o.collegeId = s.collegeId; });
    occ.forEach(x => { const o = D(x.deptId); o.occ++; if (x.done) o.done++; o.collegeId = o.collegeId || x.collegeId; });
    rows.forEach(r => { const o = D(r.deptId); if (r.status === 'dep') o.dep.add(r.sid); else if (r.status !== 'ok') o.warn.add(r.sid); });
    const courseRows = [];
    sheets.forEach(sh => { const o = D(sh.deptId); o.collegeId = o.collegeId || sh.collegeId; o.sheets++; if (sh.status === 'approved') o.appr++;
      let n = 0, pass = 0, fail = 0, depN = 0;
      Object.keys(sh.totals || {}).forEach(sid => { n++;
        const dep = rows.some(r => r.sid === sid && r.deptId === sh.deptId && r.course === sh.course && r.stage === sh.stage && r.shift === sh.shift && r.status === 'dep');
        const f2 = (sh.finals2 || {})[sid], f1 = (sh.finals || {})[sid], f = f2 != null ? f2 : f1;
        if (dep){ depN++; return; } if (f == null) return; (+sh.totals[sid] + +f >= PASS_MARK) ? pass++ : fail++; });
      o.pass += pass; o.graded += pass + fail + depN;
      courseRows.push({deptId:sh.deptId, course:sh.course, stage:sh.stage, shift:sh.shift, n, pass, fail, dep:depN, rate:(pass + fail + depN) ? pass / (pass + fail + depN) * 100 : null}); });
    const instr = {};
    occ.forEach(x => { const o = instr[x.instr] = instr[x.instr] || {name:x.instrName, deptId:x.deptId, occ:0, done:0, P:0, A:0}; o.occ++; if (x.done) o.done++; });
    sessions.forEach(s => { const o = instr[s.instructorUid] = instr[s.instructorUid] || {name:s.instructorName, deptId:s.deptId, occ:0, done:0, P:0, A:0}; o.P += (s.present || []).length; o.A += (s.absentees || []).length; });
    qaData = {per:Object.values(per), courseRows, instr:Object.values(instr), sessions:sessions.length};
    renderQA();
  }catch(e){ console.error(e); $('#qaKpi').innerHTML = `<span class="note">تعذّر التحميل: ${esc(fbErr(e))}</span>`; }
  $('#qaLoad').disabled = false;
};
const pct = (a, b) => b ? (a / b * 100) : null;
const pctTxt = v => v == null ? '—' : v.toFixed(1) + '%';
const pctBadge = (v, good = 90, mid = 75) => v == null ? '—' : `<span class="badge ${v >= good ? 'b-face' : v >= mid ? 'b-man' : 'b-abs'}">${v.toFixed(1)}%</span>`;
function renderQA(){
  const q = qaData; if (!q) return;
  const sum = k => q.per.reduce((a, o) => a + (typeof o[k] === 'number' ? o[k] : o[k].size), 0);
  const kpis = [['المحاضرات المسجّلة', q.sessions], ['نسبة الحضور', pctTxt(pct(sum('P'), sum('P') + sum('A')))], ['الالتزام بتسجيل الحضور', pctTxt(pct(sum('done'), sum('occ')))],
    ['طلبة بإنذار', sum('warn')], ['محرومون', sum('dep')], ['جداول سعي مُصادقة', `${sum('appr')} / ${sum('sheets')}`], ['نسبة النجاح', pctTxt(pct(sum('pass'), sum('graded')))]];
  $('#qaKpi').innerHTML = kpis.map(([l, v]) => `<div class="stat"><b>${v}</b>${l}</div>`).join('');
  $('#qaDeptBody').innerHTML = q.per.sort((a, b) => collegeName(a.collegeId).localeCompare(collegeName(b.collegeId), 'ar')).map(o => `<tr><td>${esc(collegeName(o.collegeId))}</td><td>${esc(deptName(o.deptId))}</td>
    <td>${o.lec}</td><td>${o.occ ? pctBadge(pct(o.done, o.occ)) + ` <span class="note">(${o.done}/${o.occ})</span>` : '<span class="note">لا جدول</span>'}</td><td>${pctBadge(pct(o.P, o.P + o.A))}</td>
    <td>${o.warn.size}</td><td>${o.dep.size ? `<span class="badge b-dep">${o.dep.size}</span>` : 0}</td><td>${o.sheets}</td><td>${o.appr}</td><td>${pctBadge(pct(o.pass, o.graded), 80, 60)}</td></tr>`).join('')
    || '<tr><td colspan="10" class="note">لا توجد بيانات</td></tr>';
  $('#qaInstrBody').innerHTML = q.instr.sort((a, b) => (pct(a.done, a.occ) ?? 101) - (pct(b.done, b.occ) ?? 101)).map(o => `<tr><td>${esc(o.name || '')}</td><td>${esc(deptName(o.deptId))}</td><td>${o.occ}</td><td>${o.done}</td>
    <td>${o.occ ? pctBadge(pct(o.done, o.occ)) : '—'}</td><td>${pctTxt(pct(o.P, o.P + o.A))}</td></tr>`).join('') || '<tr><td colspan="6" class="note">لا توجد بيانات</td></tr>';
  $('#qaCourseBody').innerHTML = q.courseRows.sort((a, b) => (a.rate ?? 101) - (b.rate ?? 101)).map(r => `<tr><td>${esc(deptName(r.deptId))}</td><td>${esc(r.course)}</td><td>${esc(r.stage)} / ${esc(r.shift)}</td>
    <td>${r.n}</td><td>${r.pass}</td><td>${r.fail}</td><td>${r.dep}</td><td>${pctBadge(r.rate, 80, 60)}</td></tr>`).join('') || '<tr><td colspan="8" class="note">لا توجد جداول درجات بنتائج نهائية</td></tr>';
}
$('#qaExport').onclick = () => {
  if (!qaData) return toast('اعرض المؤشرات أولاً', 'err');
  if (!needXLSX()) return;
  const wb = XLSX.utils.book_new(); wb.Workbook = {Views:[{RTL:true}, {RTL:true}, {RTL:true}]};
  const r1 = q => q == null ? '' : +q.toFixed(1);
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['الكلية','القسم','محاضرات مسجّلة','محاضرات مجدولة','الالتزام %','نسبة الحضور %','طلبة بإنذار','محرومون','جداول السعي','مُصادق','نسبة النجاح %'],
    ...qaData.per.map(o => [collegeName(o.collegeId), deptName(o.deptId), o.lec, o.occ, r1(pct(o.done, o.occ)), r1(pct(o.P, o.P + o.A)), o.warn.size, o.dep.size, o.sheets, o.appr, r1(pct(o.pass, o.graded))])]), 'الأقسام');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['التدريسي','القسم','مجدولة','مسجّلة','الالتزام %','متوسط الحضور %'],
    ...qaData.instr.map(o => [o.name, deptName(o.deptId), o.occ, o.done, r1(pct(o.done, o.occ)), r1(pct(o.P, o.P + o.A))])]), 'التدريسيون');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['القسم','المادة','المرحلة','الدراسة','الطلبة','ناجح','راسب','محروم','نسبة النجاح %'],
    ...qaData.courseRows.map(r => [deptName(r.deptId), r.course, r.stage, r.shift, r.n, r.pass, r.fail, r.dep, r1(r.rate)])]), 'المواد');
  XLSX.writeFile(wb, `تقرير_ضمان_الجودة_${today()}.xlsx`);
};
$('#auLoad').onclick = async () => {
  const d = App.dept; if (!d) return;
  try{
    const f = is('dean') ? [['collegeId', d.collegeId], ['deptId', d.id], ['term', App.org.term]] : [['deptId', d.id], ['term', App.org.term]];
    const list = (await DB.query('att_audit', f)).sort((a, b) => (b.atISO || '').localeCompare(a.atISO || '')).slice(0, 400);
    $('#auBody').innerHTML = list.map(a => `<tr><td dir="ltr" style="text-align:right">${esc((a.atISO || '').replace('T', ' ').slice(0, 16))}</td><td>${esc(a.name)} <span class="note">${esc(ROLES[normRole(a.role)] || '')}</span></td><td>${esc(a.action)}</td><td class="note">${esc(a.details)}</td></tr>`).join('')
      || '<tr><td colspan="4" class="note">لا توجد عمليات مسجّلة</td></tr>';
  }catch(e){ toast('تعذّر التحميل: ' + fbErr(e), 'err'); }
};

/* ---------- صفحة الطالب: الحضور والدرجات والأعذار ---------- */
let stOrg = null;
async function stEnsureOrg(){ if (!stOrg) stOrg = await FS.get('att_org', 'main'); return stOrg; }
$('#stAttLoad').onclick = async () => {
  if (!student || App.mode === 'local') return;
  $('#stAtt').innerHTML = '⏳ جارٍ التحميل...';
  try{
    const org = await stEnsureOrg(), st = student;
    const [sessions, myEx, cdoc] = await Promise.all([
      FS.query('att_sessions', [['deptId', st.deptId], ['stage', st.stage], ['shift', st.shift], ['term', org.term]]),
      FS.query('att_excuses', [['uid', auth.currentUser.uid]]), FS.get('att_courses', st.deptId).catch(() => null)]);
    const rows = absenceRowsFrom(sessions, myEx.filter(x => x.status === 'approved'), () => getPolicy(cdoc)).filter(r => r.sid === st.sid);
    const p = getPolicy(cdoc);
    $('#stAtt').innerHTML = rows.length ? `<div class="tbl-wrap"><table><thead><tr><th>المادة</th><th>غياب</th><th>بدون عذر</th><th>الحالة</th></tr></thead><tbody>${rows.map(r =>
      `<tr><td>${esc(r.course)}</td><td>${r.abs} من ${r.held} ساعة</td><td>${r.pu.toFixed(1)}%</td><td><span class="badge ${ST_LABEL[r.status][1]}">${ST_LABEL[r.status][0]}</span></td></tr>`).join('')}</tbody></table></div>
      <p class="note">الإنذار الأول ${p.w1}% — الثاني ${p.w2}% — الحرمان ${p.dep}% (بدون عذر) أو ${p.depT}% كلياً.</p>` : 'لا توجد محاضرات مسجّلة لك بعد.';
  }catch(e){ $('#stAtt').textContent = 'تعذّر التحميل: ' + fbErr(e); }
};
$('#stResLoad').onclick = async () => {
  if (!student || App.mode === 'local') return;
  $('#stRes').innerHTML = '⏳ جارٍ التحميل...';
  try{
    const org = await stEnsureOrg(), r = await FS.get('att_results', [student.deptId, org.term, student.sid].map(sanitizeId).join('~'));
    const cs = Object.values((r && r.courses) || {});
    $('#stRes').innerHTML = cs.length ? `<div class="tbl-wrap"><table><thead><tr><th>المادة</th><th>السعي</th><th>النهائي</th><th>المجموع</th><th>النتيجة</th></tr></thead><tbody>${cs.map(c =>
      `<tr><td>${esc(c.name)}</td><td>${c.sae} / ${c.saeMax}</td><td>${c.final2 != null ? c.final2 + ' (د٢)' : c.final != null ? c.final : '—'}</td><td>${c.total != null ? c.total : '—'}</td>
       <td>${c.result ? `<span class="badge ${/ناجح/.test(c.result) ? 'b-face' : 'b-abs'}">${esc(c.result)}</span>` : '—'}</td></tr>`).join('')}</tbody></table></div>` : 'لم تُنشر نتائج بعد.';
  }catch(e){ $('#stRes').textContent = 'تعذّر التحميل: ' + fbErr(e); }
};
function compressImage(file, max = 1000, q = 0.6){
  return new Promise((res, rej) => { const img = new Image(), url = URL.createObjectURL(file);
    img.onload = () => { const s = Math.min(1, max / Math.max(img.width, img.height)), c = document.createElement('canvas');
      c.width = Math.round(img.width * s); c.height = Math.round(img.height * s); c.getContext('2d').drawImage(img, 0, 0, c.width, c.height); URL.revokeObjectURL(url); res(c.toDataURL('image/jpeg', q)); };
    img.onerror = rej; img.src = url; });
}
async function loadMyExcuses(){
  if (!student || App.mode === 'local' || !navigator.onLine) return;
  try{ const list = (await FS.query('att_excuses', [['uid', auth.currentUser.uid]])).sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
    const lab = {pending:['بانتظار القرار','b-man'], approved:['مقبول','b-face'], rejected:['مرفوض','b-abs']};
    $('#xList').innerHTML = list.map(x => `<div class="spot" style="font-size:14px"><span>${esc(x.course || 'كل المواد')} — ${esc(x.from)} إلى ${esc(x.to)}</span><span class="badge ${(lab[x.status] || lab.pending)[1]}">${(lab[x.status] || lab.pending)[0]}</span></div>`).join(''); }
  catch(e){ console.warn(e); }
}
$('#xSend').onclick = async () => {
  if (!student) return;
  if (App.mode === 'local') return toast('متاح بعد ربط Firebase', 'err');
  if (!navigator.onLine) return toast('تقديم العذر يحتاج إنترنت', 'err');
  const from = $('#xFrom').value, to = $('#xTo').value || from, f = $('#xFile').files[0];
  if (!from || to < from) return toast('حدّد التاريخ بشكل صحيح', 'err');
  if (!$('#xReason').value.trim()) return toast('اكتب سبب الغياب', 'err');
  $('#xSend').disabled = true;
  try{
    const org = await stEnsureOrg(), img = f ? await compressImage(f) : null;
    const w = DB.set('att_excuses', null, {uid:auth.currentUser.uid, sid:student.sid, name:student.name || '', deptId:student.deptId, collegeId:student.collegeId,
      stage:student.stage, shift:student.shift, term:org.term, course:$('#xCourse').value.trim(), from, to, reason:$('#xReason').value.trim(), status:'pending', hasImg:!!img, createdAt:nowISO()});
    await w.p;
    if (img) await DB.set('att_excuse_img', w.id, {img, uid:auth.currentUser.uid, deptId:student.deptId, collegeId:student.collegeId}).p;
    toast('أُرسل العذر إلى رئيس القسم ✓', 'ok'); ['#xFrom','#xTo','#xCourse','#xReason','#xFile'].forEach(x => $(x).value = ''); loadMyExcuses();
  }catch(e){ toast('تعذّر الإرسال: ' + fbErr(e), 'err'); }
  $('#xSend').disabled = false;
};

/* =====================================================================
   المستخدمون
   ===================================================================== */
function roleOptionsFor(editing){
  if (is('super')) return ['super','qa','dean','head','registrar','committee','instructor'].concat(editing ? ['disabled'] : []);
  if (is('dean')) return ['head','registrar','committee','instructor'].concat(editing ? ['disabled'] : []);
  if (is('head')) return ['registrar','committee','instructor'].concat(editing ? ['disabled'] : []);
  return [];
}
function canEditUser(u){
  const me = App.user; if (u.id === me.uid) return false;
  if (is('super')) return true;
  if (is('dean')) return u.collegeId === me.collegeId && ['head','registrar','committee','instructor','disabled'].includes(u.role);
  if (is('head')) return u.collegeId === me.collegeId && ['registrar','committee','instructor','disabled'].includes(u.role) &&
    (u.deptIds || []).every(d => (me.deptIds || []).includes(d));
  return false;
}
$('#uSearch').oninput = renderUsers;
function renderUsers(){
  if (!is('super','dean','head')) return;
  const q = $('#uSearch').value.trim(), me = App.user;
  let list = App.users.slice();
  if (is('head')) list = list.filter(u => u.id === me.uid || (u.deptIds || []).some(d => (me.deptIds || []).includes(d)));
  list = list.filter(u => !q || (u.name || '').includes(q) || (u.email || '').includes(q))
    .sort((a, b) => (a.name || '').localeCompare(b.name || '', 'ar'));
  $('#usersBody').innerHTML = list.map(u => `<tr><td>${esc(u.name)}${u.id === me.uid ? ' <span class="badge b-gray">أنت</span>' : ''}</td>
    <td dir="ltr" style="text-align:right">${esc(u.email)}</td>
    <td><span class="badge ${u.role === 'disabled' ? 'b-abs' : 'b-face'}">${ROLES[normRole(u.role)] || u.role}</span></td>
    <td>${esc(collegeName(u.collegeId))}</td><td>${(u.shifts || []).length === 1 ? `<span class="badge ${u.shifts[0].includes('مسائ') ? 'b-vio' : 'b-man'}">${esc(u.shifts[0])}</span>` : '<span class="badge b-gray">كلاهما</span>'}</td><td>${(u.assignments || []).length
      ? u.assignments.map(a => `<div>📘 ${esc(a.course)} <span class="note">— ${esc(deptName(a.deptId))} / ${esc(a.stage)} / ${esc(a.shift)} / ${esc(a.section || 'كل الشعب')}</span></div>`).join('')
      : (u.deptIds || []).map(d => esc(deptName(d))).join('، ')}</td>
    <td>${canEditUser(u) ? `<button class="btn sm light" data-edit="${esc(u.id)}">تعديل</button>` : ''}</td></tr>`).join('')
    || '<tr><td colspan="7" class="note">لا يوجد مستخدمون</td></tr>';
}
let umEditing = null, umAsg = [], umDeptsAllowed = [];
const umCourses = {}; // مواد كل قسم (من «المواد الدراسية»)
async function loadUmCourses(ids){
  await Promise.all(ids.filter(id => !umCourses[id]).map(id => (App.courses && App.courses.deptId === id ? Promise.resolve(App.courses) : DB.get('att_courses', id).catch(() => null))
    .then(doc => umCourses[id] = Object.values((doc && doc.courses) || {}))));
}
const allShifts = () => [...new Set(deptList().flatMap(d => d.shifts || []))];
const umShiftList = () => { const v = $('#umShifts').value; return v ? [v] : []; };
function umAllowedDepts(){
  const me = App.user;
  return is('super') ? deptList() : is('dean') ? deptList().filter(d => d.collegeId === me.collegeId) : deptList().filter(d => (me.deptIds || []).includes(d.id));
}
function newAsg(deptId){
  const d = (App.org.depts || {})[deptId] || {stages:[''], shifts:[''], sections:[]}, sh = umShiftList();
  return {deptId, course:'', stage:d.stages[0], shift:(sh.length && d.shifts.includes(sh[0])) ? sh[0] : d.shifts[0], section:''};
}
function renderAsg(){
  const opt = (arr, v, all) => (all ? `<option value="" ${!v ? 'selected' : ''}>${all}</option>` : '') + (arr || []).map(x => `<option ${x === v ? 'selected' : ''}>${esc(x)}</option>`).join('');
  $('#umAsgBody').innerHTML = umAsg.map((a, i) => {
    const d = (App.org.depts || {})[a.deptId] || {};
    return `<tr data-i="${i}">
      <td><select data-f="deptId">${umDeptsAllowed.map(x => `<option value="${esc(x.id)}" ${x.id === a.deptId ? 'selected' : ''}>${esc(x.name)}</option>`).join('')}</select></td>
      <td><select data-f="stage">${opt(d.stages, a.stage)}</select></td>
      <td>${(() => { const cs = (umCourses[a.deptId] || []).filter(c => c.stage === a.stage).map(c => c.name).sort((x, y) => x.localeCompare(y, 'ar'));
        const known = !a.course || cs.includes(a.course);
        return cs.length && known && !a.free ? `<select data-f="course" style="min-width:170px"><option value="">— اختر المادة —</option>${cs.map(n => `<option ${n === a.course ? 'selected' : ''}>${esc(n)}</option>`).join('')}<option value="__free">✎ مادة أخرى (كتابة)</option></select>`
          : `<input data-f="course" value="${esc(a.course)}" placeholder="${cs.length ? 'اسم المادة' : 'لا توجد مواد لهذه المرحلة — اكتب الاسم'}" style="min-width:170px">`; })()}</td>
      <td><select data-f="shift">${opt((d.shifts || []).filter(x => !umShiftList().length || umShiftList().includes(x)), a.shift)}</select></td>
      <td><select data-f="section">${opt(d.sections, a.section, 'كل الشعب')}</select></td>
      <td><button class="btn sm red" data-rm="${i}" type="button">✕</button></td></tr>`;
  }).join('') || '<tr><td colspan="6" class="note">اضغط "+ إضافة مادة"</td></tr>';
}
$('#umAsgBody').oninput = $('#umAsgBody').onchange = e => {
  const tr = e.target.closest('tr[data-i]'), f = e.target.dataset.f; if (!tr || !f) return;
  const a = umAsg[+tr.dataset.i]; a[f] = e.target.value;
  if (f === 'course' && a.course === '__free'){ a.course = ''; a.free = true; renderAsg(); const ins = tr.parentElement.querySelectorAll('input[data-f=course]'); if (ins.length) [...ins].pop().focus(); return; }
  if (f === 'stage' && e.type === 'change'){ a.course = ''; a.free = false; renderAsg(); }
  if (f === 'deptId' && e.type === 'change'){ Object.assign(a, newAsg(a.deptId)); loadUmCourses([a.deptId]).then(renderAsg); }
};
$('#umAsgBody').onclick = e => { const b = e.target.closest('button[data-rm]'); if (b){ umAsg.splice(+b.dataset.rm, 1); renderAsg(); } };
$('#umAddAsg').onclick = () => {
  const last = umAsg[umAsg.length - 1];
  umAsg.push(last ? Object.assign({}, last, {course:''}) : newAsg((App.dept && umDeptsAllowed.some(d => d.id === App.dept.id)) ? App.dept.id : (umDeptsAllowed[0] || {}).id));
  renderAsg(); const ins = $$('#umAsgBody input[data-f=course]'); if (ins.length) ins[ins.length - 1].focus();
};
$('#umGen').onclick = () => { $('#umPass').value = genPass(); };
function umRoleUI(){
  const r = $('#umRole').value;
  $('#umAsgBox').classList.toggle('hidden', r !== 'instructor');
  $('#umDeptBox').classList.toggle('hidden', !['head','registrar','committee'].includes(r));
  if (r === 'instructor' && !umAsg.length) $('#umAddAsg').onclick();
}
$('#umRole').onchange = umRoleUI;
$('#umShifts').onchange = () => { const sh = umShiftList(); if (sh.length) umAsg.forEach(a => { const d = (App.org.depts || {})[a.deptId]; if (d && d.shifts.includes(sh[0])) a.shift = sh[0]; }); renderAsg(); };
function openUserModal(u){
  umEditing = u || null;
  const me = App.user;
  $('#userModalTitle').textContent = u ? 'تعديل مستخدم: ' + u.name : 'إضافة مستخدم';
  $('#umName').value = u ? u.name : ''; $('#umEmail').value = u ? u.email : ''; $('#umPass').value = u ? '' : genPass();
  $('#umName').disabled = $('#umEmail').disabled = !!u; $('#umPassBox').classList.toggle('hidden', !!u);
  $('#umRole').innerHTML = roleOptionsFor(!!u).map(r => `<option value="${r}">${ROLES[r]}</option>`).join('');
  $('#umRole').value = u ? normRole(u.role) : 'instructor';
  const cols = is('super') ? Object.entries(App.org.colleges || {}) : [[me.collegeId, {name:collegeName(me.collegeId)}]];
  $('#umCollege').innerHTML = cols.map(([id, c]) => `<option value="${esc(id)}">${esc(c.name)}</option>`).join('');
  $('#umCollege').value = u ? (u.collegeId || '') : (App.dept ? App.dept.collegeId : me.collegeId);
  $('#umCollege').disabled = !is('super');
  umDeptsAllowed = umAllowedDepts();
  const sel = new Set(u ? (u.deptIds || []) : (App.dept ? [App.dept.id] : []));
  const byCol = {}; umDeptsAllowed.forEach(d => (byCol[d.collegeId] = byCol[d.collegeId] || []).push(d));
  $('#umDepts').innerHTML = Object.entries(byCol).map(([c, ds]) => `<div class="grp">${esc(collegeName(c))}</div>` +
    ds.map(d => `<label><input type="checkbox" value="${esc(d.id)}" ${sel.has(d.id) ? 'checked' : ''}>${esc(d.name)}</label>`).join('')).join('')
    || '<span class="note">لا توجد أقسام</span>';
  const shs = allShifts(), cur = u ? (u.shifts || []) : [];
  $('#umShifts').innerHTML = `<option value="">كلاهما (${esc(shs.join(' و '))})</option>` + shs.map(x => `<option value="${esc(x)}">${esc(x)} فقط</option>`).join('');
  $('#umShifts').value = cur.length === 1 ? cur[0] : '';
  umAsg = u ? clone(u.assignments || []) : [];
  renderAsg(); umRoleUI();
  loadUmCourses(umDeptsAllowed.map(d => d.id)).then(renderAsg);
  $('#umCred').classList.add('hidden'); $('#umSave').classList.remove('hidden'); $('#umCancel').textContent = 'إلغاء';
  $('#umNote').textContent = App.mode === 'local' ? 'وضع محلي: يُنشأ سجل المستخدم فقط دون حساب دخول.' : (u ? '' : 'يتطلب إنشاء الحساب اتصالاً بالإنترنت.');
  $('#userModal').classList.add('show');
}
$('#newUserBtn').onclick = () => openUserModal(null);
$('#usersBody').onclick = e => { const b = e.target.closest('button[data-edit]'); if (b) openUserModal(App.users.find(u => u.id === b.dataset.edit)); };
$('#umCancel').onclick = () => $('#userModal').classList.remove('show');
$('#umSave').onclick = async () => {
  const r = $('#umRole').value;
  let collegeId = $('#umCollege').value, deptIds = $$('#umDepts input:checked').map(x => x.value), assignments = [];
  if (r === 'instructor'){
    assignments = umAsg.map(a => ({deptId:a.deptId, course:String(a.course || '').replace('__free', '').trim(), stage:a.stage, shift:a.shift, section:a.section || ''}));
    if (!assignments.length) return toast('أضف مادة واحدة على الأقل للتدريسي', 'err');
    if (assignments.some(a => !a.course || !a.deptId)) return toast('اختر أو اكتب اسم كل مادة', 'err');
    const sh = umShiftList(); if (sh.length && assignments.some(a => !sh.includes(a.shift))) return toast(`المستخدم مخصّص لـ«${sh[0]}» — غيّر الدراسة في المواد أو اجعلها «كلاهما»`, 'err');
    deptIds = [...new Set(assignments.map(a => a.deptId))];
    if (!is('super')) collegeId = App.user.collegeId;
    else { const d = (App.org.depts || {})[deptIds[0]]; if (d) collegeId = d.collegeId; }
  } else if (['head','registrar','committee'].includes(r) && !deptIds.length) return toast('اختر قسماً واحداً على الأقل', 'err');
  if (!['head','registrar','committee','instructor'].includes(r)) deptIds = deptIds.filter(() => false);
  if (r !== 'super' && !collegeId) return toast('اختر الكلية', 'err');
  $('#umSave').disabled = true;
  try{
    if (umEditing){
      await DB.update('att_users', umEditing.id, {role:r, collegeId, deptIds, assignments, shifts:umShiftList(), updatedAt:nowISO()}).p;
      toast('تم التحديث', 'ok'); $('#userModal').classList.remove('show'); audit('تعديل مستخدم', `${umEditing.name} — ${ROLES[r]}`);
    } else {
      const name = $('#umName').value.trim(), email = $('#umEmail').value.trim().toLowerCase(), pass = $('#umPass').value;
      if (!name || !emailOk(email) || pass.length < 6) throw {message:'أكمل الاسم والبريد الصحيح والرمز (٦ أحرف على الأقل)'};
      let uid;
      if (App.mode === 'local') uid = 'U' + Date.now();
      else {
        if (!navigator.onLine) throw {message:'إنشاء الحسابات يتطلب اتصالاً بالإنترنت'};
        const sec = firebase.apps.find(a => a.name === 'secondary') || firebase.initializeApp(window.FIREBASE_CONFIG, 'secondary');
        const cred = await sec.auth().createUserWithEmailAndPassword(email, pass);
        uid = cred.user.uid; await sec.auth().signOut();
      }
      await DB.set('att_users', uid, {name, email, role:r, collegeId, deptIds, assignments, shifts:umShiftList(), createdAt:nowISO(), createdBy:App.user.uid}).p;
      const link = location.origin + location.pathname.replace(/index\.html$/, '');
      const txt = `نظام حضور الطلبة — جامعة السراج\nالاسم: ${name}\nالصلاحية: ${ROLES[r]}\n` +
        (assignments.length ? 'المواد: ' + assignments.map(a => `${a.course} (${deptName(a.deptId)} / ${a.stage} / ${a.shift} / ${a.section || 'كل الشعب'})`).join('، ') + '\n' : '') +
        `البريد: ${email}\nالرمز: ${pass}\nالرابط: ${link}`;
      $('#umCred').innerHTML = `<b>✓ تم إنشاء الحساب — سلّم هذه البيانات للمستخدم (الرمز لا يظهر مرة أخرى):</b>
        <pre style="white-space:pre-wrap;font-family:inherit;margin:8px 0" id="umCredTxt">${esc(txt)}</pre>
        <button class="btn sm" id="umCopy" type="button">📋 نسخ</button>`;
      $('#umCred').classList.remove('hidden'); $('#umSave').classList.add('hidden'); $('#umCancel').textContent = 'إغلاق';
      $('#umCopy').onclick = async () => { try{ await navigator.clipboard.writeText(txt); toast('نُسخ', 'ok'); }catch(e){ toast('انسخ النص يدوياً', 'err'); } };
      toast('تم إنشاء حساب ' + name, 'ok'); audit('إنشاء مستخدم', `${name} — ${ROLES[r]}`);
    }
  }catch(e){ toast('تعذّر الحفظ: ' + fbErr(e), 'err'); }
  $('#umSave').disabled = false;
};

/* =====================================================================
   الهيكل التنظيمي (مدير النظام)
   ===================================================================== */
function renderOrg(){
  if (!is('super') || !App.org) return;
  const o = App.org;
  if (document.activeElement !== $('#orgTerm')) $('#orgTerm').value = o.term || '';
  if (document.activeElement !== $('#orgTermStart')) $('#orgTermStart').value = o.termStart || '';
  const depts = deptList();
  $('#collegesBody').innerHTML = Object.entries(o.colleges || {}).map(([id, c]) => `<tr><td dir="ltr" style="text-align:right">${esc(id)}</td><td>${esc(c.name)}</td>
    <td>${depts.filter(d => d.collegeId === id).length}</td>
    <td class="row"><button class="btn sm light" data-cedit="${esc(id)}">تعديل</button><button class="btn sm red" data-cdel="${esc(id)}">حذف</button></td></tr>`).join('');
  const cur = $('#depCollege').value;
  $('#depCollege').innerHTML = Object.entries(o.colleges || {}).map(([id, c]) => `<option value="${esc(id)}">${esc(c.name)}</option>`).join('');
  if (cur) $('#depCollege').value = cur;
  $('#deptsBody').innerHTML = depts.sort((a, b) => collegeName(a.collegeId).localeCompare(collegeName(b.collegeId), 'ar') || a.name.localeCompare(b.name, 'ar'))
    .map(d => `<tr><td>${esc(collegeName(d.collegeId))}</td><td dir="ltr" style="text-align:right">${esc(d.id)}</td><td>${esc(d.name)}</td>
    <td>${esc((d.stages || []).join('، '))}</td><td>${esc((d.shifts || []).join('، '))}</td><td>${esc((d.sections || []).join('، '))}</td>
    <td class="row"><button class="btn sm light" data-dedit="${esc(d.id)}">تعديل</button><button class="btn sm red" data-ddel="${esc(d.id)}">حذف</button></td></tr>`).join('');
}
const saveOrg = (o, msg) => bg(DB.set('att_org', 'main', o).p, msg);
$('#saveTermBtn').onclick = async () => {
  const t = $('#orgTerm').value.trim(), ts = $('#orgTermStart').value; if (!t) return toast('اكتب اسم الفصل', 'err');
  if (t === App.org.term){ if (ts !== (App.org.termStart || '')) saveOrg(Object.assign(clone(App.org), {termStart:ts}), 'تم حفظ تاريخ بداية الفصل'); return; }
  if (!(await confirmBox('تغيير الفصل الدراسي', `ستُنسب المحاضرات الجديدة إلى "${t}"، وستعرض التقارير هذا الفصل فقط. سجلات الفصل السابق تبقى محفوظة.`, 'تغيير'))) return;
  saveOrg(Object.assign(clone(App.org), {term:t, termStart:ts}), 'تم تغيير الفصل الدراسي'); audit('تغيير الفصل الدراسي', t);
};
$('#saveCollegeBtn').onclick = () => {
  const id = $('#colId').value.trim().toLowerCase(), name = $('#colName').value.trim();
  if (!slugOk(id)) return toast('الرمز: أحرف إنجليزية صغيرة وأرقام وشرطة فقط (مثل tech-eng)', 'err');
  if (!name) return toast('اكتب اسم الكلية', 'err');
  const o = clone(App.org); o.colleges = o.colleges || {}; o.colleges[id] = {name};
  saveOrg(o, 'تم حفظ الكلية'); $('#colId').value = ''; $('#colName').value = '';
};
$('#collegesBody').onclick = async e => {
  const b = e.target.closest('button'); if (!b) return;
  if (b.dataset.cedit){ $('#colId').value = b.dataset.cedit; $('#colName').value = collegeName(b.dataset.cedit); $('#colName').focus(); }
  if (b.dataset.cdel){
    if (deptList().some(d => d.collegeId === b.dataset.cdel)) return toast('احذف أقسام الكلية أو انقلها أولاً', 'err');
    if (!(await confirmBox('حذف الكلية', 'سيتم حذف الكلية من الهيكل.', 'حذف'))) return;
    const o = clone(App.org); delete o.colleges[b.dataset.cdel]; saveOrg(o);
  }
};
function clearDeptForm(){
  $('#depId').value = ''; $('#depId').disabled = false; $('#depName').value = '';
  $('#depStages').value = 'الأولى,الثانية,الثالثة,الرابعة'; $('#depSections').value = 'A,B';
  $('#depMorning').checked = $('#depEvening').checked = true;
}
$('#clearDeptBtn').onclick = clearDeptForm;
$('#saveDeptBtn').onclick = () => {
  const id = $('#depId').value.trim().toLowerCase(), name = $('#depName').value.trim(), collegeId = $('#depCollege').value;
  const stages = splitList($('#depStages').value), sections = splitList($('#depSections').value);
  const shifts = [$('#depMorning').checked && 'صباحي', $('#depEvening').checked && 'مسائي'].filter(Boolean);
  if (!collegeId) return toast('أضف كلية أولاً', 'err');
  if (!slugOk(id)) return toast('رمز القسم: أحرف إنجليزية صغيرة وأرقام وشرطة فقط (مثل ai-eng)', 'err');
  if (!name || !stages.length || !shifts.length) return toast('أكمل اسم القسم والمراحل والدراسة', 'err');
  const o = clone(App.org); o.depts = o.depts || {};
  o.depts[id] = {name, collegeId, stages, shifts, sections};
  saveOrg(o, 'تم حفظ القسم'); clearDeptForm();
};
$('#deptsBody').onclick = async e => {
  const b = e.target.closest('button'); if (!b) return;
  if (b.dataset.dedit){
    const d = App.org.depts[b.dataset.dedit];
    $('#depCollege').value = d.collegeId; $('#depId').value = b.dataset.dedit; $('#depId').disabled = true; $('#depName').value = d.name;
    $('#depStages').value = (d.stages || []).join(','); $('#depSections').value = (d.sections || []).join(',');
    $('#depMorning').checked = (d.shifts || []).includes('صباحي'); $('#depEvening').checked = (d.shifts || []).includes('مسائي');
    $('#depName').focus();
  }
  if (b.dataset.ddel){
    if (!(await confirmBox('حذف القسم', 'سيُحذف القسم من الهيكل فقط؛ بيانات طلبته وسجلاته تبقى محفوظة ويمكن استعادتها بإعادة إنشاء القسم بنفس الرمز.', 'حذف'))) return;
    const o = clone(App.org); delete o.depts[b.dataset.ddel]; saveOrg(o);
  }
};

/* ============ الإعدادات والنسخ الاحتياطي ============ */
function loadSettingsUI(){
  const s = Settings.get();
  $('#setThreshold').value = s.threshold; $('#thVal').textContent = s.threshold;
  $('#setLiveness').value = s.liveness; $('#setFrames').value = s.minFrames;
}
$('#setThreshold').oninput = e => $('#thVal').textContent = e.target.value;
$('#saveSettingsBtn').onclick = () => {
  Settings.save({threshold:+$('#setThreshold').value, liveness:$('#setLiveness').value, minFrames:Math.max(1, +$('#setFrames').value || 3), cameraId:$('#setCamera').value});
  toast('تم حفظ الإعدادات', 'ok');
};
$('#listCamsBtn').onclick = async () => {
  try{
    const tmp = await navigator.mediaDevices.getUserMedia({video:true}); tmp.getTracks().forEach(t => t.stop());
    const cams = (await navigator.mediaDevices.enumerateDevices()).filter(d => d.kind === 'videoinput'), cur = Settings.get().cameraId;
    $('#setCamera').innerHTML = '<option value="">الافتراضية</option>' + cams.map((c, i) => `<option value="${esc(c.deviceId)}" ${c.deviceId === cur ? 'selected' : ''}>${esc(c.label || 'كاميرا ' + (i + 1))}</option>`).join('');
  }catch(e){ toast('تعذّر الوصول إلى الكاميرات', 'err'); }
};
$('#backupBtn').onclick = () => {
  const d = App.dept; if (!d) return toast('اختر القسم أولاً', 'err');
  const data = {app:'siraj-attendance', version:APP_VERSION, exportedAt:nowISO(), collegeId:d.collegeId, deptId:d.id, deptName:d.name, term:App.org.term,
    packs:Object.values(App.packs).map(strip), sessions:App.sessions.filter(s => s.deptId === d.id).map(strip)};
  download(`نسخة_${d.id}_${today()}.json`, JSON.stringify(data), 'application/json');
};
$('#restoreInput').onchange = async e => {
  const f = e.target.files[0]; e.target.value = ''; if (!f) return;
  const d = App.dept; if (!d) return toast('اختر القسم أولاً', 'err');
  try{
    const x = JSON.parse(await f.text());
    if (!Array.isArray(x.packs)) throw 0;
    const sessions = is('super') ? (x.sessions || []) : [];
    const msg = `سيُستورد ${x.packs.reduce((a, p) => a + Object.keys(p.students || {}).length, 0)} طالب` +
      (sessions.length ? ` و${sessions.length} محاضرة` : '') + ` إلى قسم "${d.name}"` + (x.deptId && x.deptId !== d.id ? ` (النسخة من قسم آخر: ${x.deptName || x.deptId})` : '') + '.';
    if (!(await confirmBox('استيراد نسخة', msg, 'استيراد'))) return;
    x.packs.forEach(p => {
      const {id, ...data} = p;
      bg(DB.set('att_packs', packId(d.id, p.stage, p.shift), Object.assign(data, {collegeId:d.collegeId, deptId:d.id, updatedAt:nowISO()}), true).p);
    });
    sessions.forEach(s => { const {id, ...data} = s; bg(DB.set('att_sessions', id ? cleanId(id) : null, Object.assign(data, {collegeId:d.collegeId, deptId:d.id})).p); });
    toast('تم الاستيراد', 'ok');
  }catch(err){ toast('ملف غير صالح', 'err'); }
};
$('#clearAllBtn').onclick = async () => {
  if (!(await confirmBox('حذف كل البيانات المحلية', 'سيُحذف كل شيء من هذا الجهاز.', 'حذف'))) return;
  LFS.d = {}; LFS.persist(); location.reload();
};

/* =====================================================================
   واجهة الطالب: تفعيل الحساب ومسح رمز الحضور
   ===================================================================== */
let student = null, registering = false, scanStream = null, scanOn = false, scanBusy = false;
async function enterStudent(st){
  student = st; showView('studentView');
  $('#stName').textContent = st.name ? `${st.name} — ${st.sid}` : 'الرقم الجامعي: ' + st.sid;
  let dn = st.deptId;
  try{ const org = await FS.get('att_org', 'main'); if (org && org.depts && org.depts[st.deptId]) dn = org.depts[st.deptId].name; }catch(e){}
  $('#stInfo').textContent = `${dn} — ${st.stage} / ${st.shift}${st.section ? ' / ' + st.section : ''}`;
  stConn(); $('#stResult').innerHTML = ''; camHelp(''); stOrg = null;
  if (navigator.onLine && App.mode !== 'local'){ setTimeout(() => { $('#stAttLoad').onclick(); $('#stResLoad').onclick(); loadMyExcuses(); }, 800); }
  $('#stVer') && ($('#stVer').textContent = 'الإصدار ' + APP_VERSION + ' — تطوير: د. محمد يوسف');
  const bind = await bindDevice(st);
  if (bind !== true){ stopScan(); $('#scanBtn').classList.add('hidden'); camHelp(bind); return; }
  renderQueue(); flushQueue();
  faceToken = null; pendingQR = sessionStorage.getItem('fa_pending'); sessionStorage.removeItem('fa_pending');
  if (inAppBrowser()){ $('#scanBtn').classList.remove('hidden'); camFail('inapp'); return; }
  $('#selfEnrollCard').classList.add('hidden');
  if ((st.p || []).length) doSelfie();   // السيلفي أولاً، ثم مسح QR
  else showSelfEnroll();                 // أول دخول: يسجّل الطالب بصمة وجهه بنفسه
}
/* ---- تسجيل الطالب بصمة وجهه بنفسه (أول دخول بعد استيراد القسم لبياناته) ---- */
function showSelfEnroll(){
  stopScan(); $('#scanBtn').classList.add('hidden');
  $('#selfEnrollCard').classList.remove('hidden'); $('#seCam').classList.add('hidden'); $('#seThumbs').innerHTML = ''; $('#seBar').style.width = '0%';
  $('#seMsg').className = 'result info'; $('#seMsg').textContent = 'اضغط "ابدأ التسجيل"'; $('#seStart').classList.remove('hidden'); $('#seStart').disabled = false;
  faceState('👤 سجّل بصمة وجهك أولاً لتتمكن من تسجيل الحضور', 'info');
  loadStudentModels();
}
$('#seLater').onclick = () => {
  $('#selfEnrollCard').classList.add('hidden');
  faceState('ℹ لم تسجّل بصمة وجهك بعد — يمكنك المسح في المحاضرات التي لا تتطلب السيلفي فقط. ستظهر شاشة التسجيل عند دخولك القادم.', 'info');
  if (pendingQR){ const t = pendingQR; pendingQR = null; submitFromText(t); } else startScan();
};
const seMsg = (t, c) => { $('#seMsg').textContent = t; $('#seMsg').className = 'result ' + (c || 'info'); };
$('#seStart').onclick = async () => {
  if (!$('#seConsent').checked) return seMsg('ضع إشارة الموافقة أولاً', 'err');
  if (App.mode !== 'local' && !navigator.onLine) return seMsg('تسجيل البصمة يحتاج اتصالاً بالإنترنت', 'err');
  $('#seStart').disabled = true; $('#seThumbs').innerHTML = '';
  seMsg('⏳ جارٍ تجهيز التعرف على الوجه... (أول مرة قد يستغرق دقيقة)');
  if (!(await loadStudentModels())){ $('#seStart').disabled = false; return seMsg('تعذّر تحميل نماذج الوجه — تحقق من الإنترنت وحاول مجدداً', 'err'); }
  let stream;
  try{ stream = await navigator.mediaDevices.getUserMedia({audio:false, video:{facingMode:'user', width:{ideal:640}, height:{ideal:480}}}); }
  catch(e){ $('#seStart').disabled = false; return seMsg('تعذّر تشغيل الكاميرا الأمامية — اسمح للمتصفح باستخدامها', 'err'); }
  const v = $('#seVideo'); v.srcObject = stream; $('#seCam').classList.remove('hidden'); try{ await v.play(); }catch(e){}
  const steps = [['انظر مباشرة إلى الكاميرا', 'c'], ['ابقَ مستقيماً — صورة ثانية', 'c'], ['أدِر رأسك قليلاً إلى اليمين', 's'], ['أدِر رأسك قليلاً إلى اليسار', 's'], ['انظر مباشرة مرة أخيرة', 'c']];
  const opts = new faceapi.TinyFaceDetectorOptions({inputSize:416, scoreThreshold:0.5});
  const descs = [], thumbs = []; let stable = 0, lastSide = 0; const t0 = Date.now();
  const snap = det => { const b = det.detection.box, c = document.createElement('canvas'); c.width = c.height = 96; const pad = b.width * 0.25;
    c.getContext('2d').drawImage(v, b.x - pad, b.y - pad, b.width + 2 * pad, b.height + 2 * pad, 0, 0, 96, 96); return c.toDataURL('image/jpeg', 0.7); };
  try{
    while (descs.length < steps.length){
      if (Date.now() - t0 > 120000) throw new Error('timeout');
      const [txt, mode] = steps[descs.length];
      let faces = [];
      try{ faces = await faceapi.detectAllFaces(v, opts).withFaceLandmarks().withFaceDescriptors(); }catch(e){}
      if (faces.length !== 1){ stable = 0; seMsg(faces.length ? '⚠ يجب أن يظهر وجهك وحدك' : `🙂 ${txt}`); await new Promise(r => setTimeout(r, 120)); continue; }
      const f = faces[0], rel = f.detection.box.width / (v.videoWidth || 640);
      if (rel < 0.22){ stable = 0; seMsg('↕ قرّب الهاتف من وجهك قليلاً'); continue; }
      const yaw = yawRatio(f.landmarks.positions) - 0.5, off = Math.abs(yaw);
      const ok = mode === 'c' ? off < 0.07 : (off > 0.12 && off < 0.3 && (descs.length !== 3 || Math.sign(yaw) !== lastSide));
      if (!ok){ stable = 0; seMsg((mode === 'c' ? '🙂 ' : '↔ ') + txt); continue; }
      if (++stable < 3){ seMsg('✋ اثبت قليلاً...'); continue; }
      if (descs.length && Math.min(...descs.map(d => faceapi.euclideanDistance(d, f.descriptor))) > 0.6){ stable = 0; seMsg('⚠ يبدو أن الوجه تغيّر — يجب أن يكون الشخص نفسه', 'err'); continue; }
      descs.push(f.descriptor); thumbs.push(snap(f)); if (mode === 's') lastSide = Math.sign(yaw); stable = 0;
      $('#seBar').style.width = (descs.length / steps.length * 100) + '%';
      const im = document.createElement('img'); im.src = thumbs[thumbs.length - 1]; $('#seThumbs').appendChild(im);
      if (navigator.vibrate) navigator.vibrate(60); beep();
      await new Promise(r => setTimeout(r, 400));
    }
  }catch(e){
    stream.getTracks().forEach(t => t.stop()); $('#seCam').classList.add('hidden'); $('#seStart').disabled = false;
    return seMsg(e.message === 'timeout' ? 'انتهى الوقت — حاول مجدداً بإضاءة أفضل' : 'حدث خطأ: ' + e.message, 'err');
  }
  stream.getTracks().forEach(t => t.stop()); $('#seCam').classList.add('hidden');
  seMsg('⏳ جارٍ حفظ البصمة...');
  const enc = descs.map(encDesc), st = student, uid = App.mode === 'local' ? st.uid : auth.currentUser.uid;
  try{
    await DB.update('att_stu', uid, {p:enc, pAt:TS, pSelf:true, pThumb:thumbs[0]}).p;
    await DB.update('att_packs', packId(st.deptId, st.stage, st.shift), {[`students.${st.sid}.p`]:enc, [`students.${st.sid}.c`]:nowISO(), [`students.${st.sid}.self`]:true, [`students.${st.sid}.th`]:thumbs[0]}).p;
  }catch(e){ console.error(e); $('#seStart').disabled = false;
    return seMsg(e.code === 'permission-denied' ? 'تعذّر الحفظ: لديك بصمة مسجّلة مسبقاً، أو بياناتك لا تطابق قائمة القسم. راجع موظف التسجيل.' : 'تعذّر الحفظ: ' + fbErr(e), 'err'); }
  student.p = enc;
  seMsg('✓ تم تسجيل بصمة وجهك بنجاح', 'ok'); $('#seStart').classList.add('hidden');
  faceState('✓ بصمتك مسجّلة — عند وجود محاضرة التقط سيلفي ثم امسح رمز QR', 'ok');
  $('#faceBtn').textContent = '📸 التقط سيلفي للتحقق من وجهك'; $('#faceBtn').classList.remove('hidden');
  setTimeout(() => $('#selfEnrollCard').classList.add('hidden'), 4000);
};
/* ---- السيلفي أولاً: لا يُفتح مسح QR ولا يُسجَّل الحضور إلا إذا طابق الوجه صاحب الحساب ---- */
let faceToken = null, faceTimer = null, pendingQR = null;
function faceState(msg, cls){ const el = $('#faceState'); el.textContent = msg; el.className = 'result ' + (cls || 'info'); el.style.marginTop = 0; }
const faceValid = () => faceToken && faceToken.ok && Date.now() - faceToken.at < FACE_TOKEN_MS;
$('#faceBtn').onclick = () => doSelfie();
async function doSelfie(){
  $('#faceBtn').classList.add('hidden'); clearInterval(faceTimer); faceToken = null; $('#pfCard').classList.add('hidden');
  faceState('📸 التقط سيلفي: انظر إلى الكاميرا الأمامية، ثم أدِر رأسك قليلاً', 'info');
  const r = await verifyFace(); $('#stResult').innerHTML = '';
  if (!r.ok){
    const why = {mismatch:'✗ الوجه لا يطابق صاحب الحساب — لن يُسجَّل الحضور.', timeout:'✗ لم يكتمل التحقق من الوجه. حاول مجدداً بإضاءة جيدة.',
      nomodel:'✗ تعذّر تحميل التحقق من الوجه (يحتاج إنترنت أول مرة).', nocam:'✗ تعذّر تشغيل الكاميرا الأمامية — اسمح للمتصفح باستخدام الكاميرا.',
      noprint:'✗ لا توجد بصمة وجه لحسابك — راجع القسم.'}[r.why] || '✗ لم يتحقق الوجه.';
    faceState(why, 'err'); $('#faceBtn').textContent = '📸 إعادة التقاط السيلفي'; $('#faceBtn').classList.remove('hidden');
    return;
  }
  faceToken = Object.assign({at:Date.now()}, r);
  if (navigator.vibrate) navigator.vibrate(80);
  faceTimer = setInterval(() => {
    const left = FACE_TOKEN_MS - (Date.now() - faceToken.at);
    if (left <= 0){ clearInterval(faceTimer); faceToken = null; stopScan(); $('#scanBtn').classList.add('hidden'); $('#pfCard').classList.add('hidden');
      faceState('⏱ انتهت صلاحية التحقق — التقط سيلفي جديداً عند وجود رمز الحضور.', 'info');
      $('#faceBtn').textContent = '📸 التقط سيلفي للتحقق من وجهك'; $('#faceBtn').classList.remove('hidden'); return; }
    faceState(`✓ تم التحقق من وجهك — امسح رمز QR أو سجّل في محاضرة مفتوحة خلال ${mmss(left)}`, 'ok');
  }, 1000);
  faceState('✓ تم التحقق من وجهك', 'ok');
  loadOpenLectures();
  if (pendingQR){ const t = pendingQR; pendingQR = null; submitFromText(t); }
  else startScan();
}
async function loadOpenLectures(){
  if (!navigator.onLine || !student || App.mode === 'local') return;
  try{
    const list = (await FS.query('att_live', [['deptId', student.deptId], ['stage', student.stage], ['shift', student.shift], ['open', true], ['mode', 'phoneface']]))
      .filter(l => !l.section || !student.section || l.section === student.section);
    $('#pfCard').classList.toggle('hidden', !list.length);
    $('#pfList').innerHTML = list.map(l => `<div class="spot" style="font-size:16px;flex-wrap:wrap">
      <span>📘 ${esc(l.course)} <span class="note">— ${esc(l.instructorName || '')}</span></span>
      <span class="row">${l.needCode ? `<input data-pfcode="${esc(l.id)}" placeholder="رمز القاعة" inputmode="numeric" dir="ltr" style="width:120px">` : ''}
      <button class="btn green" data-pf="${esc(l.id)}" data-ms="${l.slotMs || PF_SLOT_MS}" data-need="${l.needCode ? 1 : 0}">✓ سجّل حضوري</button></span></div>`).join('');
  }catch(e){ console.warn('open lectures', e); }
}
$('#pfList').onclick = e => {
  const b = e.target.closest('button[data-pf]'); if (!b) return;
  if (!faceValid()) return stResult('التقط سيلفي أولاً', 'err');
  const code = b.dataset.need === '1' ? ($(`input[data-pfcode="${b.dataset.pf}"]`).value || '').trim() : '';
  if (b.dataset.need === '1' && !/^\d{6}$/.test(code)) return stResult('اكتب رمز القاعة الظاهر على شاشة التدريسي (٦ أرقام)', 'err');
  const now = Date.now(), face = faceToken; faceToken = null; clearInterval(faceTimer);
  stopScan(); $('#scanBtn').classList.add('hidden'); $('#pfCard').classList.add('hidden');
  faceState('✓ تم التحقق من وجهك وإرسال الحضور', 'ok');
  submitCheckin(b.dataset.pf, Math.floor(now / +b.dataset.ms), code, now, face);
};
// ربط الحساب بهاتف واحد، والهاتف بحساب واحد (يمنع الدخول بحساب زميل على نفس الهاتف)
async function bindDevice(st){
  if (App.mode === 'local' || st.boundDevice === deviceId) return true;
  const other = st.boundDevice && st.boundDevice !== deviceId;
  if (!navigator.onLine) return other ? '⚠ حسابك مربوط بهاتف آخر. اتصل بالإنترنت أولاً.' : '⚠ أول دخول على هذا الهاتف يحتاج اتصالاً بالإنترنت لربط حسابك به.';
  const uid = auth.currentUser.uid, b = db.batch(), FV = firebase.firestore.FieldValue;
  b.set(db.collection('att_devices').doc(deviceId), {uid, deptId:st.deptId, collegeId:st.collegeId, at:FV.serverTimestamp()});
  b.update(db.collection('att_stu').doc(uid), {boundDevice:deviceId, boundAt:FV.serverTimestamp(), binds:FV.increment(1)});
  try{ await b.commit(); st.boundDevice = deviceId; if (other) toast('تم نقل حسابك إلى هذا الهاتف', 'ok'); return true; }
  catch(e){
    console.warn('bind', e);
    if (e.code !== 'permission-denied') return '⚠ تعذّر التحقق من الهاتف: ' + esc(fbErr(e));
    return other
      ? '🔒 <b>حسابك مربوط بهاتف آخر.</b><br>لكل طالب هاتف واحد فقط. إذا غيّرت هاتفك أو مسحت بيانات المتصفح، راجع موظف التسجيل في قسمك لفك ربط الهاتف القديم.'
      : '🔒 <b>هذا الهاتف مربوط بحساب طالب آخر.</b><br>لا يمكن استخدام هاتف واحد لأكثر من طالب. سجّل الدخول من هاتفك الشخصي.';
  }
}
function stConn(){ const el = $('#stConn'); el.textContent = navigator.onLine ? 'متصل ✓' : 'غير متصل'; el.className = 'pill ' + (navigator.onLine ? 'ok' : 'err'); }
window.addEventListener('online', stConn); window.addEventListener('offline', stConn);
$('#stLogout').onclick = () => { stopScan(); auth.signOut(); };
function stResult(msg, cls){ $('#stResult').innerHTML = `<div class="result ${cls}">${esc(msg)}</div>`; }
function parseQR(text){
  let a = text;
  try{ const u = new URL(text); a = u.searchParams.get('a') || ''; }catch(e){}
  const m = /^([A-Za-z0-9_-]{6,})\.(\d+)\.(\d{6})(\.f)?$/.exec(a || '');
  return m ? {liveId:m[1], slot:+m[2], code:m[3], face:!!m[4]} : null;
}
async function submitFromText(text){
  const q = parseQR(text);
  if (!q) return stResult('هذا ليس رمز حضور صالحاً', 'err');
  const capturedAt = Date.now(), hasPrint = (student.p || []).length > 0;
  if (hasPrint && !faceValid()){ pendingQR = text; return doSelfie(); } // السيلفي أولاً
  if (!hasPrint && q.face) return stResult('✗ هذه المحاضرة تتطلب التحقق من الوجه، ولا توجد بصمة وجه لحسابك — راجع القسم.', 'err');
  const face = hasPrint ? faceToken : null;
  if (face){ faceToken = null; clearInterval(faceTimer); faceState('✓ تم التحقق من وجهك ومسح الرمز', 'ok'); $('#pfCard').classList.add('hidden'); }
  submitCheckin(q.liveId, q.slot, q.code, capturedAt, face);
}
/* ---- تحقق الوجه على هاتف الطالب (سيلفي + حركة الرأس) ---- */
let stModels = null;
function loadStudentModels(){
  if (stModels) return stModels;
  stModels = (async () => {
    if (typeof faceapi === 'undefined') return false;
    try{
      if (faceapi.tf){ try{ await faceapi.tf.setBackend('webgl'); }catch(e){} await faceapi.tf.ready(); }
      await Promise.all([faceapi.nets.tinyFaceDetector.loadFromUri(MODEL_URL), faceapi.nets.faceLandmark68Net.loadFromUri(MODEL_URL), faceapi.nets.faceRecognitionNet.loadFromUri(MODEL_URL)]);
      return true;
    }catch(e){ console.warn('student models', e); stModels = null; return false; }
  })();
  return stModels;
}
async function verifyFace(){
  stopScan(); $('#scanBtn').classList.add('hidden');
  const prints = (student.p || []).map(decDesc);
  if (!prints.length) return {ok:false, why:'noprint'};
  stResult('⏳ جارٍ تجهيز التحقق من الوجه...', 'info');
  if (!(await loadStudentModels())) return {ok:false, why:'nomodel'};
  let stream;
  try{ stream = await navigator.mediaDevices.getUserMedia({audio:false, video:{facingMode:'user', width:{ideal:640}, height:{ideal:480}}}); }
  catch(e){ return {ok:false, why:'nocam'}; }
  const v = $('#scanVideo'); v.srcObject = stream; v.style.transform = 'scaleX(-1)'; $('#scanArea').classList.remove('hidden');
  try{ await v.play(); }catch(e){}
  const opts = new faceapi.TinyFaceDetectorOptions({inputSize:320, scoreThreshold:0.5});
  const t0 = Date.now(); let phase = 0, good = 0, bad = 0, best = 9, thumb = '', result = null;
  const snap = det => { try{ const b = det.detection.box, c = document.createElement('canvas'); c.width = c.height = 96;
    const pad = b.width * 0.25; c.getContext('2d').drawImage(v, b.x - pad, b.y - pad, b.width + 2 * pad, b.height + 2 * pad, 0, 0, 96, 96);
    return c.toDataURL('image/jpeg', 0.6); }catch(e){ return ''; } };
  while (!result){
    if (Date.now() - t0 > 30000){ result = {ok:false, why:'timeout'}; break; }
    let det = null;
    try{ det = await faceapi.detectSingleFace(v, opts).withFaceLandmarks().withFaceDescriptor(); }catch(e){}
    if (!det){ stResult('🙂 ضع وجهك أمام الكاميرا الأمامية', 'info'); await new Promise(r => setTimeout(r, 150)); continue; }
    const d = Math.min(...prints.map(p => faceapi.euclideanDistance(p, det.descriptor)));
    best = Math.min(best, d); if (!thumb || d <= best) thumb = snap(det);
    if (d > FACE_MATCH_MAX){ bad++; stResult('⚠ الوجه لا يطابق صاحب الحساب', 'err'); if (bad >= 12){ thumb = snap(det); result = {ok:false, why:'mismatch', d:+d.toFixed(3)}; } continue; }
    good++;
    const off = Math.abs(yawRatio(det.landmarks.positions) - 0.5);
    if (phase === 0 && off < 0.08) phase = 1;
    else if (phase === 1 && off > 0.15) phase = 2;
    else if (phase === 2 && off < 0.09 && good >= 3) result = {ok:true, d:+best.toFixed(3)};
    if (!result) stResult(phase < 2 ? '↔ أدِر رأسك قليلاً يميناً أو يساراً' : '🙂 انظر إلى الكاميرا مجدداً', 'info');
  }
  stream.getTracks().forEach(t => t.stop()); v.srcObject = null; v.style.transform = ''; $('#scanArea').classList.add('hidden');
  result.thumb = thumb;
  return result;
}
// قائمة انتظار على الهاتف: يُحفظ الحضور أولاً ثم يُرفع (فوراً، أو عند توفر الإنترنت)
const QKEY = 'fa_qr_queue';
const qGet = () => LS.get(QKEY, []);
const qSet = q => LS.set(QKEY, q);
async function submitCheckin(liveId, slot, code, capturedAt, face){
  if (!student) return;
  const uid = auth.currentUser.uid;
  const item = {liveId, slot, code, uid, sid:student.sid, capturedAt:capturedAt || Date.now(), savedAt:Date.now()};
  if (face){ item.face = {ok:!!face.ok, why:face.why || '', d:face.d == null ? null : face.d}; item.selfie = face.thumb || ''; }
  qSet(qGet().filter(x => !(x.liveId === liveId && x.uid === uid)).concat([item]));
  if (navigator.vibrate) navigator.vibrate(120);
  if (!navigator.onLine){
    stResult('📥 حُفظ حضورك على هاتفك (لا يوجد إنترنت). سيُرفع تلقائياً عند الاتصال — افتح التطبيق حينها.', 'info');
    renderQueue(); return;
  }
  if (face && !face.ok) stResult('⚠ لم يتحقق وجهك — سيُرسل الحضور مع صورتك، وقد يرفضه التدريسي.', 'err');
  else stResult('جارٍ إرسال الحضور...', 'info');
  await flushQueue(item);
}
async function sendItem(it){
  const doc = {sid:it.sid, slot:it.slot, code:it.code, deviceId, capturedAt:it.capturedAt, at:TS};
  if (it.face){ doc.face = it.face; doc.selfie = it.selfie || ''; }
  const w = DB.set(`att_live/${it.liveId}/c`, it.uid, doc);
  await Promise.race([w.p, new Promise((_, rej) => setTimeout(() => rej({code:'timeout'}), 12000))]);
}
// عند رفض الخادم: نحدد السبب الحقيقي ونعالجه إن أمكن (مثل هاتف غير مربوط بعد التحديث)
async function diagnoseDenied(it){
  try{
    const [live, me] = await Promise.all([FS.get('att_live', it.liveId), FS.get('att_stu', auth.currentUser.uid)]);
    if (!live) return {retry:true, msg:'📥 محفوظ على هاتفك — المحاضرة لم تصل إلى الخادم بعد من جهاز التدريسي، وسيُعاد الإرسال تلقائياً.'};
    if (!me) return {retry:false, msg:'✗ حسابك غير مسجّل كطالب في النظام. راجع موظف التسجيل.'};
    if (me.deptId !== live.deptId) return {retry:false, msg:'✗ هذه المحاضرة ليست لقسمك.'};
    if (me.sid !== it.sid) return {retry:false, msg:'✗ بيانات حسابك لا تطابق. سجّل الخروج ثم الدخول من جديد.'};
    if (me.boundDevice !== deviceId){
      const b = await bindDevice(Object.assign(student, me));
      return b === true ? {again:true} : {retry:false, msg:String(b).replace(/<[^>]+>/g, '')};
    }
    const until = tsMillis(live.acceptUntil) || Date.parse(live.acceptUntil || 0);
    if (!live.open && until && Date.now() > until) return {retry:false, msg:'✗ انتهت مهلة التسجيل لهذه المحاضرة.'};
    return {retry:true, msg:'⚠ رفض الخادم التسجيل (permission-denied). أبلغ رئيس القسم: قد تكون قواعد Firebase غير محدّثة. سيُعاد الإرسال تلقائياً.'};
  }catch(e){ console.warn('diagnose', e); return {retry:true, msg:'📥 محفوظ على هاتفك — سيُعاد الإرسال تلقائياً.'}; }
}
let flushing = false;
async function flushQueue(current){
  if (flushing || !student || !navigator.onLine || !auth || !auth.currentUser) return;
  flushing = true;
  const uid = auth.currentUser.uid;
  for (const it of qGet().filter(x => x.uid === uid)){
    let done = false, msg = null, cls = 'ok';
    try{ await sendItem(it); done = true; msg = it.capturedAt < Date.now() - 60000
      ? '✓ رُفع حضورك المحفوظ على الهاتف، وسيُضاف إلى المحاضرة تلقائياً.' : '✓ أُرسل حضورك. تأكد من ظهور اسمك على شاشة التدريسي.'; }
    catch(e){
      console.warn('send', e.code, e.message);
      const old = Date.now() - it.savedAt > QR_ACCEPT_DAYS * 86400000;
      if (e.code === 'permission-denied' && old){ done = true; msg = 'لم يُقبل حضور قديم محفوظ على الهاتف (انتهت المهلة).'; cls = 'err'; }
      else if (e.code === 'permission-denied'){
        const dg = await diagnoseDenied(it);
        if (dg.again){ try{ await sendItem(it); done = true; msg = '✓ أُرسل حضورك. تأكد من ظهور اسمك على شاشة التدريسي.'; cls = 'ok'; }catch(x){ msg = '⚠ رفض الخادم التسجيل بعد ربط الهاتف. أبلغ رئيس القسم.'; cls = 'err'; } }
        else { msg = dg.msg; cls = dg.retry ? 'info' : 'err'; if (!dg.retry) done = true; }
      }
      else { msg = e.code === 'timeout' ? '📥 محفوظ على هاتفك — الإنترنت ضعيف، سيُعاد الإرسال تلقائياً.' : '📥 محفوظ على هاتفك — سيُعاد الإرسال تلقائياً (' + (e.code || e.message || 'خطأ') + ').'; cls = 'info'; }
    }
    if (done) qSet(qGet().filter(x => !(x.liveId === it.liveId && x.uid === it.uid)));
    if ((current && it.liveId === current.liveId) || (!current && done)) stResult(msg, cls);
  }
  flushing = false; renderQueue();
}
function renderQueue(){
  const n = student && auth && auth.currentUser ? qGet().filter(x => x.uid === auth.currentUser.uid).length : 0;
  let el = $('#stQueue');
  if (!el){ el = document.createElement('div'); el.id = 'stQueue'; el.className = 'note'; el.style.textAlign = 'center'; $('#stResult').after(el); }
  el.textContent = n ? `📥 ${n} حضور محفوظ على الهاتف بانتظار الرفع` : '';
}
window.addEventListener('online', () => { stConn(); flushQueue(); });
setInterval(() => { if (student) flushQueue(); }, 30000);
$('#mSend').onclick = async () => {
  const pin = $('#mPin').value.trim(), code = $('#mCode').value.trim();
  if (!/^\d{6}$/.test(pin) || !/^\d{6}$/.test(code)) return stResult('اكتب رقم المحاضرة والرمز (٦ أرقام لكل منهما)', 'err');
  if (!navigator.onLine) return stResult('الإدخال اليدوي يحتاج إنترنت — دون اتصال امسح رمز QR بالكاميرا', 'err');
  const capturedAt = Date.now();
  try{
    const list = await FS.query('att_live', [['pin', pin], ['open', true]]);
    if (!list.length) return stResult('لا توجد محاضرة مفتوحة بهذا الرقم', 'err');
    const hasPrint = (student.p || []).length > 0;
    if (hasPrint && !faceValid()) return stResult('التقط سيلفي أولاً (الزر في الأعلى)، ثم أرسل الرمز.', 'err');
    if (!hasPrint && list[0].face) return stResult('✗ هذه المحاضرة تتطلب التحقق من الوجه، ولا توجد بصمة وجه لحسابك.', 'err');
    const face = hasPrint ? faceToken : null; faceToken = null; clearInterval(faceTimer);
    submitCheckin(list[0].id, Math.floor(capturedAt / (list[0].slotMs || SLOT_MS)), code, capturedAt, face);
  }catch(e){ stResult('تعذّر البحث عن المحاضرة: ' + fbErr(e), 'err'); }
};
$('#scanBtn').onclick = () => startScan();
const inAppBrowser = () => /FBAN|FBAV|FB_IAB|Instagram|WhatsApp|Line\/|Telegram|Snapchat|MicroMessenger|TikTok|; wv\)/i.test(navigator.userAgent);
const isIOS = () => /iPhone|iPad|iPod/i.test(navigator.userAgent);
function camHelp(html){ const el = $('#camHelp'); el.innerHTML = html || ''; el.classList.toggle('hidden', !html); }
async function startScan(){
  if (scanOn) return;
  camHelp(''); $('#scanBtn').classList.add('hidden');
  if (!window.isSecureContext) return camFail('insecure');
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) return camFail(inAppBrowser() ? 'inapp' : 'unsupported');
  const tries = [
    {audio:false, video:{facingMode:{ideal:'environment'}, width:{ideal:1280}, height:{ideal:720}}},
    {audio:false, video:{facingMode:'environment'}},
    {audio:false, video:true}];
  let err = null; scanStream = null;
  for (const c of tries){
    try{ scanStream = await navigator.mediaDevices.getUserMedia(c); break; }
    catch(e){ err = e; console.warn('camera', e.name, e.message); if (e.name === 'NotAllowedError' || e.name === 'SecurityError') break; }
  }
  if (!scanStream) return camFail(err && err.name, err);
  if (!(await ensureQRDecoder())){ // آيفون لا يملك قارئ QR مدمجاً في المتصفح، فيحتاج مكتبة jsQR
    scanStream.getTracks().forEach(t => t.stop()); scanStream = null;
    return camFail('nodecoder');
  }
  const v = $('#scanVideo'); v.setAttribute('playsinline', ''); v.setAttribute('muted', ''); v.muted = true; v.srcObject = scanStream;
  $('#scanArea').classList.remove('hidden');
  try{ await v.play(); }
  catch(e){ stopScan(); camHelp('اضغط زر <b>"تشغيل الكاميرا ومسح رمز الحضور"</b> لبدء المسح.'); return; }
  scanOn = true; $('#stResult').innerHTML = ''; scanLoop();
}
function camFail(kind, e){
  stopScan();
  const perm = isIOS()
    ? 'افتح <b>الإعدادات ← Safari ← الكاميرا ← سماح</b>، أو اضغط <b>ᴬA</b> في شريط العنوان ← إعدادات موقع الويب ← الكاميرا ← سماح، ثم أعد تحميل الصفحة.'
    : 'اضغط على <b>🔒 أو ⓘ</b> بجانب الرابط في الأعلى ← <b>الأذونات</b> ← <b>الكاميرا</b> ← <b>سماح</b>، ثم أعد تحميل الصفحة. (للتطبيق المثبّت: اضغط مطولاً على أيقونته ← معلومات التطبيق ← الأذونات ← الكاميرا).';
  const msgs = {
    inapp:'⚠ فتحت الرابط من داخل تطبيق (واتساب أو تلغرام أو فيسبوك...)، وهذه المتصفحات الداخلية تمنع الكاميرا.<br>اضغط <b>⋮</b> أو <b>…</b> أعلى الشاشة ← <b>فتح في Chrome</b> (أندرويد) أو <b>فتح في Safari</b> (آيفون)، ثم ثبّت التطبيق.',
    insecure:'⚠ يجب فتح النظام عبر رابط يبدأ بـ https.',
    unsupported:'⚠ هذا المتصفح لا يدعم الكاميرا. استخدم <b>Chrome</b> على أندرويد أو <b>Safari</b> على الآيفون.',
    NotAllowedError:'⚠ تم رفض إذن الكاميرا.<br>' + perm,
    SecurityError:'⚠ المتصفح منع الكاميرا.<br>' + perm,
    NotFoundError:'⚠ لم يُعثر على كاميرا في هذا الجهاز.',
    nodecoder:'⚠ تعذّر تحميل قارئ رمز QR (يحتاج إنترنت عند أول استخدام). اتصل بالإنترنت ثم اضغط الزر مجدداً — بعدها يعمل دون اتصال.',
    NotReadableError:'⚠ الكاميرا مستخدمة من تطبيق آخر. أغلق تطبيقات الكاميرا والاتصال المرئي (واتساب، زووم...) ثم اضغط الزر مجدداً.',
    AbortError:'⚠ توقفت الكاميرا. اضغط الزر مجدداً.',
    OverconstrainedError:'⚠ تعذّر تشغيل الكاميرا بالإعدادات المطلوبة. اضغط الزر مجدداً.'
  };
  camHelp((msgs[kind] || ('⚠ تعذّر تشغيل الكاميرا' + (e ? ` (${esc(e.name)})` : ''))) + '<br><span class="note">يمكنك أيضاً إدخال الرمز يدوياً من الأسفل.</span>');
}
function stopScan(){
  scanOn = false; if (scanStream){ scanStream.getTracks().forEach(t => t.stop()); scanStream = null; }
  const v = $('#scanVideo'); if (v) v.srcObject = null; $('#scanArea') && $('#scanArea').classList.add('hidden');
  if ($('#scanBtn') && (!student || !(student.p || []).length || faceValid())) $('#scanBtn').classList.remove('hidden');
}
$('#scanStop').onclick = stopScan;
let barcodeDetector = null;
try{ if ('BarcodeDetector' in window) barcodeDetector = new BarcodeDetector({formats:['qr_code']}); }catch(e){ barcodeDetector = null; }
const scanCanvas = document.createElement('canvas');
const JSQR_SOURCES = ['https://cdn.jsdelivr.net/npm/jsqr@1.4.0/dist/jsQR.js', 'https://unpkg.com/jsqr@1.4.0/dist/jsQR.js', 'https://cdnjs.cloudflare.com/ajax/libs/jsQR/1.4.0/jsQR.min.js'];
function loadScript(src, ms=8000){
  return new Promise(res => {
    const el = document.createElement('script'); el.src = src; el.async = true;
    const t = setTimeout(() => { el.remove(); res(false); }, ms);
    el.onload = () => { clearTimeout(t); res(true); }; el.onerror = () => { clearTimeout(t); el.remove(); res(false); };
    document.head.appendChild(el);
  });
}
async function ensureQRDecoder(){
  if (barcodeDetector || typeof jsQR !== 'undefined') return true;
  for (const src of JSQR_SOURCES){ if (await loadScript(src) && typeof jsQR !== 'undefined') return true; }
  return false;
}
async function scanLoop(){
  if (!scanOn) return;
  const v = $('#scanVideo'); let text = null;
  if (v.readyState >= 2 && !scanBusy){
    scanBusy = true;
    try{
      if (barcodeDetector){
        try{ const r = await barcodeDetector.detect(v); if (r.length) text = r[0].rawValue; }
        catch(e){ console.warn('BarcodeDetector', e); barcodeDetector = null; } // يتحول إلى jsQR
      }
      else if (typeof jsQR !== 'undefined'){
        const w = v.videoWidth, h = v.videoHeight, sc = Math.min(1, 640 / Math.max(w, h));
        scanCanvas.width = Math.round(w * sc); scanCanvas.height = Math.round(h * sc);
        const ctx = scanCanvas.getContext('2d', {willReadFrequently:true}); ctx.drawImage(v, 0, 0, scanCanvas.width, scanCanvas.height);
        const img = ctx.getImageData(0, 0, scanCanvas.width, scanCanvas.height), r = jsQR(img.data, img.width, img.height);
        if (r) text = r.data;
      } else { stopScan(); return camFail('nodecoder'); }
    }catch(e){ console.error(e); }
    scanBusy = false;
  }
  if (text && parseQR(text)){ stopScan(); return submitFromText(text); }
  setTimeout(scanLoop, 200);
}

/* =====================================================================
   الإصدار 5: الرئيسية + الإعلانات + الواجبات والتقارير + الإشعارات + جسر Google
   ===================================================================== */
const myUid = () => App.mode === 'local' ? ((student && student.uid) || (App.user && App.user.uid) || 'local') : (auth && auth.currentUser ? auth.currentUser.uid : '');
const deptF = d => is('dean') ? [['collegeId', d.collegeId], ['deptId', d.id]] : [['deptId', d.id]];
const msOf = v => v == null ? 0 : typeof v === 'string' ? (Date.parse(v) || 0) : (tsMillis(v) || 0);
const DAY = 864e5;
function ago(ms){
  if (!ms) return ''; const s = (Date.now() - ms) / 1000;
  if (s < 60) return 'الآن'; if (s < 3600) return `قبل ${Math.round(s / 60)} دقيقة`; if (s < 86400) return `قبل ${Math.round(s / 3600)} ساعة`;
  const d = Math.round(s / 86400); return d === 1 ? 'أمس' : d < 30 ? `قبل ${d} أيام` : new Date(ms).toLocaleDateString('ar-IQ');
}
const fmtDue = ms => { const d = new Date(ms); return d.toLocaleDateString('ar-IQ', {weekday:'long', day:'numeric', month:'numeric'}) + ' — ' + d.toLocaleTimeString('ar-IQ', {hour:'numeric', minute:'2-digit'}); };
const fmtShort = ms => ms ? new Date(ms).toLocaleString('ar-IQ', {day:'numeric', month:'numeric', hour:'numeric', minute:'2-digit'}) : '—';
function leftTxt(ms){
  const d = ms - Date.now(); if (d <= 0) return 'انتهى الموعد';
  const h = Math.floor(d / 3600000); if (h < 1) return `متبقٍ ${Math.max(1, Math.ceil(d / 60000))} دقيقة`; if (h < 24) return `متبقٍ ${h} ساعة`;
  const dd = Math.floor(h / 24); return `متبقٍ ${dd} يوم` + (h % 24 ? ` و ${h % 24} ساعة` : '');
}
const fsize = n => n >= 1048576 ? (n / 1048576).toFixed(1) + 'MB' : Math.max(1, Math.round((n || 0) / 1024)) + 'KB';
const fext = n => (String(n).split('.').pop() || '').toLowerCase();
const ftype = n => { const e = fext(n); return ['jpg','jpeg','png','webp','heic','gif'].includes(e) ? 'IMG' : e === 'pdf' ? 'PDF' : ['doc','docx'].includes(e) ? 'DOC' : (e.slice(0, 4).toUpperCase() || 'FILE'); };
const isImg = f => /^image\//.test(f.type || '') || ['jpg','jpeg','png','webp','heic','gif'].includes(fext(f.name));
const tkey = t => { let h = 5381; for (let i = 0; i < t.length; i++) h = ((h << 5) + h + t.charCodeAt(i)) >>> 0; return 'k' + h.toString(36) + t.length; };
const greet = () => { const h = new Date().getHours(); return h < 12 ? 'صباح الخير' : 'مساء الخير'; };
const shortName = n => String(n || '').replace(/^(د\.|م\.د\.?|م\.|أ\.د\.?|أ\.م\.د\.?|أ\.)\s*/, '').trim().split(/\s+/).slice(0, 2).join(' ');
async function orgCfg(){ if (App.org) return App.org; if (!stOrg){ try{ stOrg = await DB.get('att_org', 'main'); }catch(e){} } return stOrg || {}; }
/* ---------- الإشعارات داخل التطبيق ---------- */
const NT_ICON = {exc_ok:['✅','g'], exc_no:['⛔','r'], warn:['⚠️','w'], res:['🎓','b'], ann:['📣','b'], info:['🔔','b']};
async function notify(targets, n, d){
  d = d || App.dept; const list = targets.filter(t => t && t.u); if (!list.length || !d) return 0;
  list.forEach(t => bg(DB.set('att_notif', null, {uid:t.u, sid:t.sid || '', deptId:d.id, collegeId:d.collegeId, t:n.t, title:n.title, body:n.body || '', link:n.link || '',
    at:nowISO(), atMs:Date.now(), read:false, by:App.user ? App.user.uid : ''}).p));
  return list.length;
}
// ربط الإشعارات بالإجراءات الموجودة
$('#wNotify').onclick = async () => {
  if (!warnRows.length) return toast('لا توجد حالات', 'err');
  const map = Object.fromEntries(deptStudents().map(s => [s.id, s]));
  const rows = warnRows.filter(r => map[r.sid] && map[r.sid].u);
  if (!rows.length) return toast('لا يوجد لهؤلاء الطلبة حسابات في النظام', 'err');
  if (!(await confirmBox('إشعار الطلبة', `سيصل إشعار إلى ${new Set(rows.map(r => r.sid)).size} طالب بحالته في كل مادة (${rows.length} إشعار).`, 'إرسال'))) return;
  rows.forEach(r => notify([{u:map[r.sid].u, sid:r.sid}], {t:'warn', title:`${ST_LABEL[r.status][0]} — ${r.course}`,
    body:`نسبة غيابك ${r.pt.toFixed(1)}% (بدون عذر ${r.pu.toFixed(1)}%). ${r.status === 'dep' ? 'راجع رئيس القسم.' : 'انتبه لحضورك.'}`}));
  audit('إشعار الطلبة بالإنذارات', `${rows.length} إشعار`); toast('أُرسلت الإشعارات ✓', 'ok');
};

/* ---------- الإعلانات ---------- */
let annList = [], annDept = null;
const annTgt = a => [a.stage || 'كل المراحل', a.shift || 'كل الدراسات', a.section ? 'شعبة ' + a.section : 'كل الشعب'].join(' — ');
const annMatch = (a, s) => (!a.stage || a.stage === s.stage) && (!a.shift || a.shift === s.shift) && (!a.section || a.section === (s.section || ''));
function annOpts(){
  const d = App.dept || {}, o = (arr, all) => `<option value="">${all}</option>` + (arr || []).map(x => `<option>${esc(x)}</option>`).join('');
  [['#anStage', d.stages, 'كل المراحل'], ['#anShift', d.shifts, 'كل الدراسات'], ['#anSection', d.sections, 'كل الشعب']].forEach(([id, arr, all]) => { const v = $(id).value; $(id).innerHTML = o(arr, all); $(id).value = (arr || []).includes(v) ? v : ''; });
  annCount();
}
function annCount(){
  if (!canManageStudents()) return $('#anCount').textContent = '';
  const a = {stage:$('#anStage').value, shift:$('#anShift').value, section:$('#anSection').value};
  const n = deptStudents().filter(s => annMatch(a, s)).length;
  $('#anCount').textContent = `سيظهر الإعلان لـ ${n} طالب.`;
}
['#anStage','#anShift','#anSection'].forEach(x => $(x).onchange = annCount);
async function loadAnn(force){
  const d = App.dept; if (!d) { annList = []; return annList; }
  if (!force && annDept === d.id) return annList;
  try{ annList = (await DB.query('att_ann', deptF(d))).sort((a, b) => (b.pin ? 1 : 0) - (a.pin ? 1 : 0) || (b.atMs || 0) - (a.atMs || 0)); annDept = d.id; }
  catch(e){ console.warn('ann', e); annList = []; }
  return annList;
}
const annHTML = (a, del) => `<div class="ann${a.pin ? ' pin' : ''}"><div class="row" style="justify-content:space-between;flex-wrap:nowrap"><b>${a.pin ? '📌 ' : ''}${esc(a.title)}</b>${del ? `<button class="btn sm light" data-andel="${esc(a.id)}">حذف</button>` : ''}</div>
  <div class="note">إلى: ${esc(annTgt(a))} · ${esc(a.byName || '')} · ${ago(a.atMs)}</div>${a.body ? `<p>${esc(a.body)}</p>` : ''}</div>`;
async function renderAnnTab(force){
  annOpts();
  $('#annForm').classList.toggle('hidden', !is('super','dean','head','registrar'));
  await loadAnn(force);
  $('#anList').innerHTML = annList.map(a => annHTML(a, is('super','dean','head','registrar'))).join('') || '<div class="empty">لا توجد إعلانات بعد</div>';
}
$('#anReload').onclick = () => renderAnnTab(true);
$('#anList').onclick = async e => {
  const b = e.target.closest('[data-andel]'); if (!b) return;
  if (!(await confirmBox('حذف الإعلان', 'سيختفي الإعلان من حسابات الطلبة.', 'حذف'))) return;
  try{ await DB.del('att_ann', b.dataset.andel).p; renderAnnTab(true); }catch(err){ toast('تعذّر الحذف: ' + fbErr(err), 'err'); }
};
$('#anSend').onclick = async () => {
  const d = App.dept, title = $('#anTitle').value.trim(), body = $('#anBody').value.trim();
  if (!d) return toast('اختر القسم أولاً', 'err'); if (!title) return toast('اكتب عنوان الإعلان', 'err');
  const a = {collegeId:d.collegeId, deptId:d.id, term:(App.org || {}).term || '', stage:$('#anStage').value, shift:$('#anShift').value, section:$('#anSection').value,
    title, body, pin:$('#anPin').checked, by:App.user.uid, byName:App.user.name || ROLES[role()], byRole:ROLES[role()], at:nowISO(), atMs:Date.now()};
  $('#anSend').disabled = true;
  try{
    await DB.set('att_ann', null, a).p;
    audit('نشر إعلان', `${title} — ${annTgt(a)}`);
    toast('نُشر الإعلان ✓', 'ok'); $('#anTitle').value = ''; $('#anBody').value = ''; $('#anPin').checked = false; renderAnnTab(true);
  }catch(e){ toast('تعذّر النشر: ' + fbErr(e), 'err'); }
  $('#anSend').disabled = false;
};

/* ---------- الصفحة الرئيسية للكادر ---------- */
let homeCache = {key:'', at:0, data:null};
function kp(icon, cls, val, label, go){ return `<div class="kp"${go ? ` data-go="${go}"` : ''}><div class="ib av ${cls}">${icon}</div><div><b>${val}</b><span>${label}</span></div></div>`; }
const attPct = list => { let p = 0, a = 0; list.forEach(s => { p += (s.present || []).length; a += (s.absentees || []).length; }); return p + a ? Math.round(p / (p + a) * 100) : null; };
const pendLi = (cls, ch, title, sub, chip, chipCls, go) => `<div class="li"${go ? ` data-go="${go}"` : ''}><div class="av ${cls}">${ch}</div><div class="t"><b>${title}</b><small>${sub}</small></div><span class="badge ${chipCls}">${chip}</span></div>`;
async function homeRemote(force){
  const d = App.dept, key = (d ? d.id : '-') + '|' + role() + '|' + (App.user && App.user.uid) + '|' + (App.org ? App.org.term : '');
  if (!force && homeCache.key === key && Date.now() - homeCache.at < 60000) return homeCache.data;
  const out = {ex:[], gs:[]};
  if (d && App.org){
    const T = App.org.term, jobs = [loadAnn(true)];
    if (is('super','dean','head')) jobs.push(DB.query('att_excuses', deptF(d).concat([['term', T]])).then(l => out.ex = l.filter(x => x.status === 'pending')).catch(() => {}),
      DB.query('att_grades', deptF(d).concat([['term', T]])).then(l => out.gs = l).catch(() => {}));
    await Promise.all(jobs);
  }
  homeCache = {key, at:d && App.org ? Date.now() : 0, data:out}; return out;
}
async function renderHome(force){
  if (!App.user) return;
  const d = App.dept, u = App.user, active = $('#tHome').classList.contains('active');
  const R = await homeRemote(force);
  updateBadges(R);
  if (!active) return;
  $('#hHello').textContent = `${greet()}، ${shortName(u.name) || ROLES[role()]} 👋`;
  $('#hSub').textContent = `${ROLES[role()]}${d ? ' — ' + d.name : ''} — ${new Date().toLocaleDateString('ar-IQ', {weekday:'long', day:'numeric', month:'long', year:'numeric'})}`;
  const T = App.org && App.org.term, sess = App.sessions.filter(s => !T || s.term === T), todayS = sess.filter(s => s.date === today());
  const mgr = is('super','dean','head','registrar'), stu = canManageStudents() ? deptStudents() : [];
  const absRows = deptAbsenceRows(), warnSids = new Set(absRows.filter(r => r.status !== 'ok').map(r => r.sid)), depRows = absRows.filter(r => r.status === 'dep');
  const tp = attPct(todayS), termP = attPct(sess);
  let k;
  if (mgr) k = [kp('✓', 'g', tp == null ? '—' : tp + '%', todayS.length ? `نسبة الحضور اليوم (${todayS.length} محاضرة)` : 'لا محاضرات مسجّلة اليوم', 'tRecords'),
    kp('👥', 'b', stu.length, `طالب — ${stu.filter(s => s.prints.length).length} بصمة مسجّلة`, 'tStudents'),
    kp('⚠', 'w', warnSids.size, 'طالب لديه إنذار أو حرمان', 'tRecords'),
    is('super','dean','head') ? kp('📄', 'v', R.ex.length, 'أعذار بانتظار القرار', 'tExcuses') : kp('🔑', 'v', stu.filter(s => !s.u).length, 'طالب بلا حساب', 'tStudents')];
  else if (is('instructor')){
    const dow = new Date().getDay(), mine = (typeof slotList === 'function' ? slotList() : []).filter(s => s.day === dow && s.instr === u.uid);
    k = [kp('📅', 'b', mine.length, 'محاضراتي اليوم', 'tSession'), kp('✓', 'g', termP == null ? '—' : termP + '%', 'نسبة الحضور في محاضراتي', 'tRecords'),
      kp('🗓', 'v', sess.length, 'محاضرة مسجّلة في الفصل', 'tRecords'), kp('⚠', 'w', warnSids.size, 'طالب لديه إنذار أو حرمان', 'tRecords')];
  } else k = [kp('✓', 'g', termP == null ? '—' : termP + '%', 'نسبة الحضور في الفصل', 'tRecords'), kp('🗓', 'b', sess.length, 'محاضرة مسجّلة', 'tRecords'),
    kp('⚠', 'w', warnSids.size, 'طالب لديه إنذار أو حرمان', 'tRecords'), kp('⛔', 'r', new Set(depRows.map(r => r.sid)).size, 'طالب محروم', 'tRecords')];
  $('#hKpis').innerHTML = k.join('');
  animateNums($('#hKpis'));
  // الحضور في آخر الأيام
  const dates = [...new Set(sess.map(s => s.date))].sort().slice(-7);
  $('#hWeek').innerHTML = dates.length ? dates.map(dt => { const p = attPct(sess.filter(s => s.date === dt)) || 0, w = new Date(dt + 'T12:00').toLocaleDateString('ar-IQ', {weekday:'long'});
    return `<div><b>${p}%</b><span class="${p < 80 ? 'low' : ''}" style="height:${Math.max(4, p * 1.2)}px"></span>${w}<small style="font-size:10px">${dt.slice(5).replace('-', '/')}</small></div>`; }).join('')
    : '<div class="empty" style="align-self:center;width:100%">لا توجد محاضرات مسجّلة بعد في هذا الفصل</div>';
  // إجراءات سريعة
  const q = [];
  if (is('super','dean','head','instructor')) q.push(['📷', 'أخذ الحضور', 'tSession']);
  if (mgr) q.push(['📥', 'استيراد طلبة', 'imp']);
  if (mgr) q.push(['📣', 'إعلان جديد', 'tAnn']);
  if (mgr) q.push(['📲', 'باركود الدخول', 'qr']);
  if (is('super','dean','head','committee','instructor')) q.push(['🎓', 'جدول الدرجات', 'tGrades']);
  if (is('super','dean','head','qa')) q.push(['📈', 'تقارير الجودة', 'tQA']);
  if (is('super','dean','head')) q.push(['📄', 'الأعذار', 'tExcuses']);
  q.push(['⚠', 'الإنذارات', 'tRecords']);
  $('#hQuick').innerHTML = q.slice(0, 6).map(([i, t, go]) => `<button data-go="${go}"><span>${i}</span>${t}</button>`).join('');
  // بانتظار القرار
  const P = [];
  if (is('super','dean','head')){
    R.ex.slice(0, 3).forEach(x => P.push(pendLi('w', '📄', `عذر — ${esc(x.name || x.sid)}`, `${esc(x.stage || '')} / ${esc(x.shift || '')} — ${esc(x.from)} إلى ${esc(x.to)}`, 'معلّق', 'b-man', 'tExcuses')));
    if (R.ex.length > 3) P.push(pendLi('w', '+', `${R.ex.length - 3} أعذار أخرى`, 'بانتظار القبول أو الرفض', 'عرض', 'b-man', 'tExcuses'));
    R.gs.filter(g => g.status === 'submitted').slice(0, 3).forEach(g => P.push(pendLi('b', 'س', `سعي مرفوع — ${esc(g.course)}`, `${esc(g.instructorName || '')} — ${esc(g.stage)} / ${esc(g.shift)}`, 'اعتماد', 'b-qr', 'tGrades')));
    if (depRows.length) P.push(pendLi('r', 'ح', `حرمان — ${new Set(depRows.map(r => r.sid)).size} طالب`, `${[...new Set(depRows.map(r => r.course))].slice(0, 2).join('، ')}`, 'مراجعة', 'b-abs', 'tRecords'));
  }
  if (canManageStudents()){
    const dups = Object.keys(dupMap(stu)).length, noP = stu.filter(s => !s.prints.length).length, noU = stu.filter(s => !s.u).length;
    if (dups) P.push(pendLi('v', 'ب', `بصمات متشابهة — ${dups} طالب`, 'يحتاج تدقيقاً', 'تدقيق', 'b-vio', 'tStudents'));
    if (noP && stu.length) P.push(pendLi('b', '👤', `${noP} طالب بلا بصمة وجه`, 'يسجّلها الطالب من هاتفه عند الدخول', 'متابعة', 'b-gray', 'tStudents'));
    if (noU && stu.length) P.push(pendLi('b', '🔑', `${noU} طالب بلا حساب`, 'أنشئ حساباتهم بالاستيراد من Excel', 'إنشاء', 'b-gray', 'tStudents'));
  }
  if (is('instructor')) absRows.filter(r => r.status === 'dep').slice(0, 4).forEach(r => P.push(pendLi('r', 'ح', `${esc(r.name)} — محروم`, `${esc(r.course)} — غياب ${r.pt.toFixed(1)}%`, 'حرمان', 'b-abs', 'tRecords')));
  $('#hPending').innerHTML = P.join('') || '<div class="empty">لا شيء بانتظارك الآن ✓</div>';
  $('#hPendT').textContent = is('instructor') ? '⚠ طلبة محرومون في موادي' : '⏳ بانتظار قرارك';
  // الإعلانات ومحاضرات اليوم
  $('#hAnnBtn').classList.toggle('hidden', !mgr);
  $('#hAnn').innerHTML = annList.slice(0, 3).map(a => annHTML(a, false)).join('') || '<div class="empty">لا توجد إعلانات</div>';
  $('#hToday').innerHTML = todayS.slice(0, 6).map(s => { const p = attPct([s]) || 0, n = (s.present || []).length, t = n + (s.absentees || []).length;
    return `<div class="li" data-go="tRecords"><div class="t"><b>${esc(s.course)}</b><small>${esc(s.stage)} / ${esc(s.shift)}${s.section ? ' / ' + esc(s.section) : ''} · ${esc(s.instructorName || '')}</small><div class="pbar"><i style="width:${p}%;background:${p < 80 ? 'var(--amber)' : 'var(--green)'}"></i></div></div><span class="badge ${p < 80 ? 'b-man' : 'b-face'}">${n}/${t} حاضر</span></div>`; }).join('')
    || '<div class="empty">لم تُسجَّل محاضرات اليوم بعد</div>';
}
function animateNums(el){
  if (window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  el.querySelectorAll('.kp b').forEach(b => { const m = b.textContent.match(/^(\d+)(%?)$/); if (!m || +m[1] < 2) return; const to = +m[1]; let t0 = 0;
    const step = ts => { t0 = t0 || ts; const p = Math.min(1, (ts - t0) / 700); b.textContent = Math.round(to * (1 - Math.pow(1 - p, 3))) + m[2]; if (p < 1) requestAnimationFrame(step); };
    requestAnimationFrame(step); });
}
function updateBadges(R){
  setNavBadge('tExcuses', is('super','dean','head') ? R.ex.length : 0);
  const tot = is('super','dean','head') ? R.ex.length + R.gs.filter(g => g.status === 'submitted').length : 0;
  $('#topBellN').textContent = tot > 99 ? '99+' : tot; $('#topBellN').classList.toggle('hidden', !tot);
}
function setNavBadge(tab, n){ const i = document.querySelector(`nav button[data-tab="${tab}"] .nb`); if (i){ i.textContent = n > 99 ? '99+' : n; i.classList.toggle('hidden', !n); } }
$('#hRefresh').onclick = () => renderHome(true);
$('#topBell').onclick = () => { showTab('tHome'); renderHome(true); };
// أزرار التنقل داخل الصفحات (data-go)
document.addEventListener('click', e => {
  const el = e.target.closest('[data-go]'); if (!el || !$('#appView').contains(el)) return;
  const g = el.dataset.go;
  if (g === 'imp'){ showTab('tStudents'); setTimeout(() => $('#importBtn').click(), 50); return; }
  if (g === 'qr'){ openLoginQR(); return; }
  showTab(g);
});
let homeTimer = null;
const homeSoon = () => { clearTimeout(homeTimer); homeTimer = setTimeout(() => renderHome(false), 700); };

/* ---------- واجهة الطالب: الرئيسية، الإشعارات، حسابي ---------- */
let stAnns = [], stNotifs = [];
const stSeenKey = () => 'st_seen_' + myUid();
function stTab(id){
  if (id !== 'stHome') stopScan();
  $$('#studentView .st-tab').forEach(x => x.classList.toggle('active', x.id === id));
  $$('#stTabs button').forEach(b => b.classList.toggle('on', b.dataset.st === id));
  window.scrollTo(0, 0);
  if (id === 'stAttT'){ $('#stAttLoad').onclick(); loadMyExcuses(); }
  if (id === 'stGrd') $('#stResLoad').onclick();
  if (id === 'stMe') renderStMe();
}
$('#studentView').addEventListener('click', e => { const b = e.target.closest('[data-st]'); if (b) stTab(b.dataset.st); });
const stMine = x => student && x.deptId === student.deptId && (!x.stage || x.stage === student.stage) && (!x.shift || x.shift === student.shift) && (!x.section || x.section === (student.section || ''));
async function stLoadAll(){
  const st = student; if (!st) return; const uid = myUid();
  const q = (c, f) => DB.query(c, f).catch(e => { console.warn(c, e); return []; });
  const [anns, nts] = await Promise.all([q('att_ann', [['deptId', st.deptId]]), q('att_notif', [['uid', uid]])]);
  if (student !== st) return;
  stAnns = anns.filter(a => stMine(a)).sort((a, b) => (b.pin ? 1 : 0) - (a.pin ? 1 : 0) || (b.atMs || 0) - (a.atMs || 0));
  stNotifs = nts.sort((a, b) => (b.atMs || 0) - (a.atMs || 0));
  renderStHome(); renderBell(); stRing();
}
function renderStHome(){
  const list = stAnns.filter(a => a.pin || (a.atMs || 0) > Date.now() - 21 * DAY).slice(0, 3);
  $('#stAnnTop').innerHTML = list.length ? `<div class="card"><h2>📣 إعلانات القسم</h2>${list.map(a => `<div class="ann${a.pin ? ' pin' : ''}"><b>${a.pin ? '📌 ' : ''}${esc(a.title)}</b>
    <div class="note">${esc(a.byName || '')} · ${ago(a.atMs)}</div>${a.body ? `<p>${esc(a.body)}</p>` : ''}</div>`).join('')}</div>` : '';
}
async function stRing(){
  const st = student; if (!st) return;
  try{
    const org = await orgCfg(), uid = myUid();
    const [sessions, myEx, cdoc] = await Promise.all([DB.query('att_sessions', [['deptId', st.deptId], ['stage', st.stage], ['shift', st.shift], ['term', org.term]]),
      DB.query('att_excuses', [['uid', uid]]).catch(() => []), DB.get('att_courses', st.deptId).catch(() => null)]);
    let held = 0, abs = 0;
    sessions.forEach(s => { const a = (s.absentees || []).includes(st.sid), p = (s.present || []).some(x => x.id === st.sid); if (!a && !p) return; held += +s.hours || 0; if (a) abs += +s.hours || 0; });
    const rows = absenceRowsFrom(sessions, myEx.filter(x => x.status === 'approved'), () => getPolicy(cdoc)).filter(r => r.sid === st.sid);
    const ord = {dep:3, w2:2, w1:1, ok:0}, worst = rows.reduce((w, r) => ord[r.status] > ord[w] ? r.status : w, 'ok');
    const pct = held ? Math.round((held - abs) / held * 100) : null;
    const col = worst === 'dep' ? 'var(--red)' : worst !== 'ok' ? 'var(--amber)' : 'var(--green)';
    $('#stRing').style.background = `conic-gradient(${col} 0 ${pct || 0}%,#e5eaf0 0)`;
    $('#stRing').innerHTML = `<div>${pct == null ? '—' : pct + '%'}</div>`;
    $('#stRingTxt').textContent = held ? `غياب ${abs} ساعة من ${held}` : 'لم تُسجَّل محاضرات لك بعد';
    const w = rows.filter(r => r.status === worst && worst !== 'ok').map(r => r.course);
    $('#stRingChip').innerHTML = held ? `<span class="badge ${ST_LABEL[worst][1]}" style="margin-top:6px">${worst === 'ok' ? 'وضعك جيد ✓' : ST_LABEL[worst][0] + ' — ' + esc(w.slice(0, 2).join('، '))}</span>` : '';
  }catch(e){ $('#stRingTxt').textContent = navigator.onLine ? 'تعذّر الحساب' : 'يحتاج اتصالاً بالإنترنت'; }
}
// الإشعارات
function stFeed(){
  const seen = LS.get(stSeenKey(), 0), out = [];
  stNotifs.forEach(n => out.push({k:'n', id:n.id, ic:NT_ICON[n.t] || NT_ICON.info, title:n.title, body:n.body, ms:n.atMs || msOf(n.at), u:!n.read, t:n.t}));
  stAnns.forEach(a => out.push({k:'a', id:a.id, ic:NT_ICON.ann, title:'إعلان: ' + a.title, body:`${a.byName || ''} — ${(a.body || '').slice(0, 120)}`, ms:a.atMs, u:(a.atMs || 0) > seen}));
  return out.sort((a, b) => (b.ms || 0) - (a.ms || 0)).slice(0, 60);
}
function renderBell(){
  const f = stFeed(), n = f.filter(x => x.u).length;
  $('#stBellN').textContent = n > 9 ? '9+' : n; $('#stBellN').classList.toggle('hidden', !n);
  $('#ntList').innerHTML = f.map((x, i) => `<div class="nt${x.u ? ' u' : ''}" data-nt="${i}"><div class="ni av ${x.ic[1]}">${x.ic[0]}</div><div class="t"><b>${esc(x.title)}</b><small>${esc(x.body || '')}</small><small>${ago(x.ms)}</small></div></div>`).join('')
    || '<div class="empty" style="margin-top:30px">لا توجد إشعارات بعد</div>';
  if ('setAppBadge' in navigator){ try{ n ? navigator.setAppBadge(n) : navigator.clearAppBadge(); }catch(e){} }
}
$('#stBell').onclick = () => { renderBell(); $('#ntPanel').classList.remove('hidden'); stLoadAll(); };
$('#ntClose').onclick = () => $('#ntPanel').classList.add('hidden');
$('#ntPanel').onclick = e => { if (e.target.id === 'ntPanel') $('#ntPanel').classList.add('hidden'); };
function stMarkRead(x){
  if (x.k === 'n'){ const n = stNotifs.find(y => y.id === x.id); if (n && !n.read){ n.read = true; bg(DB.update('att_notif', n.id, {read:true}).p); } }
}
$('#ntAllRead').onclick = () => { stFeed().forEach(stMarkRead); LS.set(stSeenKey(), Date.now()); renderBell(); };
$('#ntList').onclick = e => {
  const el = e.target.closest('[data-nt]'); if (!el) return; const x = stFeed()[+el.dataset.nt]; if (!x) return;
  stMarkRead(x); $('#ntPanel').classList.add('hidden'); renderBell();
  if (x.t === 'res') stTab('stGrd');
  else if (x.t === 'warn' || /^exc/.test(x.t || '')) stTab('stAttT');
  else if (x.k === 'a') stTab('stHome');
};
function renderStMe(){
  const st = student; if (!st) return;
  const dn = ((stOrg && stOrg.depts) || (App.org && App.org.depts) || {})[st.deptId];
  $('#stMeCard').innerHTML = `<div class="row" style="flex-wrap:nowrap"><div class="av b" style="width:54px;height:54px;font-size:22px;border-radius:50%;display:grid;place-items:center">${esc((st.name || '?').charAt(0))}</div>
    <div><b style="font-size:17px">${esc(st.name || '')}</b><div class="note">الرقم الجامعي: ${esc(st.sid)}</div></div></div>
    <div class="mini"><div>القسم: <b>${esc(dn ? dn.name : st.deptId)}</b></div><div>المرحلة: <b>${esc(st.stage)}</b></div><div>الدراسة: <b>${esc(st.shift)}</b></div><div>الشعبة: <b>${esc(st.section || '—')}</b></div></div>
    <div class="note" dir="ltr" style="text-align:right">${esc(st.email || '')}</div><div class="note">بصمة الوجه: ${(st.p || []).length ? '<b style="color:var(--green)">مسجّلة ✓</b>' : '<b style="color:var(--red)">غير مسجّلة</b>'}</div>`;
}
let stPoll = null;
function initStudentV5(){
  stTab('stHome'); stAnns = []; stNotifs = [];
  stLoadAll(); renderStMe();
  clearInterval(stPoll); stPoll = setInterval(() => { if (student && document.visibilityState === 'visible' && (navigator.onLine || App.mode === 'local')) stLoadAll(); }, 120000);
}
document.addEventListener('visibilitychange', () => { if (student && document.visibilityState === 'visible') stLoadAll(); });

/* ---------- ربط الإصدار 5 بالدوال الموجودة ---------- */
{
  const _showTab = showTab;
  showTab = function(id){
    _showTab(id);
    const sp = document.querySelector(`nav button[data-tab="${id}"] span`); if (sp) $('#pageTitle').textContent = sp.textContent;
    if (!App.user) return;
    if (id === 'tHome') renderHome(false);
    if (id === 'tAnn') renderAnnTab(true);
    if (id === 'tUsers') renderAuthCard();
  };
  const _applyRole = applyRole;
  applyRole = function(){
    _applyRole(); homeCache = {key:''};
    // إخفاء عناوين المجموعات الفارغة
    $$('#sidebar nav .nav-grp').forEach(g => { let n = g.nextElementSibling, any = false; while (n && !n.classList.contains('nav-grp')){ if (!n.classList.contains('hidden')) any = true; n = n.nextElementSibling; } g.classList.toggle('hidden', !any); });
    $('#wNotify').classList.toggle('hidden', !canManageStudents());
    $('#topBell').classList.toggle('hidden', is('qa','committee','registrar'));
  };
  const _setDept = setDept;
  setDept = function(id){
    const prev = App.dept && App.dept.id; _setDept(id);
    if ((App.dept && App.dept.id) !== prev){ annList = []; annDept = null; homeCache = {key:''}; }
    const act = ($$('.tab').find(t => t.classList.contains('active')) || {}).id;
    if (act === 'tHome' || App.dept) renderHome(false); if (act === 'tAnn') renderAnnTab(false);
  };
  const _renderWarnings = renderWarnings;
  renderWarnings = function(){ _renderWarnings(); if ($('#tHome').classList.contains('active')) homeSoon(); };
  const _enterStudent = enterStudent;
  enterStudent = async function(st){ await _enterStudent(st); if (student === st) initStudentV5(); };
}

/* =====================================================================
   حسابات الدخول (Firebase Authentication) — مدير النظام فقط
   يستخدم ملف مفتاح الخدمة (JSON) يحمّله المدير على جهازه في كل مرة؛ لا يُحفظ ولا يُرفع إلى أي مكان.
   ===================================================================== */
let AA = {key:null, tok:null, tokAt:0, users:[], sel:new Set(), filter:'orphan', q:''};
const b64url = s => btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const b64urlBytes = u8 => { let s = ''; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000)); return b64url(s); };
async function signJwt(claims){
  const pem = String(AA.key.private_key).replace(/\\n/g, '\n').replace(/-----[^-]+-----/g, '').replace(/[^A-Za-z0-9+/=]/g, '');
  const der = Uint8Array.from(atob(pem), c => c.charCodeAt(0));
  const k = await crypto.subtle.importKey('pkcs8', der.buffer, {name:'RSASSA-PKCS1-v1_5', hash:'SHA-256'}, false, ['sign']);
  const enc = o => b64urlBytes(new TextEncoder().encode(JSON.stringify(o)));
  const unsigned = enc({alg:'RS256', typ:'JWT', kid:AA.key.private_key_id}) + '.' + enc(claims);
  const sig = new Uint8Array(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', k, new TextEncoder().encode(unsigned)));
  return unsigned + '.' + b64urlBytes(sig);
}
// رمز الوصول: أولاً JWT موقّع ذاتياً (لا يحتاج خادماً)، وإن رُفض فرمز OAuth
async function aaToken(mode){
  const now = Math.floor(Date.now() / 1000);
  if (mode === 'self') return signJwt({iss:AA.key.client_email, sub:AA.key.client_email, aud:'https://identitytoolkit.googleapis.com/', iat:now, exp:now + 3600});
  if (AA.tok && Date.now() - AA.tokAt < 50 * 60000) return AA.tok;
  const a = await signJwt({iss:AA.key.client_email, scope:'https://www.googleapis.com/auth/identitytoolkit https://www.googleapis.com/auth/cloud-platform', aud:'https://oauth2.googleapis.com/token', iat:now, exp:now + 3600});
  const r = await fetch('https://oauth2.googleapis.com/token', {method:'POST', headers:{'Content-Type':'application/x-www-form-urlencoded'}, body:'grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=' + a});
  const j = await r.json(); if (!j.access_token) throw new Error((j.error_description || j.error || 'token').toString());
  AA.tok = j.access_token; AA.tokAt = Date.now(); return AA.tok;
}
let aaMode = 'self';
async function aaFetch(path, opt = {}){
  const url = `https://identitytoolkit.googleapis.com/v1/projects/${AA.key.project_id}/${path}`;
  for (const mode of aaMode === 'self' ? ['self', 'oauth'] : ['oauth']){
    let r;
    try{ r = await fetch(url, Object.assign({}, opt, {headers:Object.assign({'Content-Type':'application/json', Authorization:'Bearer ' + await aaToken(mode)}, opt.headers || {})})); }
    catch(e){ if (mode === 'oauth') throw new Error('تعذّر الاتصال بخدمة Google — تحقق من الإنترنت'); continue; }
    if (r.status === 401 && mode === 'self'){ aaMode = 'oauth'; continue; }
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error((j.error && j.error.message) || ('HTTP ' + r.status));
    return j;
  }
}
function renderAuthCard(){
  $('#authAdmCard').classList.toggle('hidden', !is('super') || App.mode === 'local');
  if (!is('super')) return;
  $('#aaKeyState').innerHTML = AA.key ? `✓ المفتاح محمّل: <span dir="ltr">${esc(AA.key.client_email)}</span> — يبقى في ذاكرة هذه الصفحة فقط` : 'لم يُحمَّل ملف المفتاح بعد';
  $('#aaLoad').disabled = !AA.key; $('#aaForget').classList.toggle('hidden', !AA.key);
  renderAuthList();
}
$('#aaKeyFile').onchange = async e => {
  const f = e.target.files[0]; e.target.value = ''; if (!f) return;
  try{
    const k = JSON.parse(await f.text());
    if (k.type !== 'service_account' || !k.private_key || !k.client_email) throw new Error('هذا ليس ملف مفتاح خدمة (Service account)');
    const pid = (window.FIREBASE_CONFIG || {}).projectId;
    if (pid && k.project_id !== pid) throw new Error(`الملف لمشروع آخر (${k.project_id}) — مشروع النظام: ${pid}`);
    AA.key = k; AA.tok = null; aaMode = 'self'; toast('✓ حُمّل المفتاح — اضغط «تحميل قائمة الحسابات»', 'ok');
  }catch(err){ toast('ملف غير صالح: ' + err.message, 'err'); }
  renderAuthCard();
};
$('#aaForget').onclick = () => { AA = {key:null, tok:null, tokAt:0, users:[], sel:new Set(), filter:AA.filter, q:''}; renderAuthCard(); toast('أُزيل المفتاح من الذاكرة', 'ok'); };
$('#aaLoad').onclick = async () => {
  $('#aaLoad').disabled = true; $('#aaState').textContent = '⏳ جارٍ تحميل الحسابات...';
  try{
    const users = []; let next = '';
    do{ const j = await aaFetch(`accounts:batchGet?maxResults=1000${next ? '&nextPageToken=' + encodeURIComponent(next) : ''}`, {method:'GET'}); (j.users || []).forEach(u => users.push(u)); next = j.nextPageToken || ''; } while (next && users.length < 20000);
    const [staff, studs] = await Promise.all([DB.query('att_users', []).catch(() => []), DB.query('att_stu', []).catch(() => [])]);
    const sMap = Object.fromEntries(staff.map(x => [x.id, x])), stMap = Object.fromEntries(studs.map(x => [x.id, x]));
    AA.users = users.map(u => { const st = sMap[u.localId], sd = stMap[u.localId];
      return {uid:u.localId, email:u.email || '(بلا بريد)', created:+u.createdAt || 0, last:+u.lastLoginAt || 0, kind:u.localId === App.user.uid ? 'me' : st ? 'staff' : sd ? 'student' : 'orphan',
        label:st ? `${st.name || ''} — ${ROLES[st.role === 'admin' ? 'super' : st.role] || st.role}` : sd ? `${sd.name || ''} — ${sd.sid} — ${deptName(sd.deptId)}` : 'غير مرتبط بأي طالب أو مستخدم', stu:sd || null, staff:st || null}; })
      .sort((a, b) => b.created - a.created);
    AA.sel.clear(); $('#aaState').textContent = `✓ ${AA.users.length} حساب`;
  }catch(e){ console.error(e); $('#aaState').innerHTML = `✗ ${esc(e.message)}<br><span class="note">تأكد أن الملف هو مفتاح Service account لهذا المشروع، وأن الإنترنت متصل.</span>`; }
  $('#aaLoad').disabled = false; renderAuthList();
};
const AA_KIND = {orphan:['يتيم', 'b-abs'], student:['طالب', 'b-qr'], staff:['كادر', 'b-vio'], me:['حسابك', 'b-face']};
function aaVisible(){
  const q = AA.q.toLowerCase();
  return AA.users.filter(u => (AA.filter === 'all' || u.kind === AA.filter) && (!q || u.email.toLowerCase().includes(q) || u.label.toLowerCase().includes(q)));
}
function renderAuthList(){
  const box = $('#aaList'); if (!AA.users.length){ box.innerHTML = ''; $('#aaBar').classList.add('hidden'); return; }
  $('#aaBar').classList.remove('hidden');
  const cnt = k => AA.users.filter(u => u.kind === k).length;
  $('#aaSeg').innerHTML = [['orphan', `غير مرتبطة ${cnt('orphan')}`], ['student', `طلبة ${cnt('student')}`], ['staff', `كادر ${cnt('staff')}`], ['all', `الكل ${AA.users.length}`]]
    .map(([k, t]) => `<button data-aaf="${k}" class="${AA.filter === k ? 'on' : ''}">${t}</button>`).join('');
  const list = aaVisible();
  box.innerHTML = `<div class="tbl-wrap" style="max-height:460px"><table><thead><tr><th style="width:34px"></th><th>البريد</th><th>مرتبط بـ</th><th>النوع</th><th>أُنشئ</th><th>آخر دخول</th></tr></thead><tbody>${
    list.slice(0, 1500).map(u => `<tr><td>${u.kind === 'me' ? '' : `<input type="checkbox" data-aa="${esc(u.uid)}" ${AA.sel.has(u.uid) ? 'checked' : ''} style="width:auto">`}</td>
      <td dir="ltr" style="text-align:right">${esc(u.email)}</td><td>${esc(u.label)}</td><td><span class="badge ${AA_KIND[u.kind][1]}">${AA_KIND[u.kind][0]}</span></td>
      <td>${u.created ? new Date(u.created).toLocaleDateString('en-GB') : '—'}</td><td>${u.last ? new Date(u.last).toLocaleDateString('en-GB') : 'لم يدخل'}</td></tr>`).join('')
    || '<tr><td colspan="6" class="empty">لا توجد حسابات في هذا التصنيف</td></tr>'}</tbody></table></div>`;
  $('#aaSelInfo').textContent = AA.sel.size ? `محدّد: ${AA.sel.size}` : 'لم يُحدَّد شيء';
  $('#aaDel').disabled = !AA.sel.size;
}
$('#aaSeg').onclick = e => { const b = e.target.closest('[data-aaf]'); if (b){ AA.filter = b.dataset.aaf; renderAuthList(); } };
$('#aaSearch').oninput = e => { AA.q = e.target.value.trim(); renderAuthList(); };
$('#aaList').onchange = e => { const c = e.target.closest('[data-aa]'); if (!c) return; c.checked ? AA.sel.add(c.dataset.aa) : AA.sel.delete(c.dataset.aa); renderAuthList(); };
$('#aaAll').onclick = () => { aaVisible().forEach(u => { if (u.kind !== 'me') AA.sel.add(u.uid); }); renderAuthList(); };
$('#aaNone').onclick = () => { AA.sel.clear(); renderAuthList(); };
$('#aaDel').onclick = async () => {
  const list = AA.users.filter(u => AA.sel.has(u.uid) && u.kind !== 'me'); if (!list.length) return;
  const nS = list.filter(u => u.kind === 'student').length, nK = list.filter(u => u.kind === 'staff').length;
  const extra = (nS ? `\n• ${nS} حساب طالب: يُحذف حسابه وسجل حسابه (att_stu) ويُفك ربطه من قائمة القسم، فيبقى اسمه في القائمة بلا حساب.` : '') + (nK ? `\n• ${nK} حساب كادر: يُحذف المستخدم من النظام نهائياً.` : '');
  const word = prompt(`سيُحذف ${list.length} حساب من Firebase Authentication نهائياً (لا يمكن التراجع).${extra}\n\nللتأكيد اكتب: حذف`);
  if ((word || '').trim() !== 'حذف') return toast('أُلغي الحذف', 'err');
  $('#aaDel').disabled = true; let done = 0, fail = 0;
  try{
    for (let i = 0; i < list.length; i += 500){
      const part = list.slice(i, i + 500);
      $('#aaState').textContent = `⏳ جارٍ الحذف ${i + part.length} / ${list.length}...`;
      const j = await aaFetch('accounts:batchDelete', {method:'POST', body:JSON.stringify({localIds:part.map(u => u.uid), force:true})});
      const bad = new Set((j.errors || []).map(x => part[x.index] && part[x.index].uid)); fail += bad.size;
      for (const u of part.filter(u => !bad.has(u.uid))){
        done++;
        if (u.kind === 'student' && u.stu){ const sd = u.stu;
          bg(DB.del('att_stu', u.uid).p); bg(DB.del('att_cred', u.uid).p); if (sd.boundDevice) bg(DB.del('att_devices', sd.boundDevice).p);
          if (sd.deptId && sd.stage && sd.shift && sd.sid) bg(DB.update('att_packs', packId(sd.deptId, sd.stage, sd.shift), {[`students.${sd.sid}.u`]:DEL, updatedAt:nowISO()}).p); }
        if (u.kind === 'staff') bg(DB.del('att_users', u.uid).p);
        if (u.kind === 'orphan') bg(DB.del('att_cred', u.uid).p);
      }
    }
    audit('حذف حسابات من Authentication', `${done} حساب: ` + list.slice(0, 60).map(u => u.email).join('، '));
    toast(`✓ حُذف ${done} حساب${fail ? ` — تعذّر ${fail}` : ''}`, fail ? 'err' : 'ok');
  }catch(e){ console.error(e); toast('تعذّر الحذف: ' + e.message, 'err'); }
  AA.users = AA.users.filter(u => !(AA.sel.has(u.uid) && done)); AA.sel.clear(); $('#aaLoad').click();
};

/* ---------- باركود دخول النظام (يُرسل للطلبة) ---------- */
const DEV_CREDIT = 'تطوير: د. محمد يوسف';
function loginPosterCanvas(scale = 2){
  const W = 620 * scale, H = 860 * scale, c = document.createElement('canvas'); c.width = W; c.height = H;
  const g = c.getContext('2d'), S = v => v * scale, link = appBase();
  const bgG = g.createLinearGradient(0, 0, W, H); bgG.addColorStop(0, '#1e3a8a'); bgG.addColorStop(.55, '#4f46e5'); bgG.addColorStop(1, '#7c3aed');
  g.fillStyle = bgG; g.fillRect(0, 0, W, H);
  g.fillStyle = 'rgba(255,255,255,.08)'; g.beginPath(); g.arc(S(80), S(90), S(170), 0, 7); g.fill(); g.beginPath(); g.arc(S(560), S(780), S(200), 0, 7); g.fill();
  const rr = (x, y, w, h, r) => { g.beginPath(); g.moveTo(x + r, y); g.arcTo(x + w, y, x + w, y + h, r); g.arcTo(x + w, y + h, x, y + h, r); g.arcTo(x, y + h, x, y, r); g.arcTo(x, y, x + w, y, r); g.closePath(); };
  g.direction = 'rtl'; g.textAlign = 'center'; g.fillStyle = '#fff';
  g.font = `700 ${S(30)}px 'IBM Plex Sans Arabic', Cairo, Tahoma, sans-serif`; g.fillText('نظام الحضور والدرجات', W / 2, S(78));
  g.font = `500 ${S(18)}px 'IBM Plex Sans Arabic', Cairo, Tahoma, sans-serif`; g.fillStyle = 'rgba(255,255,255,.85)'; g.fillText('جامعة السراج — امسح الرمز للدخول إلى النظام', W / 2, S(112));
  g.fillStyle = '#fff'; rr(S(110), S(140), S(400), S(400), S(28)); g.fill();
  const qc = document.createElement('canvas'); qc.width = qc.height = S(360); drawQR(qc, link); g.drawImage(qc, S(130), S(160));
  g.fillStyle = 'rgba(255,255,255,.14)'; rr(S(50), S(566), S(520), S(48), S(14)); g.fill();
  g.fillStyle = '#fff'; g.font = `600 ${S(15)}px Tahoma, sans-serif`; g.direction = 'ltr'; g.fillText(link.length > 60 ? link.slice(0, 58) + '…' : link, W / 2, S(596)); g.direction = 'rtl';
  const steps = ['① امسح الرمز بكاميرا الهاتف وافتح الرابط', '② ادخل بالبريد وكلمة المرور المسلّمة لك من القسم', '③ سجّل بصمة وجهك مرة واحدة', '④ أضف التطبيق إلى الشاشة الرئيسية'];
  g.textAlign = 'right'; g.font = `500 ${S(17)}px 'IBM Plex Sans Arabic', Cairo, Tahoma, sans-serif`;
  steps.forEach((t, i) => { g.fillStyle = '#fff'; g.fillText(t, W - S(70), S(654 + i * 36)); });
  g.textAlign = 'center'; g.fillStyle = 'rgba(255,255,255,.7)'; g.font = `500 ${S(13)}px 'IBM Plex Sans Arabic', Cairo, Tahoma, sans-serif`; g.fillText(DEV_CREDIT, W / 2, H - S(20));
  return c;
}
function openLoginQR(){
  const link = appBase();
  $('#lqLink').textContent = link;
  drawQR($('#lqCanvas'), link);
  $('#lqShare').classList.toggle('hidden', !navigator.share);
  $('#loginQrModal').classList.add('show');
}
$('#lqClose').onclick = () => $('#loginQrModal').classList.remove('show');
$('#lqCopy').onclick = () => { (navigator.clipboard ? navigator.clipboard.writeText(appBase()) : Promise.reject()).then(() => toast('نُسخ الرابط ✓', 'ok'), () => toast(appBase())); };
$('#lqPng').onclick = () => { const a = document.createElement('a'); a.href = loginPosterCanvas(2).toDataURL('image/png'); a.download = 'باركود_دخول_النظام.png'; a.click(); };
$('#lqPrint').onclick = () => {
  const url = loginPosterCanvas(2).toDataURL('image/png'), w = window.open('', '_blank');
  if (!w) return toast('اسمح بالنوافذ المنبثقة للطباعة', 'err');
  w.document.write(`<!doctype html><html dir="rtl"><head><title>باركود دخول النظام</title><style>@page{size:A4;margin:12mm}body{margin:0;display:grid;place-items:center;min-height:95vh}img{width:150mm;max-width:100%}</style></head><body><img src="${url}" onload="setTimeout(()=>{print()},200)"></body></html>`);
  w.document.close();
};
$('#lqShare').onclick = async () => {
  try{ const blob = await new Promise(r => loginPosterCanvas(2).toBlob(r, 'image/png')), file = new File([blob], 'login-qr.png', {type:'image/png'});
    const data = {title:'نظام الحضور — جامعة السراج', text:'رابط الدخول إلى نظام الحضور والدرجات:\n' + appBase()};
    if (navigator.canShare && navigator.canShare({files:[file]})) data.files = [file];
    await navigator.share(data);
  }catch(e){ if (e.name !== 'AbortError') toast('تعذّرت المشاركة', 'err'); }
};
document.addEventListener('click', e => { if (e.target.closest('[data-loginqr]')) openLoginQR(); });

/* ---------- التبديل بين الفصل الأول والثاني ---------- */
const parseTerm = t => { const m = /^\s*(\d{4})\s*-\s*(\d{4})\s*\/\s*(.+?)\s*$/.exec(t || ''); return m ? {year:`${m[1]}-${m[2]}`, sem:m[3]} : null; };
const SEMS = ['الفصل الأول', 'الفصل الثاني'];
function openTermModal(){
  if (!is('super')) return;
  const cur = parseTerm(App.org && App.org.term) || {}, y0 = new Date().getFullYear(), years = [];
  for (let y = y0 - 2; y <= y0 + 1; y++) years.push(`${y}-${y + 1}`);
  if (cur.year && !years.includes(cur.year)) years.push(cur.year);
  $('#tmYear').innerHTML = years.sort().map(y => `<option ${y === cur.year ? 'selected' : ''}>${y}</option>`).join('');
  if (!cur.year) $('#tmYear').value = (new Date().getMonth() >= 7 ? `${y0}-${y0 + 1}` : `${y0 - 1}-${y0}`);
  $$('input[name=tmSem]').forEach(r => r.checked = r.value === (SEMS.includes(cur.sem) ? cur.sem : SEMS[0]));
  tmFill(); $('#termModal').classList.add('show');
}
const tmTerm = () => `${$('#tmYear').value} / ${(document.querySelector('input[name=tmSem]:checked') || {}).value || SEMS[0]}`;
function tmFill(){
  const t = tmTerm(), starts = (App.org && App.org.termStarts) || {};
  $('#tmStart').value = starts[t] || (t === App.org.term ? App.org.termStart || '' : '');
  $('#tmPreview').innerHTML = t === App.org.term ? `هذا هو الفصل الحالي: <b>${esc(t)}</b>` : `سيصبح الفصل الحالي: <b>${esc(t)}</b> — المحاضرات والدرجات الجديدة تُنسب إليه، وسجلات <b>${esc(App.org.term || '')}</b> تبقى محفوظة ويمكن الرجوع إليها بإعادة التبديل.`;
}
$('#tmYear').onchange = tmFill; $$('input[name=tmSem]').forEach(r => r.onchange = tmFill);
$('#tmCancel').onclick = () => $('#termModal').classList.remove('show');
$('#tmSave').onclick = () => {
  const t = tmTerm(), ts = $('#tmStart').value, o = clone(App.org);
  o.termStarts = Object.assign({}, o.termStarts || {}); if (o.term && o.termStart) o.termStarts[o.term] = o.termStart; if (ts) o.termStarts[t] = ts;
  const changed = t !== o.term; o.term = t; o.termStart = ts;
  saveOrg(o, changed ? 'تم التبديل إلى ' + t : 'تم حفظ تاريخ بداية الفصل'); if (changed) audit('تبديل الفصل الدراسي', t);
  $('#termModal').classList.remove('show');
};
$('#termBox').onclick = () => { if (is('super')) openTermModal(); };
$('#openTermModal').onclick = openTermModal;

/* ---------- الجدول الأسبوعي: المادة من قائمة ---------- */
function fillScCourses(keep){
  const st = $('#scStage').value, sh = $('#scShift').value, cur = keep != null ? keep : $('#scCourse').value;
  const fromCourses = courseList().filter(c => c.stage === st).map(c => c.name);
  const fromAsg = App.users.flatMap(u => (u.assignments || []).filter(a => App.dept && a.deptId === App.dept.id && a.stage === st && (!sh || a.shift === sh)).map(a => a.course));
  const names = [...new Set(fromCourses.concat(fromAsg))].sort((a, b) => a.localeCompare(b, 'ar'));
  if (cur && !names.includes(cur)) names.unshift(cur);
  $('#scCourse').innerHTML = `<option value="">${names.length ? '— اختر المادة —' : '— لا توجد مواد لهذه المرحلة: أضفها من «اللجنة الامتحانية ← المواد الدراسية» —'}</option>` + names.map(n => `<option ${n === cur ? 'selected' : ''}>${esc(n)}</option>`).join('');
}
$('#scStage').addEventListener('change', () => fillScCourses(''));
$('#scShift').addEventListener('change', () => fillScCourses());
$('#scCourse').addEventListener('change', () => { // اختيار التدريسي المكلّف بالمادة تلقائياً
  const c = $('#scCourse').value, st = $('#scStage').value, sh = $('#scShift').value, sec = $('#scSection').value;
  const u = App.users.find(u => (u.assignments || []).some(a => App.dept && a.deptId === App.dept.id && a.course === c && a.stage === st && a.shift === sh && (!a.section || !sec || a.section === sec)));
  if (u && [...$('#scInstr').options].some(o => o.value === u.id)) $('#scInstr').value = u.id;
});

/* ============ تسجيل الدخول والتشغيل ============ */
$('#loginForm').onsubmit = async e => {
  e.preventDefault(); $('#loginErr').textContent = ''; $('#loginBtn').disabled = true;
  try{ await auth.signInWithEmailAndPassword($('#lEmail').value.trim(), $('#lPass').value); }
  catch(err){ $('#loginErr').textContent = fbErr(err); $('#loginBtn').disabled = false; }
};
$('#forgotLink').onclick = async e => {
  e.preventDefault();
  const email = $('#lEmail').value.trim(); if (!email) return ($('#loginErr').textContent = 'اكتب بريدك أولاً ثم اضغط "نسيت كلمة المرور"');
  try{ await auth.sendPasswordResetEmail(email); $('#loginErr').textContent = 'أُرسل رابط تعيين كلمة المرور إلى بريدك'; }
  catch(err){ $('#loginErr').textContent = fbErr(err); }
};
$('#logoutBtn').onclick = async () => {
  if (sess) return toast('أنهِ المحاضرة الجارية أولاً', 'err');
  if (App.pending && !(await confirmBox('بيانات غير مرفوعة', `توجد ${App.pending} محاضرة لم تُرفع بعد. إذا خرجت قد تُفقد. هل تريد الخروج؟`, 'خروج'))) return;
  await auth.signOut();
};
function startSession(user){
  App.user = user; App.dept = null; App.org = null; App.term = null;
  if (!modelsReady && !modelsLoading) loadModels(); // نماذج الوجه للكادر فقط (لا تُنزَّل على هواتف الطلبة)
  showApp(); applyRole(); subOrg(); subUsers();
}
async function boot(){
  const a = new URLSearchParams(location.search).get('a');
  if (a){ sessionStorage.setItem('fa_pending', a); history.replaceState(null, '', location.pathname); }
  loadSettingsUI(); registerSW();
  const cfg = window.FIREBASE_CONFIG || {};
  if (!cfg.apiKey){
    App.mode = 'local'; DB = LFS; LFS.load();
    startSession({uid:'local', name:'مدير النظام', role:'super', collegeId:'', deptIds:[]});
    return;
  }
  if (typeof firebase === 'undefined'){ showLogin('تعذّر تحميل Firebase — افتح التطبيق مع اتصال بالإنترنت مرة واحدة على الأقل'); $('#loginBtn').disabled = true; return; }
  firebase.initializeApp(cfg);
  db = firebase.firestore();
  try{ await db.enablePersistence({synchronizeTabs:true}); }
  catch(e){ console.warn('persistence', e); if (e.code === 'unimplemented') toast('هذا المتصفح لا يدعم العمل دون اتصال', 'err'); }
  auth = firebase.auth(); App.mode = 'firebase'; DB = FS;
  auth.onAuthStateChanged(async u => {
    if (registering) return;
    unsubAll(); App.user = null; student = null; stopScan();
    if (!u){ showLogin(); return; }
    try{
      const d = await FS.get('att_users', u.uid);
      const r = d ? normRole(d.role) : null;
      if (!d){
        const st = await FS.get('att_stu', u.uid);
        if (st) return enterStudent(Object.assign({uid:u.uid, email:u.email}, st));
      }
      if (!r || !ACTIVE_ROLES.includes(r)){
        $('#loginErr').textContent = 'هذا الحساب غير مخوّل باستخدام النظام. راجع رئيس القسم أو مدير النظام.';
        await auth.signOut(); return;
      }
      sessionStorage.removeItem('fa_pending');
      startSession(Object.assign({}, d, {uid:u.uid, email:u.email, role:r, deptIds:d.deptIds || []}));
    }catch(e){
      console.error(e);
      showLogin('تعذّر التحقق من الصلاحية: ' + fbErr(e) + (navigator.onLine ? '' : ' — يلزم الاتصال بالإنترنت عند أول دخول'));
    }
  });
}
boot();
