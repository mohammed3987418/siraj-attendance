'use strict';
/* =====================================================================
   نظام حضور الطلبة ببصمة الوجه — PWA
   جامعة السراج — قسم هندسة تقنيات الذكاء الاصطناعي
   - التعرف على الوجه داخل المتصفح (face-api) بدون خادم
   - Firebase Auth + Firestore مع العمل دون اتصال والمزامنة التلقائية
   - إن لم تُملأ firebase-config.js يعمل بوضع محلي تجريبي
   ===================================================================== */
const APP_VERSION = '2.0.0';
const MODEL_URL = 'https://cdn.jsdelivr.net/npm/@vladmandic/face-api@1/model/';
const ROLES = {admin:'رئيس القسم', registrar:'موظف تسجيل', instructor:'تدريسي', disabled:'معطّل'};
const TAB_ROLES = {
  tStudents:['admin','registrar'], tSession:['admin','instructor'], tRecords:['admin','instructor'],
  tUsers:['admin'], tSettings:['admin','registrar','instructor']
};
let db = null, auth = null;

/* ============ أدوات عامة ============ */
const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const LS = {
  get(k, d){ try{ const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; }catch(e){ return d; } },
  set(k, v){ try{ localStorage.setItem(k, JSON.stringify(v)); return true; }catch(e){ toast('تعذّر الحفظ على الجهاز: المساحة غير متاحة', 'err'); return false; } }
};
function toast(msg, type=''){
  const t = document.createElement('div'); t.className = 'toast ' + type; t.textContent = msg;
  $('#toasts').appendChild(t); setTimeout(() => t.remove(), 4000);
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
const cleanId = s => String(s || '').trim().replace(/[\/#?\[\]]/g, '-');
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
// كتابة في الخلفية: لا ننتظرها لأن Firestore يحفظها محلياً ويرفعها عند الاتصال
const bg = (p, okMsg) => p.then(() => { if (okMsg) toast(okMsg, 'ok'); }).catch(e => { console.error(e); toast('فشل الحفظ على الخادم: ' + fbErr(e), 'err'); });
const can = (...roles) => Store.user && roles.includes(Store.user.role);

/* ============ إعدادات الجهاز ============ */
const Settings = {
  get(){ return Object.assign({threshold:0.5, liveness:'turn', minFrames:3, cameraId:''}, LS.get('fa_settings', {})); },
  save(s){ LS.set('fa_settings', s); }
};

/* =====================================================================
   طبقة البيانات (محلي أو Firebase)
   المجموعات: att_users, att_students, att_faceprints, att_sessions
   ===================================================================== */
const Store = {
  mode:'local', user:null, students:[], prints:{}, sessions:[], users:[], pending:0, unsub:[],

  changed(){ renderAll(); },
  student(id){ return this.students.find(s => s.id === id); },
  nameOf(id){
    const s = this.student(id); if (s) return s.name;
    for (const x of this.sessions){ if (x.names && x.names[id]) return x.names[id]; }
    return id;
  },

  /* ---------- محلي ---------- */
  loadLocal(){
    this.students = LS.get('fa_students', []); this.prints = LS.get('fa_prints', {}); this.sessions = LS.get('fa_sessions', []);
    let mig = false; // ترحيل بيانات النسخة الأولى
    this.students.forEach(s => {
      if ('descriptors' in s){
        if (s.descriptors && s.descriptors.length) this.prints[s.id] = {samples:s.descriptors, consent:!!s.consent, enrolledAt:s.enrolledAt, stage:s.stage, shift:s.shift, section:s.section};
        delete s.descriptors; delete s.consent; delete s.enrolledAt; mig = true;
      }
    });
    if (mig) this.persistLocal();
  },
  persistLocal(){ LS.set('fa_students', this.students); LS.set('fa_prints', this.prints); LS.set('fa_sessions', this.sessions); },

  /* ---------- Firebase ---------- */
  subscribe(){
    const u = this.user, err = e => { console.error(e); toast('خطأ في المزامنة: ' + fbErr(e), 'err'); };
    if (u.role === 'admin' || u.role === 'registrar'){
      this.unsub.push(db.collection('att_students').onSnapshot(q => {
        this.students = q.docs.map(d => Object.assign({id:d.id}, d.data())).sort((a,b) => a.id.localeCompare(b.id, 'en', {numeric:true}));
        this.changed();
      }, err));
      this.unsub.push(db.collection('att_faceprints').onSnapshot(q => {
        const p = {}; q.docs.forEach(d => p[d.id] = this.fromPrintDoc(d.data())); this.prints = p; this.changed();
      }, err));
    }
    if (u.role === 'admin' || u.role === 'instructor'){
      let q = db.collection('att_sessions');
      if (u.role === 'instructor') q = q.where('instructorUid', '==', u.uid);
      this.unsub.push(q.onSnapshot({includeMetadataChanges:true}, s => {
        this.sessions = s.docs.map(d => Object.assign({id:d.id, _pending:d.metadata.hasPendingWrites}, d.data()));
        this.pending = this.sessions.filter(x => x._pending).length;
        this.changed();
      }, err));
    }
    if (u.role === 'admin'){
      this.unsub.push(db.collection('att_users').onSnapshot(q => {
        this.users = q.docs.map(d => Object.assign({uid:d.id}, d.data())); this.changed();
      }, err));
    }
  },
  stop(){
    this.unsub.forEach(f => { try{ f(); }catch(e){} });
    this.unsub = []; this.students = []; this.prints = {}; this.sessions = []; this.users = []; this.pending = 0;
  },
  fromPrintDoc(x){ return {samples:(x.samples || []).map(s => s.v), consent:!!x.consent, enrolledAt:x.enrolledAt || null, stage:x.stage, shift:x.shift, section:x.section}; },

  /* ---------- العمليات ---------- */
  addStudents(list){
    const exist = new Set(this.students.map(s => s.id)), fresh = []; let dup = 0;
    list.forEach(s => {
      const id = cleanId(s.id); if (!id || !s.name) return;
      if (exist.has(id)){ dup++; return; } exist.add(id);
      fresh.push({id, name:String(s.name).trim(), stage:s.stage || 'الأولى', shift:s.shift || 'صباحي', section:s.section || 'A'});
    });
    if (this.mode === 'local'){ this.students.push(...fresh); this.persistLocal(); this.changed(); }
    else {
      for (let i = 0; i < fresh.length; i += 400){
        const b = db.batch();
        fresh.slice(i, i+400).forEach(s => { const {id, ...d} = s; b.set(db.collection('att_students').doc(id), d); });
        bg(b.commit());
      }
    }
    return {added:fresh.length, dup};
  },
  deleteStudent(id){
    if (this.mode === 'local'){ this.students = this.students.filter(s => s.id !== id); delete this.prints[id]; this.persistLocal(); this.changed(); }
    else { bg(db.collection('att_students').doc(id).delete()); bg(db.collection('att_faceprints').doc(id).delete()); }
  },
  savePrint(id, samples){
    const s = this.student(id);
    const p = {samples, consent:true, enrolledAt:new Date().toISOString(), stage:s.stage, shift:s.shift, section:s.section};
    if (this.mode === 'local'){ this.prints[id] = p; this.persistLocal(); this.changed(); }
    else bg(db.collection('att_faceprints').doc(id).set(Object.assign({}, p, {samples:samples.map(v => ({v})), by:this.user.uid})));
  },
  clearPrint(id){
    if (this.mode === 'local'){ delete this.prints[id]; this.persistLocal(); this.changed(); }
    else bg(db.collection('att_faceprints').doc(id).delete());
  },
  // تحميل طلبة وبصمات المرحلة/الدراسة عند بدء المحاضرة (يقلل القراءات للتدريسيين)
  async loadRoster(stage, shift){
    if (this.mode === 'local' || this.user.role !== 'instructor'){
      const students = this.students.filter(s => s.stage === stage && s.shift === shift);
      const prints = {}; students.forEach(s => { if (this.prints[s.id] && this.prints[s.id].samples.length) prints[s.id] = this.prints[s.id].samples; });
      return {students, prints};
    }
    const [qs, qp] = await Promise.all([
      db.collection('att_students').where('stage','==',stage).where('shift','==',shift).get(),
      db.collection('att_faceprints').where('stage','==',stage).where('shift','==',shift).get()
    ]);
    const students = qs.docs.map(d => Object.assign({id:d.id}, d.data()));
    const prints = {}; qp.docs.forEach(d => { const p = this.fromPrintDoc(d.data()); if (p.samples.length) prints[d.id] = p.samples; });
    return {students, prints};
  },
  saveSession(rec){
    if (this.mode === 'local'){
      rec.id = 'S' + Date.now(); this.sessions.push(rec);
      if (LS.set('fa_sessions', this.sessions)) toast('تم حفظ حضور المحاضرة', 'ok');
      this.changed(); return;
    }
    const ref = db.collection('att_sessions').doc();
    bg(ref.set(rec), 'تم رفع حضور المحاضرة إلى الخادم ✓');
    if (!navigator.onLine) toast('لا يوجد إنترنت: حُفظ الحضور على الجهاز وسيُرفع تلقائياً عند عودة الاتصال', 'ok');
  },
  deleteSession(id){
    if (this.mode === 'local'){ this.sessions = this.sessions.filter(x => x.id !== id); this.persistLocal(); this.changed(); }
    else bg(db.collection('att_sessions').doc(id).delete());
  },
  async addUser({name, email, password, role}){
    const sec = firebase.apps.find(a => a.name === 'secondary') || firebase.initializeApp(window.FIREBASE_CONFIG, 'secondary');
    const cred = await sec.auth().createUserWithEmailAndPassword(email, password);
    await sec.auth().signOut();
    await db.collection('att_users').doc(cred.user.uid).set({name, email, role, createdAt:new Date().toISOString()});
  },
  setRole(uid, role){ bg(db.collection('att_users').doc(uid).update({role}), 'تم تحديث الصلاحية'); },
  exportData(){
    return {app:'siraj-attendance', version:APP_VERSION, exportedAt:new Date().toISOString(),
      students:this.students, prints:this.prints, sessions:this.sessions.map(({_pending, ...x}) => x)};
  },
  importData(d){
    const students = d.students || [], prints = d.prints || {}, sessions = d.sessions || [];
    if (this.mode === 'local'){ this.students = students; this.prints = prints; this.sessions = sessions; this.persistLocal(); this.changed(); return; }
    const ops = [];
    students.forEach(s => { const {id, ...x} = s; ops.push(b => b.set(db.collection('att_students').doc(cleanId(id)), x)); });
    Object.entries(prints).forEach(([id, p]) => ops.push(b => b.set(db.collection('att_faceprints').doc(cleanId(id)),
      Object.assign({}, p, {samples:(p.samples || []).map(v => ({v})), by:this.user.uid}))));
    sessions.forEach(s => { const {id, ...x} = s; ops.push(b => b.set(id ? db.collection('att_sessions').doc(cleanId(id)) : db.collection('att_sessions').doc(), x)); });
    for (let i = 0; i < ops.length; i += 400){ const b = db.batch(); ops.slice(i, i+400).forEach(f => f(b)); bg(b.commit()); }
  }
};

/* ============ الواجهة العامة ============ */
document.querySelectorAll('nav button').forEach(b => b.onclick = () => showTab(b.dataset.tab));
function showTab(id){
  document.querySelectorAll('nav button').forEach(x => x.classList.toggle('active', x.dataset.tab === id));
  document.querySelectorAll('.tab').forEach(x => x.classList.toggle('active', x.id === id));
}
function applyRole(){
  const r = Store.user.role; let first = null;
  document.querySelectorAll('nav button').forEach(b => {
    let ok = TAB_ROLES[b.dataset.tab].includes(r);
    if (b.dataset.tab === 'tUsers' && Store.mode === 'local') ok = false;
    b.classList.toggle('hidden', !ok); if (ok && !first) first = b.dataset.tab;
  });
  showTab(first);
  $('#userBox').textContent = `${Store.user.name || Store.user.email || ''} — ${ROLES[r]}`;
  $('#logoutBtn').classList.toggle('hidden', Store.mode === 'local');
  $('#localBanner').classList.toggle('hidden', Store.mode !== 'local');
  $('#backupCard').classList.toggle('hidden', r !== 'admin');
  $('#clearAllBtn').classList.toggle('hidden', Store.mode !== 'local');
  $('#aboutText').innerHTML = `الإصدار ${APP_VERSION} — وضع التشغيل: ${Store.mode === 'local' ? 'محلي تجريبي' : 'Firebase (مشروع ' + esc((window.FIREBASE_CONFIG || {}).projectId) + ')'}.<br>
    التعرف على الوجه يجري بالكامل داخل هذا الجهاز، ويعمل التطبيق دون إنترنت بعد أول فتح.`;
}
function showApp(){ $('#loginView').classList.add('hidden'); $('#appView').classList.remove('hidden'); applyRole(); renderAll(); }
function showLogin(msg){
  $('#appView').classList.add('hidden'); $('#loginView').classList.remove('hidden');
  if (msg !== undefined) $('#loginErr').textContent = msg;
  $('#loginBtn').disabled = false;
}
function renderAll(){
  if (!Store.user) return;
  renderStudents(); renderRecords(); renderUsers(); updateConn(); renderCourseList();
}
function updateConn(){
  const el = $('#conn');
  if (Store.mode === 'local'){ el.textContent = 'وضع محلي'; el.className = 'pill warn'; return; }
  if (!navigator.onLine){ el.textContent = 'غير متصل — يعمل على الجهاز' + (Store.pending ? ` (${Store.pending} بانتظار الرفع)` : ''); el.className = 'pill warn'; return; }
  if (Store.pending){ el.textContent = `جارٍ رفع ${Store.pending} محاضرة...`; el.className = 'pill warn'; return; }
  el.textContent = 'متصل ✓ — كل البيانات مرفوعة'; el.className = 'pill ok';
}
window.addEventListener('online', updateConn); window.addEventListener('offline', updateConn);

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
      w && w.addEventListener('statechange', () => {
        if (w.state === 'installed' && navigator.serviceWorker.controller) toast('يتوفر تحديث للتطبيق — أعد فتحه لتطبيقه', 'ok');
      });
    });
  }).catch(e => console.warn('SW', e));
}

/* ============ تحميل نماذج التعرف ============ */
let modelsReady = false;
function setModelStatus(t, c=''){ const el = $('#modelStatus'); el.textContent = t; el.className = 'pill ' + c; }
async function loadModels(){
  if (typeof faceapi === 'undefined'){ setModelStatus('مكتبة التعرف غير محمّلة — افتح التطبيق مع إنترنت مرة واحدة', 'err'); return; }
  if (!window.isSecureContext) toast('يجب فتح التطبيق عبر https حتى تعمل الكاميرا', 'err');
  setModelStatus('جارٍ تحميل نماذج الوجه...');
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

/* ============ الكاميرا والكشف ============ */
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
  return res.sort((a,b) => boxArea(b) - boxArea(a));
}
function drawBoxes(canvas, video, faces, color){
  canvas.width = video.videoWidth; canvas.height = video.videoHeight;
  const ctx = canvas.getContext('2d'); ctx.clearRect(0, 0, canvas.width, canvas.height); ctx.lineWidth = 4;
  faces.forEach((f, i) => { const b = f.detection.box; ctx.strokeStyle = i === 0 ? color : '#999'; ctx.strokeRect(b.x, b.y, b.width, b.height); });
}
const dist = (a,b) => Math.hypot(a.x-b.x, a.y-b.y);
function eyeAR(p){ const e = i => (dist(p[i+1],p[i+5]) + dist(p[i+2],p[i+4])) / (2*dist(p[i],p[i+3])); return (e(36) + e(42)) / 2; }
function yawRatio(p){ const l = p[36], r = p[45], n = p[30]; return (n.x - l.x) / (r.x - l.x); }
const descToArr = d => Array.from(d).map(v => +v.toFixed(5));
function buildMatcher(prints, threshold){
  const labeled = Object.entries(prints).filter(([,s]) => s && s.length)
    .map(([id, s]) => new faceapi.LabeledFaceDescriptors(id, s.map(d => new Float32Array(d))));
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

/* ============ الطلبة ============ */
$('#addStudentBtn').onclick = () => {
  const s = {id:$('#sId').value, name:$('#sName').value.trim(), stage:$('#sStage').value, shift:$('#sShift').value, section:$('#sSection').value};
  if (!cleanId(s.id) || !s.name) return toast('أدخل الرقم الجامعي والاسم', 'err');
  const r = Store.addStudents([s]);
  toast(r.added ? 'تمت الإضافة' : 'الرقم الجامعي موجود مسبقاً', r.added ? 'ok' : 'err');
  if (r.added){ $('#sId').value = ''; $('#sName').value = ''; $('#sId').focus(); }
};
$('#toggleBulk').onclick = () => $('#bulkBox').classList.toggle('hidden');
$('#bulkAddBtn').onclick = () => {
  const rows = $('#bulkText').value.split(/\r?\n/).map(l => l.split(/\t|,|،/).map(x => x.trim())).filter(r => r.length >= 2 && r[0]);
  const r = Store.addStudents(rows.map(x => ({id:x[0], name:x[1], stage:x[2], shift:x[3], section:x[4]})));
  toast(`تمت إضافة ${r.added} طالب` + (r.dup ? ` — ${r.dup} مكرر لم يُضف` : ''), r.added ? 'ok' : 'err');
  if (r.added) $('#bulkText').value = '';
};
['#fStage','#fShift','#fPrint','#fSearch'].forEach(s => $(s).oninput = renderStudents);
function renderStudents(){
  if (!can('admin','registrar')) return;
  const st = $('#fStage').value, sh = $('#fShift').value, fp = $('#fPrint').value, q = $('#fSearch').value.trim();
  const has = id => !!(Store.prints[id] && Store.prints[id].samples.length);
  const list = Store.students.filter(s => (!st || s.stage === st) && (!sh || s.shift === sh) &&
    (!fp || (fp === 'yes') === has(s.id)) && (!q || s.name.includes(q) || s.id.includes(q)));
  const enrolledN = Store.students.filter(s => has(s.id)).length;
  $('#studCount').textContent = `${Store.students.length} طالب — ${enrolledN} لديهم بصمة`;
  $('#studentsBody').innerHTML = list.slice(0, 600).map(s => {
    const n = has(s.id) ? Store.prints[s.id].samples.length : 0;
    return `<tr><td>${esc(s.id)}</td><td>${esc(s.name)}</td><td>${esc(s.stage)}</td><td>${esc(s.shift)}</td><td>${esc(s.section)}</td>
    <td>${n ? `<span class="badge b-face">مسجّلة (${n})</span>` : '<span class="badge b-abs">غير مسجّلة</span>'}</td>
    <td class="row"><button class="btn sm" data-enroll="${esc(s.id)}">${n ? 'إعادة التسجيل' : 'تسجيل البصمة'}</button>
    ${n ? `<button class="btn sm light" data-clear="${esc(s.id)}">حذف البصمة</button>` : ''}
    <button class="btn sm red" data-del="${esc(s.id)}">حذف</button></td></tr>`;
  }).join('') || '<tr><td colspan="7" class="note">لا يوجد طلبة</td></tr>';
}
$('#studentsBody').onclick = async e => {
  const b = e.target.closest('button'); if (!b) return;
  if (b.dataset.enroll) openEnroll(b.dataset.enroll);
  if (b.dataset.clear && await confirmBox('حذف البصمة', 'سيتم حذف بصمة وجه هذا الطالب نهائياً.', 'حذف')) Store.clearPrint(b.dataset.clear);
  if (b.dataset.del && await confirmBox('حذف الطالب', 'سيتم حذف الطالب وبصمته. سجلات الحضور السابقة تبقى كما هي.', 'حذف')) Store.deleteStudent(b.dataset.del);
};

/* ============ تسجيل البصمة ============ */
let enroll = null, enrollLoop = false;
async function openEnroll(id){
  if (!modelsReady) return toast('انتظر حتى تكتمل نماذج الوجه', 'err');
  const s = Store.student(id); enroll = {id, samples:[]};
  $('#enrollTitle').textContent = 'تسجيل بصمة: ' + s.name + ' (' + s.id + ')';
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
  const sm = enroll.samples; let maxD = 0;
  for (let i = 0; i < sm.length; i++) for (let j = i+1; j < sm.length; j++) maxD = Math.max(maxD, faceapi.euclideanDistance(sm[i], sm[j]));
  if (maxD > 0.6 && !(await confirmBox('تحذير', 'الصور الملتقطة متباينة كثيراً وقد لا تكون لنفس الشخص. هل تريد الحفظ رغم ذلك؟', 'حفظ'))) return;
  const others = {}; Object.entries(Store.prints).forEach(([id, p]) => { if (id !== enroll.id) others[id] = p.samples; });
  const m = buildMatcher(others, Settings.get().threshold);
  if (m){
    const best = m.findBestMatch(sm[0]);
    if (best.label !== 'unknown' && !(await confirmBox('وجه مشابه!', `هذا الوجه يشبه الطالب المسجّل: ${Store.nameOf(best.label)} (${best.label}). قد يكون تلاعباً أو تشابهاً (توأم). هل تريد الحفظ؟`, 'حفظ'))) return;
  }
  const name = Store.nameOf(enroll.id);
  Store.savePrint(enroll.id, sm.map(descToArr));
  toast('تم حفظ البصمة: ' + name, 'ok'); closeEnroll();
};

/* ============ أخذ الحضور ============ */
let sess = null, matcher = null, loopOn = false, track = {id:null};
$('#cDate').value = today();
function renderCourseList(){
  const set = new Set(Store.sessions.map(s => s.course));
  $('#courseList').innerHTML = [...set].map(c => `<option value="${esc(c)}">`).join('');
}
$('#startSessionBtn').onclick = async () => {
  if (!modelsReady) return toast('انتظر حتى تكتمل نماذج الوجه', 'err');
  const meta = {course:$('#cName').value.trim(), stage:$('#cStage').value, shift:$('#cShift').value, section:$('#cSection').value,
    type:$('#cType').value, hours:+$('#cHours').value || 1, date:$('#cDate').value || today(),
    instructorUid:Store.user.uid, instructorName:Store.user.name || Store.user.email || ''};
  if (!meta.course) return toast('أدخل اسم المادة', 'err');
  $('#startSessionBtn').disabled = true;
  let data;
  try{ data = await Store.loadRoster(meta.stage, meta.shift); }
  catch(e){ $('#startSessionBtn').disabled = false; return toast('تعذّر تحميل قائمة الطلبة: ' + fbErr(e), 'err'); }
  $('#startSessionBtn').disabled = false;
  const roster = data.students.filter(s => !meta.section || s.section === meta.section)
    .sort((a,b) => a.name.localeCompare(b.name, 'ar'));
  if (!roster.length) return toast('لا يوجد طلبة بهذه المرحلة/الدراسة/الشعبة (أو لم تُحمَّل بعد — افتحها مرة مع إنترنت)', 'err');
  matcher = buildMatcher(data.prints, Settings.get().threshold);
  const noPrint = roster.filter(s => !data.prints[s.id]).length;
  if (!matcher) toast('لا توجد بصمات مسجّلة لهذه المرحلة — سجّل الحضور يدوياً', 'err');
  else if (noPrint) toast(`${noPrint} طالب بدون بصمة — سجّلهم يدوياً`, 'err');
  sess = {meta, names:Object.fromEntries(data.students.map(s => [s.id, s.name])), hasPrint:data.prints,
          roster:new Map(roster.map(s => [s.id, {status:'absent', time:'', dist:null}]))};
  $('#sessionSetup').classList.add('hidden'); $('#sessionLive').classList.remove('hidden');
  $('#liveTitle').textContent = `${meta.course} — المرحلة ${meta.stage} / ${meta.shift}${meta.section ? ' / شعبة ' + meta.section : ''} — ${meta.type} (${meta.hours} ساعة) — ${meta.date}`;
  $('#rosterSearch').value = ''; renderRoster();
  if (matcher) await resumeCamera(); else showPrompt('لا توجد بصمات — التسجيل يدوي', 'warn');
};
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
    id = track.id; // أثناء حركة الرأس قد تنخفض الثقة مؤقتاً
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
function markPresent(id, method, d=null){
  const st = sess.roster.get(id); if (!st) return;
  st.status = method; st.time = hhmm(); st.dist = d;
  if (method === 'face'){ beep(); showPrompt(`✓ ${sess.names[id] || id} — حاضر`, 'ok'); }
  renderRoster();
}
$('#rosterSearch').oninput = renderRoster;
function renderRoster(){
  if (!sess) return;
  const q = $('#rosterSearch').value.trim(); let present = 0;
  sess.roster.forEach(st => { if (st.status !== 'absent') present++; });
  const rows = [...sess.roster.entries()]
    .filter(([id]) => !q || (sess.names[id] || '').includes(q) || id.includes(q))
    .sort((a,b) => (a[1].status === 'absent') - (b[1].status === 'absent'));
  $('#rosterBody').innerHTML = rows.map(([id, st]) => {
    const badge = st.status === 'face' ? '<span class="badge b-face">حاضر (وجه)</span>' : st.status === 'manual' ? '<span class="badge b-man">حاضر (يدوي)</span>' : '<span class="badge b-abs">غائب</span>';
    const btn = st.status === 'absent' ? `<button class="btn sm light" data-man="${esc(id)}">حاضر يدوياً</button>` : `<button class="btn sm light" data-undo="${esc(id)}">إلغاء</button>`;
    return `<tr><td>${esc(sess.names[id] || id)}${sess.hasPrint[id] ? '' : ' <span class="badge b-gray">بلا بصمة</span>'}</td><td>${badge}</td><td>${st.time}</td><td>${btn}</td></tr>`;
  }).join('');
  $('#stPresent').textContent = present; $('#stTotal').textContent = sess.roster.size; $('#stAbsent').textContent = sess.roster.size - present;
}
$('#rosterBody').onclick = e => {
  const b = e.target.closest('button'); if (!b) return;
  if (b.dataset.man) markPresent(b.dataset.man, 'manual');
  if (b.dataset.undo){ const st = sess.roster.get(b.dataset.undo); st.status = 'absent'; st.time = ''; st.dist = null; track = {id:null}; renderRoster(); }
};
function endSessionUI(){
  loopOn = false; stopCamera($('#video')); sess = null; matcher = null;
  $('#sessionLive').classList.add('hidden'); $('#sessionSetup').classList.remove('hidden');
}
$('#cancelSessionBtn').onclick = async () => {
  if (await confirmBox('إلغاء المحاضرة', 'سيُلغى أخذ الحضور لهذه المحاضرة دون حفظ أي شيء.', 'إلغاء دون حفظ')) endSessionUI();
};
$('#finishBtn').onclick = async () => {
  const absent = [...sess.roster.values()].filter(s => s.status === 'absent').length;
  if (!(await confirmBox('إنهاء المحاضرة', `سيُحفظ الحضور: ${sess.roster.size - absent} حاضر و${absent} غائب.`, 'حفظ'))) return;
  const entries = [...sess.roster.entries()];
  const names = {}; entries.forEach(([id]) => names[id] = sess.names[id] || id);
  const rec = Object.assign({}, sess.meta, {
    absentees: entries.filter(([,s]) => s.status === 'absent').map(([id]) => id),
    present: entries.filter(([,s]) => s.status !== 'absent').map(([id, s]) => ({id, method:s.status, time:s.time, dist:s.dist == null ? null : +s.dist.toFixed(3)})),
    names, createdAt:new Date().toISOString(), appVersion:APP_VERSION
  });
  Store.saveSession(rec); endSessionUI();
};
window.addEventListener('beforeunload', e => { if (sess){ e.preventDefault(); e.returnValue = ''; } });

/* ============ السجلات والتقارير ============ */
const courseKey = s => `${s.course} | ${s.stage} | ${s.shift}`;
function renderRecords(){
  if (!can('admin','instructor')) return;
  const list = Store.sessions.slice().sort((a,b) => (b.date + b.createdAt).localeCompare(a.date + a.createdAt));
  const isAdmin = can('admin');
  $('#sessionsBody').innerHTML = list.map(s => `<tr><td>${esc(s.date)}</td><td>${esc(s.course)}</td>
    <td>${esc(s.stage)} / ${esc(s.shift)} / ${esc(s.section || 'الكل')}</td><td>${esc(s.type)}</td><td>${s.hours}</td><td>${esc(s.instructorName || '')}</td>
    <td>${(s.present || []).length}</td><td>${(s.absentees || []).length}</td>
    <td>${Store.mode === 'local' ? '<span class="badge b-gray">محلي</span>' : s._pending ? '<span class="badge b-man">بانتظار الرفع</span>' : '<span class="badge b-face">مرفوع ✓</span>'}</td>
    <td class="row"><button class="btn sm light" data-csv="${esc(s.id)}">CSV</button>${isAdmin ? `<button class="btn sm red" data-sdel="${esc(s.id)}">حذف</button>` : ''}</td></tr>`).join('')
    || '<tr><td colspan="10" class="note">لا توجد محاضرات محفوظة</td></tr>';
  const keys = [...new Set(Store.sessions.map(courseKey))].sort();
  const cur = $('#sumCourse').value;
  $('#sumCourse').innerHTML = keys.map(k => `<option ${k === cur ? 'selected' : ''}>${esc(k)}</option>`).join('') || '<option value="">لا توجد مواد</option>';
  renderSummary();
}
$('#sessionsBody').onclick = async e => {
  const b = e.target.closest('button'); if (!b) return;
  if (b.dataset.csv){
    const s = Store.sessions.find(x => x.id === b.dataset.csv);
    const nm = id => (s.names && s.names[id]) || Store.nameOf(id);
    const rows = [['المادة', s.course, 'التاريخ', s.date, 'الساعات', s.hours], ['الرقم','الاسم','الحالة','طريقة التسجيل','الوقت']];
    (s.present || []).forEach(p => rows.push([p.id, nm(p.id), 'حاضر', p.method === 'face' ? 'بصمة وجه' : 'يدوي', p.time]));
    (s.absentees || []).forEach(id => rows.push([id, nm(id), 'غائب', '', '']));
    download(`حضور_${s.course}_${s.date}.csv`, toCSV(rows), 'text/csv');
  }
  if (b.dataset.sdel && await confirmBox('حذف المحاضرة', 'سيُحذف سجل حضور هذه المحاضرة نهائياً.', 'حذف')) Store.deleteSession(b.dataset.sdel);
};
function summaryRows(){
  const key = $('#sumCourse').value; if (!key) return [];
  const ss = Store.sessions.filter(s => courseKey(s) === key);
  const held = ss.reduce((a, s) => a + (+s.hours || 0), 0), abs = {}, names = {};
  ss.forEach(s => {
    Object.assign(names, s.names || {});
    (s.absentees || []).forEach(id => abs[id] = (abs[id] || 0) + (+s.hours || 0));
    (s.present || []).forEach(p => abs[p.id] = abs[p.id] || 0);
  });
  return Object.entries(abs).map(([id, h]) => ({id, name:names[id] || Store.nameOf(id), h, held, pct: held ? h/held*100 : 0}))
    .sort((a,b) => b.pct - a.pct || a.name.localeCompare(b.name, 'ar'));
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

/* ============ المستخدمون ============ */
function renderUsers(){
  if (!can('admin') || Store.mode === 'local') return;
  $('#usersBody').innerHTML = Store.users.slice().sort((a,b) => (a.name || '').localeCompare(b.name || '', 'ar')).map(u => `<tr>
    <td>${esc(u.name)}</td><td dir="ltr" style="text-align:right">${esc(u.email)}</td>
    <td>${u.uid === Store.user.uid ? `<span class="badge b-face">${ROLES[u.role]} (أنت)</span>` :
      `<select data-role="${esc(u.uid)}" style="width:auto">${Object.entries(ROLES).map(([k, v]) => `<option value="${k}" ${k === u.role ? 'selected' : ''}>${v}</option>`).join('')}</select>`}</td></tr>`).join('');
}
$('#usersBody').onchange = e => { const s = e.target.closest('select[data-role]'); if (s) Store.setRole(s.dataset.role, s.value); };
$('#addUserBtn').onclick = async () => {
  const u = {name:$('#uName').value.trim(), email:$('#uEmail').value.trim(), password:$('#uPass').value, role:$('#uRole').value};
  if (!u.name || !u.email || u.password.length < 6) return toast('أكمل الاسم والبريد وكلمة مرور من ٦ أحرف على الأقل', 'err');
  if (!navigator.onLine) return toast('إنشاء الحسابات يتطلب اتصالاً بالإنترنت', 'err');
  $('#addUserBtn').disabled = true;
  try{ await Store.addUser(u); toast('تم إنشاء حساب ' + u.name, 'ok'); $('#uName').value = $('#uEmail').value = $('#uPass').value = ''; }
  catch(e){ toast('تعذّر إنشاء الحساب: ' + fbErr(e), 'err'); }
  $('#addUserBtn').disabled = false;
};

/* ============ الإعدادات ============ */
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
    $('#setCamera').innerHTML = '<option value="">الافتراضية</option>' + cams.map((c, i) => `<option value="${esc(c.deviceId)}" ${c.deviceId === cur ? 'selected' : ''}>${esc(c.label || 'كاميرا ' + (i+1))}</option>`).join('');
  }catch(e){ toast('تعذّر الوصول إلى الكاميرات', 'err'); }
};
$('#backupBtn').onclick = () => download(`نسخة_الحضور_${today()}.json`, JSON.stringify(Store.exportData()), 'application/json');
$('#restoreInput').onchange = async e => {
  const f = e.target.files[0]; if (!f) return;
  try{
    const d = JSON.parse(await f.text());
    // يقبل أيضاً نسخة النموذج الأول (البصمات داخل الطلبة)
    if (Array.isArray(d.students) && !d.prints){
      d.prints = {};
      d.students.forEach(s => { if (s.descriptors && s.descriptors.length) d.prints[s.id] = {samples:s.descriptors, consent:!!s.consent, enrolledAt:s.enrolledAt, stage:s.stage, shift:s.shift, section:s.section}; delete s.descriptors; delete s.consent; delete s.enrolledAt; });
    }
    if (!Array.isArray(d.students)) throw 0;
    const msg = Store.mode === 'local' ? 'ستُستبدل البيانات المحلية بمحتوى النسخة.' : `سيُرفع ${d.students.length} طالب و${Object.keys(d.prints || {}).length} بصمة و${(d.sessions || []).length} محاضرة إلى Firebase (مع تحديث الموجود).`;
    if (!(await confirmBox('استيراد نسخة', msg, 'استيراد'))) return;
    Store.importData(d); toast('تم الاستيراد', 'ok');
  }catch(err){ toast('ملف غير صالح', 'err'); }
  e.target.value = '';
};
$('#clearAllBtn').onclick = async () => {
  if (!(await confirmBox('حذف كل البيانات المحلية', 'سيُحذف كل الطلبة والبصمات وسجلات الحضور من هذا الجهاز. نزّل نسخة احتياطية أولاً.', 'حذف'))) return;
  Store.students = []; Store.prints = {}; Store.sessions = []; Store.persistLocal(); Store.changed(); toast('تم الحذف', 'ok');
};

/* ============ تسجيل الدخول ============ */
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
  if (Store.pending && !(await confirmBox('بيانات غير مرفوعة', `توجد ${Store.pending} محاضرة لم تُرفع بعد. إذا خرجت قد تُفقد. هل تريد الخروج؟`, 'خروج'))) return;
  await auth.signOut();
};

/* ============ التشغيل ============ */
async function boot(){
  loadSettingsUI(); registerSW(); loadModels();
  const cfg = window.FIREBASE_CONFIG || {};
  if (!cfg.apiKey){
    Store.mode = 'local'; Store.loadLocal();
    Store.user = {uid:'local', name:'المسؤول', role:'admin'};
    showApp(); return;
  }
  if (typeof firebase === 'undefined'){ showLogin('تعذّر تحميل Firebase — افتح التطبيق مع اتصال بالإنترنت مرة واحدة على الأقل'); $('#loginBtn').disabled = true; return; }
  firebase.initializeApp(cfg);
  db = firebase.firestore();
  try{ await db.enablePersistence({synchronizeTabs:true}); }
  catch(e){ console.warn('persistence', e); if (e.code === 'unimplemented') toast('هذا المتصفح لا يدعم العمل دون اتصال', 'err'); }
  auth = firebase.auth();
  Store.mode = 'firebase';
  auth.onAuthStateChanged(async u => {
    Store.stop(); Store.user = null;
    if (!u){ showLogin(); return; }
    try{
      const d = await db.collection('att_users').doc(u.uid).get();
      const role = d.exists ? d.data().role : null;
      if (!role || role === 'disabled' || !ROLES[role]){
        $('#loginErr').textContent = 'هذا الحساب غير مخوّل باستخدام النظام. راجع رئيس القسم.';
        await auth.signOut(); return;
      }
      Store.user = Object.assign({uid:u.uid, email:u.email}, d.data());
      Store.subscribe(); showApp();
    }catch(e){
      console.error(e);
      showLogin('تعذّر التحقق من الصلاحية: ' + fbErr(e) + (navigator.onLine ? '' : ' — يلزم الاتصال بالإنترنت عند أول دخول'));
    }
  });
}
boot();
