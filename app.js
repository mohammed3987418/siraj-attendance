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
const APP_VERSION = '3.6.1';
const SLOT_MS = 5000; // القيمة الافتراضية لتغيّر رمز QR (يختارها التدريسي لكل محاضرة)
const QR_GRACE_MS = 20000; // يُقبل الرمز حتى ~٢٠ ثانية بعد انتهاء خانته (زمن المسح والإرسال) عند الاتصال
const QR_ACCEPT_DAYS = 3;  // مهلة رفع حضور QR المحفوظ على هاتف الطالب دون اتصال
const QR_CAPTURE_TOL = 120000; // فرق مسموح (ملّي ثانية) بين وقت المسح على الهاتف ووقت الرمز
const QR_FACE_EXTRA_MS = 45000; // وقت إضافي لإكمال سيلفي التحقق من الوجه
const FACE_MATCH_MAX = 0.55;    // أقصى مسافة لقبول تطابق وجه الطالب مع بصمته
const MODEL_URL = 'https://cdn.jsdelivr.net/npm/@vladmandic/face-api@1/model/';
const ROLES = {super:'مدير النظام', dean:'عميد الكلية', head:'رئيس القسم', registrar:'موظف تسجيل', instructor:'تدريسي', disabled:'معطّل'};
const ACTIVE_ROLES = ['super','dean','head','registrar','instructor'];
const TAB_ROLES = {
  tStudents:['super','dean','head','registrar'], tSession:['super','dean','head','instructor'],
  tRecords:['super','dean','head','instructor'], tUsers:['super','dean','head'], tOrg:['super'], tSettings:ACTIVE_ROLES
};
const DEFAULT_ORG = {
  term:'2026-2027 / الفصل الأول',
  colleges:{'tech-eng':{name:'الكلية التقنية الهندسية'}},
  depts:{'ai-eng':{name:'هندسة تقنيات الذكاء الاصطناعي', collegeId:'tech-eng', stages:['الأولى','الثانية','الثالثة','الرابعة'], shifts:['صباحي','مسائي'], sections:['A','B']}}
};
const normRole = r => r === 'admin' ? 'super' : r;

/* ============ أدوات عامة ============ */
const $ = s => document.querySelector(s);
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
const cleanId = s => String(s ?? '').trim().replace(/[^\w-]/g, '-');
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

const LFS = { // محاكاة محلية
  d:{}, subs:[],
  load(){ this.d = LS.get('fa3_db', {}); },
  persist(){ LS.set('fa3_db', this.d); setTimeout(() => this.subs.slice().forEach(s => s.run()), 0); },
  col(c){ return this.d[c] || (this.d[c] = {}); },
  merge(a, b){ Object.entries(b).forEach(([k, v]) => { if (isDel(v)) delete a[k]; else if (isTs(v)) a[k] = Date.now(); else if (isObj(v) && isObj(a[k])) this.merge(a[k], v); else a[k] = clone(v); }); return a; },
  async get(c, id){ const x = this.col(c)[id]; return x ? Object.assign({id}, clone(x)) : null; },
  set(c, id, data, merge){
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
  set(c, id, data, merge){ const ref = id ? db.collection(c).doc(id) : db.collection(c).doc(); return {id:ref.id, p:ref.set(this.conv(data), {merge:!!merge})}; },
  update(c, id, patch){ return {p:db.collection(c).doc(id).update(this.conv(patch))}; },
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
  if (u.role === 'super') return all;
  if (u.role === 'dean') return all.filter(d => d.collegeId === u.collegeId);
  const ids = u.deptIds || []; return all.filter(d => ids.includes(d.id));
}
const packId = (deptId, stage, shift) => `${deptId}~${stage}~${shift}`;

/* ============ الواجهة العامة ============ */
$$('nav button').forEach(b => b.onclick = () => showTab(b.dataset.tab));
function showTab(id){
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
  $('#userBox').textContent = `${App.user.name || App.user.email || ''} — ${ROLES[r]}`;
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
  $('#termBox').textContent = App.org ? 'الفصل الحالي: ' + App.org.term : '';
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
  if (changed){ App.term = App.org && App.org.term; subPacks(); subSessions(); }
}
function fillDeptOptions(){
  const d = App.dept || {stages:[], shifts:[], sections:[]};
  const opts = (arr, all) => (all ? `<option value="">${all}</option>` : '') + (arr || []).map(x => `<option>${esc(x)}</option>`).join('');
  $$('select.optStage').forEach(s => { const v = s.value; s.innerHTML = opts(d.stages); if ((d.stages || []).includes(v)) s.value = v; });
  $$('select.optShift').forEach(s => { const v = s.value; s.innerHTML = opts(d.shifts); if ((d.shifts || []).includes(v)) s.value = v; });
  $$('select.optSection').forEach(s => { const v = s.value; s.innerHTML = opts(d.sections, s.dataset.all); if ((d.sections || []).includes(v)) s.value = v; });
  $('#fStage').innerHTML = opts(d.stages, 'كل المراحل'); $('#fShift').innerHTML = opts(d.shifts, 'كل الدراسات');
  renderAsgSelect();
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
function subSessions(){
  unsub('sessions'); App.sessions = []; App.pending = 0;
  const u = App.user, d = App.dept, T = App.org && App.org.term;
  let f = null;
  if (u.role === 'instructor') f = [['instructorUid', u.uid], ['term', T]];
  else if (u.role === 'registrar' || !d) f = null;
  else if (u.role === 'dean') f = [['collegeId', d.collegeId], ['deptId', d.id], ['term', T]];
  else f = [['deptId', d.id], ['term', T]];
  if (f) App.subs.sessions = DB.listen('att_sessions', f, list => {
    App.sessions = list; App.pending = list.filter(x => x._pending).length;
    renderRecords(); renderCourseList(); updateConn(); scheduleReconcile();
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
    App.org = doc; renderScope(); renderOrg(); renderOverviewOptions();
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
      if (!s.liveId || !s.qrSecret || s._pending) continue;
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
    out.push({id:sid, name:s.n, section:s.s, stage:p.stage, shift:p.shift, prints:s.p || [], e:s.e || '', u:s.u || '', packId:p.id})));
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
function filteredStudents(){
  const st = $('#fStage').value, sh = $('#fShift').value, fp = $('#fPrint').value, q = $('#fSearch').value.trim();
  return deptStudents().filter(s => (!st || s.stage === st) && (!sh || s.shift === sh) &&
    (!fp || (fp === 'yes') === (s.prints.length > 0)) && (!q || s.name.includes(q) || s.id.includes(q)));
}
function accountCell(s, key){
  if (s.u) return `<span class="badge b-face">مفعّل</span> <span class="note" dir="ltr">${esc(s.e)}</span> <button class="btn sm light" data-reset="${key}" title="يُرسل رابط تغيير كلمة المرور إلى بريد الطالب">🔑 رابط كلمة مرور</button> <button class="btn sm light" data-unbind="${key}" title="عند تغيير الطالب هاتفه">📱 فك ربط الهاتف</button>`;
  if (s.e) return `<span class="badge b-man">لم يُنشأ</span> <span class="note" dir="ltr">${esc(s.e)}</span>`;
  return '<span class="note">—</span>';
}
function renderStudents(){
  if (!canManageStudents()) return;
  const all = deptStudents(), list = filteredStudents();
  $('#studCount').textContent = `${all.length} طالب — ${all.filter(s => s.prints.length).length} لديهم بصمة` +
    ` — ${all.filter(s => s.u).length} لديهم حساب`;
  $('#studentsBody').innerHTML = list.slice(0, 800).map(s => {
    const n = s.prints.length, key = esc(s.packId + '|' + s.id);
    return `<tr><td>${esc(s.id)}</td><td>${esc(s.name)}</td><td>${esc(s.stage)}</td><td>${esc(s.shift)}</td><td>${esc(s.section)}</td>
    <td>${n ? `<span class="badge b-face">مسجّلة (${n})</span>` : '<span class="badge b-abs">غير مسجّلة</span>'}</td>
    <td>${accountCell(s, key)}</td>
    <td class="row"><button class="btn sm" data-enroll="${key}">${n ? 'إعادة البصمة' : 'تسجيل البصمة'}</button>
    ${n ? `<button class="btn sm light" data-clear="${key}">حذف البصمة</button>` : ''}
    <button class="btn sm red" data-del="${key}">حذف</button></td></tr>`;
  }).join('') || `<tr><td colspan="8" class="note">${App.dept ? 'لا يوجد طلبة' : 'اختر القسم'}</td></tr>`;
}
/* ---- استيراد الطلبة من Excel وإنشاء حساباتهم ---- */
const HDR = {id:['الرقم الجامعي','الرقم','id','student id','رقم'], name:['الاسم','اسم الطالب','الاسم الرباعي','name'],
  email:['البريد الإلكتروني','البريد','الايميل','الإيميل','email','e-mail'], stage:['المرحلة','stage'], shift:['الدراسة','shift'], section:['الشعبة','section']};
const genPass = () => { const c = 'abcdefghjkmnpqrstuvwxyz23456789'; return Array.from(crypto.getRandomValues(new Uint8Array(8)), b => c[b % c.length]).join(''); };
const emailOk = e => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);
let imp = null; // {rows:[{id,name,email,stage,shift,section,pass,status,ok}], running}
function needXLSX(){ if (typeof XLSX === 'undefined'){ toast('مكتبة Excel غير محمّلة — افتح التطبيق مع إنترنت', 'err'); return false; } return true; }
$('#templateBtn').onclick = () => {
  if (!needXLSX()) return;
  const d = App.dept || {stages:['الأولى'], shifts:['صباحي'], sections:['A']};
  const ws = XLSX.utils.aoa_to_sheet([['الرقم الجامعي','الاسم','البريد الإلكتروني','المرحلة','الدراسة','الشعبة'],
    ['2025001','أحمد محمد علي حسن','ahmed@example.com', d.stages[0], d.shifts[0], (d.sections || [''])[0]]]);
  ws['!cols'] = [{wch:14},{wch:30},{wch:30},{wch:10},{wch:10},{wch:8}];
  const wb = XLSX.utils.book_new(); wb.Workbook = {Views:[{RTL:true}]}; XLSX.utils.book_append_sheet(wb, ws, 'الطلبة');
  XLSX.writeFile(wb, 'قالب_الطلبة.xlsx');
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
  $('#impStep1').classList.toggle('hidden', !!rows); $('#impFile').value = '';
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
    const col = k => head.findIndex(h => HDR[k].some(x => h === x.toLowerCase()));
    const ix = {id:col('id'), name:col('name'), email:col('email'), stage:col('stage'), shift:col('shift'), section:col('section')};
    let body = aoa.slice(1);
    if (ix.name < 0){ ix.id = 0; ix.name = 1; ix.email = 2; ix.stage = 3; ix.shift = 4; ix.section = 5; body = head.some(h => emailOk(h)) ? aoa : aoa.slice(1); }
    const v = (r, k) => ix[k] >= 0 ? String(r[ix[k]] ?? '').trim() : '';
    imp.rows = body.filter(r => r.some(x => String(x).trim())).map(r => ({
      id:cleanId(v(r, 'id')), name:v(r, 'name'), email:v(r, 'email').toLowerCase(),
      stage:v(r, 'stage') || $('#impStage').value, shift:v(r, 'shift') || $('#impShift').value, section:v(r, 'section') || $('#impSection').value}));
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
    else if (!emailOk(r.email)) r.status = 'البريد غير صالح';
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
  $('#impBody').innerHTML = imp.rows.map((r, i) => `<tr><td>${i + 1}</td><td>${esc(r.id)}</td><td>${esc(r.name)}</td><td dir="ltr" style="text-align:right">${esc(r.email)}</td>
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
      const uid = await createStudentAccount(r), pid = packId(d.id, r.stage, r.shift);
      await DB.set('att_stu', uid, {sid:r.id, name:r.name, email:r.email, deptId:d.id, collegeId:d.collegeId, stage:r.stage, shift:r.shift, section:r.section, createdAt:nowISO(), createdBy:App.user.uid}).p;
      bg(DB.set('att_packs', pid, {collegeId:d.collegeId, deptId:d.id, stage:r.stage, shift:r.shift, updatedAt:nowISO(),
        students:{[r.id]:{n:r.name, s:r.section, e:r.email, u:uid}}}, true).p);
      r.created = true; r.status = 'تم إنشاء الحساب ✓';
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
  if (imp.rows.some(r => r.created)) toast('نزّل ملف Excel الآن — كلمات المرور لن تظهر مرة أخرى', 'ok');
};
$('#impExport').onclick = () => {
  if (!needXLSX()) return;
  const d = App.dept, link = location.origin + location.pathname.replace(/index\.html$/, '');
  const rows = imp.rows.filter(r => r.created).map(r => [r.id, r.name, r.email, r.pass, r.stage, r.shift, r.section]);
  const ws = XLSX.utils.aoa_to_sheet([['رابط النظام', link], [], ['الرقم الجامعي','الاسم','البريد الإلكتروني (اسم الدخول)','كلمة المرور','المرحلة','الدراسة','الشعبة'], ...rows]);
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
      toast('تم فك ربط الهاتف — يدخل الطالب الآن من هاتفه الجديد', 'ok');
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
    if (s.u) bg(DB.update('att_stu', s.u, {p:DEL}).p);
  }
  if (b.dataset.del && await confirmBox('حذف الطالب', 'سيتم حذف الطالب وبصمته. سجلات الحضور السابقة تبقى كما هي.', 'حذف')){
    const s = findStudent(b.dataset.del);
    bg(DB.update('att_packs', s.packId, {[`students.${s.id}`]:DEL, updatedAt:nowISO()}).p);
  }
};

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
const qrOptUI = () => $$('.qrOpt').forEach(e => e.classList.toggle('hidden', $('#cMethod').value === 'face'));
$('#cMethod').onchange = qrOptUI; qrOptUI();
function renderCourseList(){
  const set = new Set(App.sessions.filter(s => !App.dept || s.deptId === App.dept.id).map(s => s.course));
  $('#courseList').innerHTML = [...set].map(c => `<option value="${esc(c)}">`).join('');
}
$('#startSessionBtn').onclick = async () => {
  const d = App.dept;
  if (!d) return toast('اختر القسم أولاً', 'err');
  const method = $('#cMethod').value, useFace = method !== 'qr', useQR = method !== 'face';
  if (useFace && !modelsReady) return toast('انتظر حتى تكتمل نماذج الوجه، أو اختر طريقة QR', 'err');
  const meta = {collegeId:d.collegeId, deptId:d.id, deptName:d.name, term:App.org.term,
    course:$('#cName').value.trim(), stage:$('#cStage').value, shift:$('#cShift').value, section:$('#cSection').value,
    type:$('#cType').value, hours:+$('#cHours').value || 1, date:$('#cDate').value || today(),
    instructorUid:App.user.uid, instructorName:App.user.name || App.user.email || ''};
  if (!meta.course) return toast('أدخل اسم المادة', 'err');
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
  const slotMs = (+$('#cQrSec').value || 5) * 1000, mins = +$('#cQrMins').value;
  const endsAt = mins ? Date.now() + mins * 60000 : null;
  const w = DB.set('att_live', null, {collegeId:m.collegeId, deptId:m.deptId, deptName:m.deptName, course:m.course, stage:m.stage, shift:m.shift,
    section:m.section, instructorUid:m.instructorUid, instructorName:m.instructorName, pin, open:true, startedAt:TS, localStart:Date.now(),
    slotMs, endsAt, face:$('#cQrFace').checked, acceptUntil:new Date(Date.now() + QR_ACCEPT_DAYS * 86400000)});
  const firstSlot = Math.floor(Date.now() / slotMs);
  const q = sess.qr = {stats:{recv:0, ok:0, rej:0}, liveId:w.id, secret, pin, slotMs, endsAt, face:$('#cQrFace').checked, firstSlot, lastSlot:null, closed:false, offset:0, codes:new Map(), seen:{}, devices:{}, rejected:[], slot:null, chain:Promise.resolve()};
  bg(w.p);
  $('#qrPin').textContent = pin; $('#qrFullPin').textContent = pin;
  $('#qrFullTitle').textContent = `${m.course} — ${m.deptName} — ${m.stage} / ${m.shift}`;
  $('#qrHint').textContent = `يمسح الطلبة الرمز من داخل التطبيق بعد تسجيل الدخول. يتغيّر الرمز كل ${slotMs / 1000} ثوانٍ.`;
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
  if (q.endsAt && now >= q.endsAt) return closeQRWindow(q, 'انتهى وقت التسجيل بـ QR');
  $('#qrWindow').textContent = q.endsAt ? `⏱ يتوقف التسجيل بـ QR خلال ${mmss(q.endsAt - now)}` : '⏱ التسجيل بـ QR مفتوح حتى إنهاء المحاضرة';
  $('#qrFullWindow').textContent = q.endsAt ? `يتوقف خلال ${mmss(q.endsAt - now)}` : '';
  $('#qrBar').style.width = (left / q.slotMs * 100) + '%';
  $('#qrFullCount').textContent = `يتغير خلال ${Math.ceil(left / 1000)} ث`;
  if (slot === q.slot) return;
  q.slot = slot;
  const code = await codeFor(q, slot), text = `${appBase()}?a=${q.liveId}.${slot}.${code}${q.face ? '.f' : ''}`;
  if (q.closed) return;
  $('#qrCode').textContent = code; $('#qrFullCode').textContent = code;
  drawQR($('#qrCanvas'), text);
  if ($('#qrFull').classList.contains('show')) drawQR($('#qrFullCanvas'), text);
  q.text = text;
  for (const k of q.codes.keys()) if (k < slot - 200) q.codes.delete(k);
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
  const qrIds = [...sess.roster.entries()].filter(([, st]) => st.status === 'qr' || st.status === 'qr-off').map(([id]) => id);
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
  if (method === 'qr' || method === 'qr-off') beep();
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
    const badge = st.status === 'qr-off' ? '<span class="badge b-qr">حاضر (QR دون اتصال)</span>' : st.status === 'qr' ? '<span class="badge b-qr">حاضر (QR)</span>' : st.status === 'face' ? '<span class="badge b-face">حاضر (وجه)</span>' : st.status === 'manual' ? '<span class="badge b-man">حاضر (يدوي)</span>' : '<span class="badge b-abs">غائب</span>';
    const btn = st.status === 'absent' ? `<button class="btn sm light" data-man="${esc(id)}">حاضر يدوياً</button>` : `<button class="btn sm light" data-undo="${esc(id)}">إلغاء</button>`;
    return `<tr><td>${sfImg(st.selfie)} ${esc(sess.names[id] || id)}${st.flag === 'spot' ? ' <span class="badge b-abs">غائب في التحقق العشوائي</span>' : ''}${(!sess.useFace || sess.hasPrint[id]) ? '' : ' <span class="badge b-gray">بلا بصمة</span>'}</td><td>${badge}</td><td>${st.time}</td><td>${btn}</td></tr>`;
  }).join('');
  $('#stPresent').textContent = present; $('#stTotal').textContent = sess.roster.size; $('#stAbsent').textContent = sess.roster.size - present;
}
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
    Object.assign(rec, {liveId:q.liveId, qrSecret:q.secret, qrSlotMs:q.slotMs, qrFace:!!q.face,
      spotAbsent:entries.filter(([, s]) => s.flag === 'spot').map(([id]) => id), qrFrom:q.firstSlot, qrTo:q.lastSlot != null ? q.lastSlot : Math.floor(Date.now() / q.slotMs),
      acceptUntil:new Date(Date.now() + QR_ACCEPT_DAYS * 86400000).toISOString(), qrLate:0});
  }
  const w = DB.set('att_sessions', null, rec);
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
    <td>${(s.present || []).length}${s.qrLate ? ` <span class="badge b-qr" title="أُضيفوا لاحقاً من هواتف كانت دون اتصال">+${s.qrLate} QR</span>` : ''}</td><td>${(s.absentees || []).length}</td>
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
    (s.present || []).forEach(p => rows.push([p.id, nm(p.id), 'حاضر', {face:'بصمة وجه', qr:'QR', 'qr-off':'QR دون اتصال', manual:'يدوي'}[p.method] || p.method, p.time]));
    (s.absentees || []).forEach(id => rows.push([id, nm(id), 'غائب', '', '']));
    download(`حضور_${s.course}_${s.date}.csv`, toCSV(rows), 'text/csv');
  }
  if (b.dataset.sdel && await confirmBox('حذف المحاضرة', 'سيُحذف سجل حضور هذه المحاضرة نهائياً.', 'حذف')) bg(DB.del('att_sessions', b.dataset.sdel).p);
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
   المستخدمون
   ===================================================================== */
function roleOptionsFor(editing){
  if (is('super')) return ['super','dean','head','registrar','instructor'].concat(editing ? ['disabled'] : []);
  if (is('dean')) return ['head','registrar','instructor'].concat(editing ? ['disabled'] : []);
  if (is('head')) return ['registrar','instructor'].concat(editing ? ['disabled'] : []);
  return [];
}
function canEditUser(u){
  const me = App.user; if (u.id === me.uid) return false;
  if (is('super')) return true;
  if (is('dean')) return u.collegeId === me.collegeId && ['head','registrar','instructor','disabled'].includes(u.role);
  if (is('head')) return u.collegeId === me.collegeId && ['registrar','instructor','disabled'].includes(u.role) &&
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
    <td>${esc(collegeName(u.collegeId))}</td><td>${(u.assignments || []).length
      ? u.assignments.map(a => `<div>📘 ${esc(a.course)} <span class="note">— ${esc(deptName(a.deptId))} / ${esc(a.stage)} / ${esc(a.shift)} / ${esc(a.section || 'كل الشعب')}</span></div>`).join('')
      : (u.deptIds || []).map(d => esc(deptName(d))).join('، ')}</td>
    <td>${canEditUser(u) ? `<button class="btn sm light" data-edit="${esc(u.id)}">تعديل</button>` : ''}</td></tr>`).join('')
    || '<tr><td colspan="6" class="note">لا يوجد مستخدمون</td></tr>';
}
let umEditing = null, umAsg = [], umDeptsAllowed = [];
function umAllowedDepts(){
  const me = App.user;
  return is('super') ? deptList() : is('dean') ? deptList().filter(d => d.collegeId === me.collegeId) : deptList().filter(d => (me.deptIds || []).includes(d.id));
}
function newAsg(deptId){
  const d = (App.org.depts || {})[deptId] || {stages:[''], shifts:[''], sections:[]};
  return {deptId, course:'', stage:d.stages[0], shift:d.shifts[0], section:''};
}
function renderAsg(){
  const opt = (arr, v, all) => (all ? `<option value="" ${!v ? 'selected' : ''}>${all}</option>` : '') + (arr || []).map(x => `<option ${x === v ? 'selected' : ''}>${esc(x)}</option>`).join('');
  $('#umAsgBody').innerHTML = umAsg.map((a, i) => {
    const d = (App.org.depts || {})[a.deptId] || {};
    return `<tr data-i="${i}">
      <td><select data-f="deptId">${umDeptsAllowed.map(x => `<option value="${esc(x.id)}" ${x.id === a.deptId ? 'selected' : ''}>${esc(x.name)}</option>`).join('')}</select></td>
      <td><input data-f="course" value="${esc(a.course)}" placeholder="اسم المادة" style="min-width:160px"></td>
      <td><select data-f="stage">${opt(d.stages, a.stage)}</select></td>
      <td><select data-f="shift">${opt(d.shifts, a.shift)}</select></td>
      <td><select data-f="section">${opt(d.sections, a.section, 'كل الشعب')}</select></td>
      <td><button class="btn sm red" data-rm="${i}" type="button">✕</button></td></tr>`;
  }).join('') || '<tr><td colspan="6" class="note">اضغط "+ إضافة مادة"</td></tr>';
}
$('#umAsgBody').oninput = $('#umAsgBody').onchange = e => {
  const tr = e.target.closest('tr[data-i]'), f = e.target.dataset.f; if (!tr || !f) return;
  const a = umAsg[+tr.dataset.i]; a[f] = e.target.value;
  if (f === 'deptId' && e.type === 'change'){ Object.assign(a, newAsg(a.deptId), {course:a.course}); renderAsg(); }
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
  $('#umDeptBox').classList.toggle('hidden', !['head','registrar'].includes(r));
  if (r === 'instructor' && !umAsg.length) $('#umAddAsg').onclick();
}
$('#umRole').onchange = umRoleUI;
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
  umAsg = u ? clone(u.assignments || []) : [];
  renderAsg(); umRoleUI();
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
    assignments = umAsg.map(a => ({deptId:a.deptId, course:String(a.course || '').trim(), stage:a.stage, shift:a.shift, section:a.section || ''}));
    if (!assignments.length) return toast('أضف مادة واحدة على الأقل للتدريسي', 'err');
    if (assignments.some(a => !a.course || !a.deptId)) return toast('اكتب اسم كل مادة', 'err');
    deptIds = [...new Set(assignments.map(a => a.deptId))];
    if (!is('super')) collegeId = App.user.collegeId;
    else { const d = (App.org.depts || {})[deptIds[0]]; if (d) collegeId = d.collegeId; }
  } else if (['head','registrar'].includes(r) && !deptIds.length) return toast('اختر قسماً واحداً على الأقل', 'err');
  if (!['head','registrar','instructor'].includes(r)) deptIds = deptIds.filter(() => false);
  if (r !== 'super' && !collegeId) return toast('اختر الكلية', 'err');
  $('#umSave').disabled = true;
  try{
    if (umEditing){
      await DB.update('att_users', umEditing.id, {role:r, collegeId, deptIds, assignments, updatedAt:nowISO()}).p;
      toast('تم التحديث', 'ok'); $('#userModal').classList.remove('show');
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
      await DB.set('att_users', uid, {name, email, role:r, collegeId, deptIds, assignments, createdAt:nowISO(), createdBy:App.user.uid}).p;
      const link = location.origin + location.pathname.replace(/index\.html$/, '');
      const txt = `نظام حضور الطلبة — جامعة السراج\nالاسم: ${name}\nالصلاحية: ${ROLES[r]}\n` +
        (assignments.length ? 'المواد: ' + assignments.map(a => `${a.course} (${deptName(a.deptId)} / ${a.stage} / ${a.shift} / ${a.section || 'كل الشعب'})`).join('، ') + '\n' : '') +
        `البريد: ${email}\nالرمز: ${pass}\nالرابط: ${link}`;
      $('#umCred').innerHTML = `<b>✓ تم إنشاء الحساب — سلّم هذه البيانات للمستخدم (الرمز لا يظهر مرة أخرى):</b>
        <pre style="white-space:pre-wrap;font-family:inherit;margin:8px 0" id="umCredTxt">${esc(txt)}</pre>
        <button class="btn sm" id="umCopy" type="button">📋 نسخ</button>`;
      $('#umCred').classList.remove('hidden'); $('#umSave').classList.add('hidden'); $('#umCancel').textContent = 'إغلاق';
      $('#umCopy').onclick = async () => { try{ await navigator.clipboard.writeText(txt); toast('نُسخ', 'ok'); }catch(e){ toast('انسخ النص يدوياً', 'err'); } };
      toast('تم إنشاء حساب ' + name, 'ok');
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
  const t = $('#orgTerm').value.trim(); if (!t) return toast('اكتب اسم الفصل', 'err');
  if (t === App.org.term) return;
  if (!(await confirmBox('تغيير الفصل الدراسي', `ستُنسب المحاضرات الجديدة إلى "${t}"، وستعرض التقارير هذا الفصل فقط. سجلات الفصل السابق تبقى محفوظة.`, 'تغيير'))) return;
  saveOrg(Object.assign(clone(App.org), {term:t}), 'تم تغيير الفصل الدراسي');
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
  $('#stInfo').textContent = `${dn} — ${st.stage} / ${st.shift} — ${st.email || ''}`;
  stConn(); $('#stResult').innerHTML = ''; camHelp('');
  $('#stVer') && ($('#stVer').textContent = 'الإصدار ' + APP_VERSION);
  const bind = await bindDevice(st);
  if (bind !== true){ stopScan(); $('#scanBtn').classList.add('hidden'); camHelp(bind); return; }
  renderQueue(); flushQueue();
  if ((st.p || []).length) loadStudentModels(); // تجهيز التحقق من الوجه مسبقاً ليعمل دون اتصال
  const pend = sessionStorage.getItem('fa_pending');
  if (pend){ sessionStorage.removeItem('fa_pending'); submitFromText(pend); }
  else if (inAppBrowser()){ $('#scanBtn').classList.remove('hidden'); camFail('inapp'); }
  else startScan(); // تفتح الكاميرا مباشرة بعد الدخول
}
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
  const capturedAt = Date.now();
  let face = null;
  if (q.face) face = await verifyFace();
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
    const face = list[0].face ? await verifyFace() : null;
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
  $('#scanBtn') && $('#scanBtn').classList.remove('hidden');
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
