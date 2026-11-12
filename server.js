/** MedStudentsHub shared backend — Node.js >=22.13, zero npm packages. */
'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

const ROOT = __dirname;
const PORT = Number(process.env.PORT || 3000);
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(ROOT, 'data'));
const MAX_BODY = 32 * 1024 * 1024;
const MAX_PAGE = 2_400_000;
const MAX_PAGES = 6;
const DEPTS = new Set(['باطنية', 'جراحة', 'أطفال', 'نسائية', 'طوارئ']);
const SESSION_MS = 30 * 24 * 60 * 60 * 1000;
const ADMIN_EMAIL = String(process.env.ADMIN_EMAIL || '').trim().toLowerCase();
const ADMIN_KEY = String(process.env.ADMIN_KEY || '');
const ADMIN_KEY_MIN_LENGTH = 24;
// Doctor self-enrolment: the dean/administrator shares this private invitation code
// with verified faculty members. Never put the code in HTML, GitHub or a URL.
const DOCTOR_INVITE_CODE = String(process.env.DOCTOR_INVITE_CODE || '');
const DOCTOR_INVITE_MIN_LENGTH = 24;

const loginFailures = new Map();
fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
const db = new DatabaseSync(path.join(DATA_DIR, 'medstudentshub.sqlite'));
db.exec(`PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL,
  name TEXT NOT NULL, university TEXT NOT NULL DEFAULT '', country TEXT NOT NULL DEFAULT '',
  grade TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS groups (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL,
  initials TEXT NOT NULL, color TEXT NOT NULL,
  created_by TEXT REFERENCES users(id) ON DELETE SET NULL
);
CREATE TABLE IF NOT EXISTS memberships (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  PRIMARY KEY(user_id, group_id)
);
CREATE TABLE IF NOT EXISTS cases (
  id TEXT PRIMARY KEY, author_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  author_name TEXT NOT NULL, title TEXT NOT NULL, dept TEXT NOT NULL, hospital TEXT NOT NULL,
  year TEXT NOT NULL DEFAULT '', pearl TEXT NOT NULL, audience TEXT NOT NULL DEFAULT 'public',
  group_id TEXT REFERENCES groups(id) ON DELETE SET NULL, pages_json TEXT NOT NULL DEFAULT '[]',
  summary_json TEXT, created_at TEXT NOT NULL, hidden INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS comments (
  id TEXT PRIMARY KEY, case_id TEXT NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
  author_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  text TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS likes (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  case_id TEXT NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
  PRIMARY KEY(user_id, case_id)
);
CREATE TABLE IF NOT EXISTS bookmarks (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  case_id TEXT NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
  PRIMARY KEY(user_id, case_id)
);
CREATE TABLE IF NOT EXISTS reports (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  case_id TEXT NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
  reason TEXT NOT NULL, created_at TEXT NOT NULL,
  UNIQUE(user_id,case_id)
);
CREATE TABLE IF NOT EXISTS moderation_actions (
  id TEXT PRIMARY KEY, actor_id TEXT NOT NULL, case_id TEXT NOT NULL,
  title TEXT NOT NULL, action TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_cases_created ON cases(created_at DESC);
CREATE INDEX IF NOT EXISTS ix_comments_case ON comments(case_id,created_at);`);

// Additive migrations only: existing students, cases, groups and sessions are kept.
function ensureColumn(table, name, definition) {
  const columns=db.prepare(`PRAGMA table_info(${table})`).all().map(row=>row.name);
  if(!columns.includes(name))db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`);
}
ensureColumn('users','role',"TEXT NOT NULL DEFAULT 'student'");
ensureColumn('users','student_number',"TEXT NOT NULL DEFAULT ''");
db.exec("CREATE UNIQUE INDEX IF NOT EXISTS ix_users_student_number ON users(student_number) WHERE role='student' AND student_number<>''");
ensureColumn('cases','doctor_id','TEXT REFERENCES users(id) ON DELETE SET NULL');
ensureColumn('cases','review_status',"TEXT NOT NULL DEFAULT 'legacy'");
ensureColumn('cases','reviewed_at','TEXT');
ensureColumn('cases','reviewed_by','TEXT REFERENCES users(id) ON DELETE SET NULL');
ensureColumn('cases','rejection_reason','TEXT');
db.exec(`CREATE TABLE IF NOT EXISTS history_files (
  case_id TEXT PRIMARY KEY REFERENCES cases(id) ON DELETE CASCADE,
  filename TEXT NOT NULL, mime TEXT NOT NULL DEFAULT 'application/pdf',
  bytes BLOB NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS history_review_events (
  id TEXT PRIMARY KEY, case_id TEXT NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
  doctor_id TEXT NOT NULL REFERENCES users(id), decision TEXT NOT NULL,
  reason TEXT, created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_cases_doctor_status ON cases(doctor_id,review_status,created_at);
CREATE INDEX IF NOT EXISTS ix_cases_author_status ON cases(author_id,review_status,created_at);
CREATE INDEX IF NOT EXISTS ix_reviews_doctor ON history_review_events(doctor_id,created_at);`);

const uid = () => crypto.randomUUID();
const now = () => new Date().toISOString();
const str = (v, max = 200) => typeof v === 'string' ? v.trim().slice(0, max) : '';
const validEmail = s => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s) && s.length <= 180;
const validStudentNumber = s => s==='' || /^[A-Za-z0-9\u0660-\u0669\u06f0-\u06f9_\/-]{3,32}$/.test(s);
const hashPw = (pw, salt = crypto.randomBytes(16).toString('hex')) => `${salt}:${crypto.scryptSync(pw, salt, 64).toString('hex')}`;
function verifyPw(pw, record) {
  try {
    const [salt, hash] = record.split(':');
    return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), crypto.scryptSync(pw, salt, 64));
  } catch { return false; }
}
function seed() {
  const groups = [
    ['baghdad', 'طب بغداد - التدريب السريري', 'مساحة مفتوحة لتبادل حالات التدريب السريري بين الطلبة', 'بغداد', '#0f766e'],
    ['kasr', 'طب قصر العيني - الباطنية العامة', 'مناقشة الحالات الداخلية وتطوير مهارات الـ History', 'القصر', '#0284c7'],
    ['emergency', 'نادي الطوارئ والإنعاش السريري', 'تاريخ مرضي للحالات الإسعافية والنقاش العلمي', 'ER', '#dc2626']
  ];
  for (const g of groups) db.prepare('INSERT OR IGNORE INTO groups(id,name,description,initials,color) VALUES(?,?,?,?,?)').run(...g);
  // Preserve any existing cases; never auto-insert fictional histories.

}
seed();

function reply(res,status,data,extra={}) {
  const body=JSON.stringify(data);
  res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store',...extra});
  res.end(body);
}
function err(status,message) { const e=new Error(message);e.status=status;throw e; }
function parseCookie(header='') {
  const match=header.match(/(?:^|;\s*)msh_session=([a-f0-9]{64})(?:;|$)/);
  return match?.[1] || null;
}
function currentUser(req) {
  const token=parseCookie(req.headers.cookie || '');
  if (!token) return null;
  const s=db.prepare(`SELECT u.* FROM sessions s JOIN users u ON u.id=s.user_id
    WHERE s.token_hash=? AND s.expires_at>?`).get(crypto.createHash('sha256').update(token).digest('hex'),now());
  return s || null;
}
const isAdminUser=u=>!!(u && ADMIN_EMAIL && ADMIN_KEY.length>=ADMIN_KEY_MIN_LENGTH && u.email===ADMIN_EMAIL);
const roleOf=u=>isAdminUser(u)?'admin':(u?.role||'student');
const publicUser=u=>u&&({id:u.id,name:u.name,email:u.email,university:u.university,country:u.country,grade:u.grade,studentNumber:u.student_number||'',
  role:roleOf(u),isAdmin:isAdminUser(u)});
function requiredDoctor(req) {const u=requiredUser(req);if(roleOf(u)!=='doctor')err(403,'هذه الصفحة متاحة للدكتور فقط');return u;}
function requiredStudent(req) {const u=requiredUser(req);if(roleOf(u)!=='student')err(403,'إرسال الهستري متاح للطالب فقط');return u;}
function historySummary(c) {
  return {id:c.id,title:c.title,dept:c.dept,studentId:c.author_id,studentName:c.student_name||c.author_name,
    doctorId:c.doctor_id,doctorName:c.doctor_name||'',uploadedAt:c.created_at,status:c.review_status,
    reviewedAt:c.reviewed_at||null,rejectionReason:c.rejection_reason||null,
    hasPdf:!!c.has_pdf,hasNotebook:c.pages_json!=='[]'};
}
const historyFields=`SELECT c.*,d.name AS doctor_name,u.name AS student_name,
  EXISTS(SELECT 1 FROM history_files f WHERE f.case_id=c.id) AS has_pdf
  FROM cases c LEFT JOIN users d ON d.id=c.doctor_id LEFT JOIN users u ON u.id=c.author_id`;
function historyDetail(c){const h=historySummary(c);return {...h,canvasPages:JSON.parse(c.pages_json||'[]')};}
function validPdfData(v) {
  if(v===null||v===undefined||v==='')return null;
  if(typeof v!=='string'||v.length>11_200_000)err(413,'ملف PDF يجب ألا يتجاوز 8MB');
  const m=/^data:application\/pdf;base64,([A-Za-z0-9+/]+={0,2})$/.exec(v);
  if(!m)err(400,'صيغة الملف غير صحيحة؛ استخدم PDF فقط');
  const b=Buffer.from(m[1],'base64');
  if(b.length<8||b.length>8*1024*1024||b.subarray(0,5).toString('ascii')!=='%PDF-')err(400,'الملف ليس PDF صحيحاً أو حجمه كبير');
  return b;
}
function requiredUser(req) {const u=currentUser(req);if(!u)err(401,'يرجى تسجيل الدخول أولاً');return u;}
function sessionCookie(token,req) {
  const secure = process.env.COOKIE_SECURE === 'true' ? '; Secure' : '';
  return `msh_session=${token}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${SESSION_MS/1000}${secure}`;
}
function createSession(res,user,req) {
  const token=crypto.randomBytes(32).toString('hex');
  const hash=crypto.createHash('sha256').update(token).digest('hex');
  db.prepare('INSERT INTO sessions(token_hash,user_id,expires_at) VALUES(?,?,?)').run(hash,user.id,new Date(Date.now()+SESSION_MS).toISOString());
  reply(res,200,{user:publicUser(user)},{'Set-Cookie':sessionCookie(token,req)});
}
function readBody(req) {
  return new Promise((resolve,reject)=>{
    let size=0, chunks=[];
    req.on('data',c=>{size+=c.length;if(size>MAX_BODY){reject(Object.assign(new Error('الطلب كبير جداً'),{status:413})); req.destroy();return;}chunks.push(c);});
    req.on('end',()=>{try{const raw=Buffer.concat(chunks).toString('utf8');resolve(raw?JSON.parse(raw):{});}catch{reject(Object.assign(new Error('صيغة الطلب غير صحيحة'),{status:400}));}});
    req.on('error',reject);
  });
}
function originCheck(req) {
  if (['GET','HEAD','OPTIONS'].includes(req.method)) return;
  // Compare the browser's origin to the actual public hostname being visited.
  // A single APP_ORIGIN can become stale when Railway assigns a new domain.
  const supplied=req.headers.origin || req.headers.referer;
  let source;
  try { source=new URL(supplied).origin; } catch { err(403,'طلب من مصدر غير مسموح به'); }
  const protocol=String(req.headers['x-forwarded-proto'] ||
    (process.env.COOKIE_SECURE==='true'?'https':'http')).split(',')[0].trim();
  const hosts=[req.headers.host,req.headers['x-forwarded-host']];
  const allowed=new Set();
  for(const raw of hosts) {
    if(!raw) continue;
    const h=String(raw).split(',')[0].trim();
    try {allowed.add(new URL(`${protocol}://${h}`).origin);} catch {}
  }
  if(process.env.APP_ORIGIN) {
    try {allowed.add(new URL(process.env.APP_ORIGIN).origin);} catch {}
  }
  // Keep cross-site submissions blocked, even when a previous domain is configured.
  if(!allowed.has(source)) err(403,'طلب من مصدر غير مسموح به');
  if (!(req.headers['content-type'] || '').startsWith('application/json')) err(415,'Content-Type يجب أن يكون application/json');
}
function canView(c,user) {
  if (!c || c.hidden) return false;
  // Doctor accounts are limited to their own academic histories, even when an approved case is public.
  if(user && roleOf(user)==='doctor' && c.doctor_id && c.doctor_id!==user.id)return false;
  if(c.review_status==='pending'||c.review_status==='rejected')return !!user&&c.author_id===user.id;
  if (c.audience==='public') return true;
  if (!user) return false;
  if (c.author_id===user.id) return true;
  return !!db.prepare('SELECT 1 FROM memberships WHERE user_id=? AND group_id=?').get(user.id,c.group_id);
}
function getCase(id,user) {
  const c=db.prepare('SELECT * FROM cases WHERE id=?').get(id);
  if(!canView(c,user))err(404,'الحالة غير موجودة أو غير متاحة');
  return c;
}
function asCase(c,u,detail=false) {
  const likes=db.prepare('SELECT COUNT(*) AS n FROM likes WHERE case_id=?').get(c.id).n;
  const comments=db.prepare('SELECT COUNT(*) AS n FROM comments WHERE case_id=?').get(c.id).n;
  const liked=!!u&&!!db.prepare('SELECT 1 FROM likes WHERE user_id=? AND case_id=?').get(u.id,c.id);
  const saved=!!u&&!!db.prepare('SELECT 1 FROM bookmarks WHERE user_id=? AND case_id=?').get(u.id,c.id);
  const pages=JSON.parse(c.pages_json || '[]');
  const result={id:c.id,title:c.title,dept:c.dept,author:c.author_name,hospital:c.hospital,year:c.year,
    pearl:c.pearl,audience:c.audience,groupId:c.group_id,time:c.created_at,pagesCount:Math.max(pages.length,1),
    canvasPages:detail?pages:(pages[0]?[pages[0]]:[]),examSummary:c.summary_json?JSON.parse(c.summary_json):null,
    likes,isLiked:liked,isSaved:saved,commentsCount:comments,owner:!!u&&c.author_id===u.id,reviewStatus:c.review_status,
    hasPdf:!!db.prepare('SELECT 1 FROM history_files WHERE case_id=?').get(c.id)};
  if(detail) result.comments=db.prepare(`SELECT c.id,c.text,c.created_at as time,u.name as author,c.author_id as authorId
    FROM comments c JOIN users u ON u.id=c.author_id WHERE c.case_id=? ORDER BY c.created_at ASC LIMIT 200`).all(c.id);
  return result;
}
function imageDimensionsOkay(bytes, kind) {
  if(kind==='png') {
    if(bytes.length<24||bytes.subarray(0,8).toString('hex')!=='89504e470d0a1a0a'||bytes.toString('ascii',12,16)!=='IHDR')return false;
    const w=bytes.readUInt32BE(16),h=bytes.readUInt32BE(20);
    return w>0&&h>0&&w<=3000&&h<=3000;
  }
  if(bytes.length<10||bytes[0]!==0xff||bytes[1]!==0xd8)return false;
  let i=2;
  while(i+4<bytes.length){
    if(bytes[i++]!==0xff)return false;
    while(bytes[i]===0xff)i++;
    const marker=bytes[i++];
    if(marker===0xd9||marker===0xda)break;
    if(marker===0x01||(marker>=0xd0&&marker<=0xd7))continue;
    if(i+2>bytes.length)return false;
    const len=bytes.readUInt16BE(i);if(len<2||i+len>bytes.length)return false;
    if([0xc0,0xc1,0xc2,0xc3,0xc5,0xc6,0xc7,0xc9,0xca,0xcb,0xcd,0xce,0xcf].includes(marker)){
      if(len<7)return false;
      const h=bytes.readUInt16BE(i+3),w=bytes.readUInt16BE(i+5);
      return w>0&&h>0&&w<=3000&&h<=3000;
    }
    i+=len;
  }
  return false;
}
function validImageDataUrl(page) {
  if(typeof page!=='string'||page.length>MAX_PAGE)return false;
  const match=/^data:image\/(png|jpeg);base64,([A-Za-z0-9+/]+={0,2})$/.exec(page);
  if(!match)return false;
  const bytes=Buffer.from(match[2],'base64');
  return bytes.length>32&&bytes.length<=1_800_000&&imageDimensionsOkay(bytes,match[1]);
}
function adminAccess(req,u) {
  if(!u||!ADMIN_EMAIL||u.email!==ADMIN_EMAIL)err(403,'هذه الصفحة متاحة للمشرف فقط');
  if(ADMIN_KEY.length<ADMIN_KEY_MIN_LENGTH)err(503,'إعداد الإدارة غير مكتمل: أضف ADMIN_KEY بطول 24 حرفاً على الأقل في Railway');
  const provided=String(req.headers['x-admin-key']||'');
  const actual=Buffer.from(ADMIN_KEY),requested=Buffer.from(provided);
  if(actual.length!==requested.length||!crypto.timingSafeEqual(actual,requested))err(403,'مفتاح المشرف غير صحيح');
  return u;
}
function logModeration(user,caseRow,action){
  db.prepare('INSERT INTO moderation_actions(id,actor_id,case_id,title,action,created_at) VALUES(?,?,?,?,?,?)')
    .run(uid(),user.id,caseRow.id,caseRow.title,action,now());
}

function possibleIdentifier(text) {
  return /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i.test(text) ||
    /(?:\+?964|\+?20|\+?1)[\s-]?\d[\d\s-]{8,}/.test(text) ||
    /(?:^|\D)07[3-9]\d{8}(?:\D|$)/.test(text);
}
function rateLimit(req) {
  const id = req.socket.remoteAddress || 'unknown';
  const t=Date.now(), a=(loginFailures.get(id)||[]).filter(x=>t-x<15*60*1000);
  if(a.length>=12)err(429,'محاولات كثيرة؛ حاول بعد 15 دقيقة');
  a.push(t);loginFailures.set(id,a);
}
function groupsFor(u) {
  return db.prepare(`SELECT g.*, (SELECT COUNT(*) FROM memberships m WHERE m.group_id=g.id) as members,
  (SELECT COUNT(*) FROM cases c WHERE c.group_id=g.id AND c.hidden=0 AND c.review_status IN ('approved','legacy')) as casesCount
  FROM groups g ORDER BY g.name`).all().map(g=>({...g,joined:!!u&&!!db.prepare('SELECT 1 FROM memberships WHERE user_id=? AND group_id=?').get(u.id,g.id)}));
}
async function api(req,res,url) {
  originCheck(req);
  const method=req.method, p=url.pathname, u=currentUser(req);
  if(method==='GET'&&p==='/api/health')return reply(res,200,{ok:true,service:'MedStudentsHub'});
  if(method==='GET'&&p==='/api/me')return reply(res,200,{user:publicUser(u)});
  if(method==='POST'&&p==='/api/register') {
    rateLimit(req);
    const b=await readBody(req), email=str(b.email,180).toLowerCase(), password=b.password, name=str(b.name,80),studentNumber=str(b.studentNumber,32);
    if(!validEmail(email)||name.length<2||typeof password!=='string'||password.length<10||password.length>200)err(400,'أدخل اسماً وبريداً صحيحاً وكلمة مرور من 10 أحرف على الأقل');
    if(!validStudentNumber(studentNumber))err(400,'الرقم الجامعي غير صحيح؛ استخدم أرقاماً أو أحرفاً بحد أقصى 32');
    if(db.prepare('SELECT 1 FROM users WHERE email=?').get(email))err(409,'البريد مستخدم مسبقاً');
    if(studentNumber&&db.prepare('SELECT 1 FROM users WHERE student_number=? AND role=\'student\'').get(studentNumber))err(409,'الرقم الجامعي مستخدم مسبقاً');
    const id=uid();
    db.prepare('INSERT INTO users(id,email,password_hash,name,student_number,created_at) VALUES(?,?,?,?,?,?)').run(id,email,hashPw(password),name,studentNumber,now());
    return createSession(res,db.prepare('SELECT * FROM users WHERE id=?').get(id),req);
  }
  // Faculty account self-registration. Only holders of the private faculty invite
  // may gain the doctor role; otherwise a student could approve their own work.
  if(method==='POST'&&p==='/api/doctor/register') {
    rateLimit(req);
    if(DOCTOR_INVITE_CODE.length<DOCTOR_INVITE_MIN_LENGTH)
      err(503,'تسجيل الدكاترة غير مفعّل حالياً؛ على الإدارة ضبط DOCTOR_INVITE_CODE في Railway');
    const b=await readBody(req),name=str(b.name,80),email=str(b.email,180).toLowerCase(),password=b.password;
    const received=typeof b.inviteCode==='string'?b.inviteCode:'';
    const expected=Buffer.from(DOCTOR_INVITE_CODE,'utf8'),entered=Buffer.from(received,'utf8');
    if(expected.length!==entered.length||!crypto.timingSafeEqual(expected,entered))
      err(403,'رمز دعوة الدكتور غير صحيح؛ تواصل مع إدارة المنصة');
    if(name.length<2||!validEmail(email)||typeof password!=='string'||password.length<12||password.length>200)
      err(400,'أدخل اسم الدكتور وبريداً صحيحاً وكلمة مرور من 12 حرفاً على الأقل');
    if(db.prepare('SELECT 1 FROM users WHERE email=?').get(email))
      err(409,'هذا البريد مسجل مسبقاً؛ سجّل الدخول بحسابك أو اطلب من الإدارة المساعدة');
    const id=uid();
    db.prepare("INSERT INTO users(id,email,password_hash,name,role,created_at) VALUES(?,?,?,?,?,?)")
      .run(id,email,hashPw(password),name,'doctor',now());
    // The account is instantly available in /api/doctors and the reviewer dashboard.
    return createSession(res,db.prepare('SELECT * FROM users WHERE id=?').get(id),req);
  }
  if(method==='POST'&&p==='/api/login') {
    rateLimit(req);
    const b=await readBody(req), email=str(b.email,180).toLowerCase();
    const user=db.prepare('SELECT * FROM users WHERE email=?').get(email);
    if(!user||typeof b.password!=='string'||!verifyPw(b.password,user.password_hash))err(401,'البريد أو كلمة المرور غير صحيحة');
    return createSession(res,user,req);
  }
  if(method==='POST'&&p==='/api/logout') {
    const token=parseCookie(req.headers.cookie||'');
    if(token)db.prepare('DELETE FROM sessions WHERE token_hash=?').run(crypto.createHash('sha256').update(token).digest('hex'));
    return reply(res,200,{ok:true},{'Set-Cookie':'msh_session=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0'});
  }
  if(method==='PUT'&&p==='/api/profile') {
    const user=requiredUser(req),b=await readBody(req), name=str(b.name,80);
    if(name.length<2)err(400,'الاسم قصير جداً');
    const studentNumber=roleOf(user)==='student'?str(b.studentNumber??user.student_number,32):'';
    if(!validStudentNumber(studentNumber))err(400,'الرقم الجامعي غير صحيح؛ استخدم أرقاماً أو أحرفاً بحد أقصى 32');
    if(studentNumber&&db.prepare('SELECT 1 FROM users WHERE student_number=? AND role=\'student\' AND id<>?').get(studentNumber,user.id))err(409,'الرقم الجامعي مستخدم مسبقاً');
    db.prepare('UPDATE users SET name=?,university=?,country=?,grade=?,student_number=? WHERE id=?').run(name,str(b.university,120),str(b.country,60),str(b.grade,100),studentNumber,user.id);
    return reply(res,200,{user:publicUser(db.prepare('SELECT * FROM users WHERE id=?').get(user.id))});
  }
  // Allow each user (including doctors) to rotate their own initial password.
  if(method==='POST'&&p==='/api/change-password'){
    const user=requiredUser(req),b=await readBody(req);
    if(typeof b.currentPassword!=='string'||!verifyPw(b.currentPassword,user.password_hash))err(403,'كلمة المرور الحالية غير صحيحة');
    if(typeof b.newPassword!=='string'||b.newPassword.length<12||b.newPassword.length>200)err(400,'كلمة المرور الجديدة يجب أن تكون من 12 حرفاً على الأقل');
    if(b.currentPassword===b.newPassword)err(400,'اختر كلمة مرور مختلفة عن القديمة');
    db.prepare('UPDATE users SET password_hash=? WHERE id=?').run(hashPw(b.newPassword),user.id);
    // Revoke other sessions after password rotation; preserve this browser's session.
    const token=parseCookie(req.headers.cookie||'');
    const thisHash=token?crypto.createHash('sha256').update(token).digest('hex'):'';
    db.prepare('DELETE FROM sessions WHERE user_id=? AND token_hash<>?').run(user.id,thisHash);
    return reply(res,200,{ok:true});
  }
  if(method==='GET'&&p==='/api/groups')return reply(res,200,{groups:groupsFor(u)});
  if(method==='POST'&&p==='/api/groups'){
    const user=requiredUser(req),b=await readBody(req),name=str(b.name,65),description=str(b.description,180);
    if(name.length<5||description.length<10||possibleIdentifier(name+' '+description))err(400,'اكتب اسماً ووصفاً مناسبين بدون بيانات شخصية');
    if(db.prepare('SELECT COUNT(*) AS n FROM groups WHERE created_by=?').get(user.id).n>=4)err(429,'يمكنك إنشاء 4 مجموعات كحد أقصى');
    const id=uid();
    db.prepare('INSERT INTO groups(id,name,description,initials,color,created_by) VALUES(?,?,?,?,?,?)').run(id,name,description,name.slice(0,5),'#0f766e',user.id);
    db.prepare('INSERT INTO memberships(user_id,group_id) VALUES(?,?)').run(user.id,id);
    return reply(res,201,{group:groupsFor(user).find(g=>g.id===id)});
  }
  const join=p.match(/^\/api\/groups\/([a-z0-9-]+)\/(join|leave)$/);
  if(method==='POST'&&join){
    const user=requiredUser(req),id=join[1];
    if(!db.prepare('SELECT 1 FROM groups WHERE id=?').get(id))err(404,'المجموعة غير موجودة');
    if(join[2]==='join') db.prepare('INSERT OR IGNORE INTO memberships(user_id,group_id) VALUES(?,?)').run(user.id,id);
    else db.prepare('DELETE FROM memberships WHERE user_id=? AND group_id=?').run(user.id,id);
    return reply(res,200,{ok:true});
  }
  // The publicly listed doctors are real activated accounts, never hardcoded options.
  if(method==='GET'&&p==='/api/doctors') {
    requiredUser(req);
    return reply(res,200,{doctors:db.prepare("SELECT id,name FROM users WHERE role='doctor' ORDER BY name COLLATE NOCASE").all()});
  }
  if(method==='GET'&&p==='/api/student/histories'){
    const student=requiredStudent(req);
    const histories=db.prepare(`${historyFields} WHERE c.author_id=? AND c.review_status IN ('pending','approved','rejected') ORDER BY c.created_at DESC`).all(student.id).map(historySummary);
    return reply(res,200,{histories,stats:{total:histories.length,approved:histories.filter(h=>h.status==='approved').length,
      rejected:histories.filter(h=>h.status==='rejected').length,pending:histories.filter(h=>h.status==='pending').length}});
  }
  const studentHistory=p.match(/^\/api\/student\/histories\/([a-f0-9-]{36})$/);
  if(method==='GET'&&studentHistory){
    const student=requiredStudent(req);
    const c=db.prepare(`${historyFields} WHERE c.id=? AND c.author_id=? AND c.review_status!='legacy'`).get(studentHistory[1],student.id);
    if(!c)err(404,'الهستري غير موجود');
    return reply(res,200,{history:historyDetail(c)});
  }
  if(method==='GET'&&p==='/api/doctor/histories'){
    const doctor=requiredDoctor(req);
    const histories=db.prepare(`${historyFields} WHERE c.doctor_id=? AND c.review_status!='legacy' ORDER BY CASE c.review_status WHEN 'pending' THEN 0 ELSE 1 END,c.created_at DESC`).all(doctor.id).map(historySummary);
    return reply(res,200,{histories,stats:{pending:histories.filter(h=>h.status==='pending').length,
      reviewed:histories.filter(h=>h.status!=='pending').length,approved:histories.filter(h=>h.status==='approved').length,
      rejected:histories.filter(h=>h.status==='rejected').length}});
  }
  const doctorHistory=p.match(/^\/api\/doctor\/histories\/([a-f0-9-]{36})(?:\/(review))?$/);
  if(doctorHistory){
    const doctor=requiredDoctor(req),id=doctorHistory[1];
    const c=db.prepare(`${historyFields} WHERE c.id=? AND c.doctor_id=? AND c.review_status!='legacy'`).get(id,doctor.id);
    if(!c)err(404,'الهستري غير موجود أو غير مخصص لك');
    if(method==='GET'&&!doctorHistory[2])return reply(res,200,{history:historyDetail(c)});
    if(method==='POST'&&doctorHistory[2]==='review'){
      const b=await readBody(req),decision=b.decision,reason=str(b.reason,1200);
      if(!['approved','rejected'].includes(decision))err(400,'القرار غير صحيح');
      if(decision==='rejected'&&reason.length<5)err(400,'يجب كتابة سبب الرفض (5 أحرف على الأقل)');
      if(c.review_status!=='pending')err(409,'تمت مراجعة هذا الهستري سابقاً');
      db.exec('BEGIN IMMEDIATE');
      try {
        const r=db.prepare(`UPDATE cases SET review_status=?,rejection_reason=?,reviewed_at=?,reviewed_by=?
          WHERE id=? AND doctor_id=? AND review_status='pending'`).run(decision,decision==='rejected'?reason:null,now(),doctor.id,id,doctor.id);
        if(r.changes!==1)err(409,'تمت مراجعة هذا الهستري سابقاً');
        db.prepare('INSERT INTO history_review_events(id,case_id,doctor_id,decision,reason,created_at) VALUES(?,?,?,?,?,?)')
          .run(uid(),id,doctor.id,decision,decision==='rejected'?reason:null,now());
        db.exec('COMMIT');
      }catch(e){db.exec('ROLLBACK');throw e;}
      return reply(res,200,{ok:true,status:decision});
    }
  }
  const fileMatch=p.match(/^\/api\/histories\/([a-f0-9-]{36})\/file$/);
  if(method==='GET'&&fileMatch){
    const viewer=requiredUser(req),id=fileMatch[1];
    const row=db.prepare('SELECT * FROM cases WHERE id=?').get(id);
    if(!row||row.review_status==='legacy')err(404,'الملف غير موجود');
    if(roleOf(viewer)==='doctor'&&row.doctor_id!==viewer.id)err(403,'لا يمكنك فتح ملفات دكتور آخر');
    if(viewer.id!==row.author_id&&viewer.id!==row.doctor_id && !(row.review_status==='approved'&&canView(row,viewer))){adminAccess(req,viewer);}
    const f=db.prepare('SELECT bytes FROM history_files WHERE case_id=?').get(id);
    if(!f)err(404,'لا يوجد PDF لهذه الحالة');
    res.writeHead(200,{'Content-Type':'application/pdf','Content-Disposition':'attachment; filename="Clinical_History.pdf"',
      'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff','Content-Length':f.bytes.length});
    return res.end(f.bytes);
  }
  // Academic oversight extends the original admin moderation dashboard.
  if(method==='GET'&&p==='/api/admin/students'){
    adminAccess(req,u);
    const term=str(url.searchParams.get('search'),100).toLowerCase();
    const rows=db.prepare(`SELECT u.id,u.name,u.email,u.student_number AS studentNumber,u.university,u.grade,
      COUNT(c.id) total, COALESCE(SUM(CASE WHEN c.review_status='approved' THEN 1 ELSE 0 END),0) approved,
      COALESCE(SUM(CASE WHEN c.review_status='rejected' THEN 1 ELSE 0 END),0) rejected,
      COALESCE(SUM(CASE WHEN c.review_status='pending' THEN 1 ELSE 0 END),0) pending
      FROM users u LEFT JOIN cases c ON c.author_id=u.id AND c.doctor_id IS NOT NULL
      WHERE u.role='student' AND u.email<>? GROUP BY u.id ORDER BY u.name COLLATE NOCASE`).all(ADMIN_EMAIL);
    return reply(res,200,{students:rows.filter(r=>!term||[r.name,r.email,r.id,r.studentNumber].join(' ').toLowerCase().includes(term))});
  }
  if(method==='GET'&&p==='/api/admin/doctors'){
    adminAccess(req,u);
    return reply(res,200,{doctors:db.prepare(`SELECT u.id,u.name,u.email,
      COUNT(c.id) total,COALESCE(SUM(CASE WHEN c.review_status IN ('approved','rejected') THEN 1 ELSE 0 END),0) reviewed,
      COALESCE(SUM(CASE WHEN c.review_status='pending' THEN 1 ELSE 0 END),0) pending
      FROM users u LEFT JOIN cases c ON c.doctor_id=u.id WHERE u.role='doctor'
      GROUP BY u.id ORDER BY u.name COLLATE NOCASE`).all()});
  }
  if(method==='POST'&&p==='/api/admin/doctors'){
    adminAccess(req,u);
    const b=await readBody(req),name=str(b.name,80),email=str(b.email,180).toLowerCase(),password=b.password;
    if(name.length<2||!validEmail(email)||typeof password!=='string'||password.length<12||password.length>200)err(400,'أدخل الاسم والبريد وكلمة مرور مؤقتة من 12 حرفاً على الأقل');
    if(db.prepare('SELECT 1 FROM users WHERE email=?').get(email))err(409,'البريد مستخدم مسبقاً');
    const id=uid();
    db.prepare("INSERT INTO users(id,email,password_hash,name,role,created_at) VALUES(?,?,?,?,?,?)")
      .run(id,email,hashPw(password),name,'doctor',now());
    return reply(res,201,{doctor:{id,name,email}});
  }
  const adminStudent=p.match(/^\/api\/admin\/students\/([a-f0-9-]{36})\/histories$/);
  if(method==='GET'&&adminStudent){
    adminAccess(req,u);
    const student=db.prepare("SELECT id,name,email,student_number AS studentNumber FROM users WHERE id=? AND role='student'").get(adminStudent[1]);
    if(!student)err(404,'الطالب غير موجود');
    const histories=db.prepare(`${historyFields} WHERE c.author_id=? AND c.doctor_id IS NOT NULL ORDER BY c.created_at DESC`).all(student.id).map(historySummary);
    return reply(res,200,{student,histories});
  }
  const adminHistory=p.match(/^\/api\/admin\/histories\/([a-f0-9-]{36})$/);
  if(method==='GET'&&adminHistory){
    adminAccess(req,u);
    const c=db.prepare(`${historyFields} WHERE c.id=? AND c.doctor_id IS NOT NULL`).get(adminHistory[1]);
    if(!c)err(404,'الهستري غير موجود');
    return reply(res,200,{history:historyDetail(c)});
  }
  if(method==='GET'&&p==='/api/cases') {
    const dept=str(url.searchParams.get('dept'),30), search=str(url.searchParams.get('search'),100).toLowerCase(),
      onlySaved=url.searchParams.get('saved')==='1',groupId=str(url.searchParams.get('group'),40);
    if(onlySaved&&!u)return reply(res,200,{cases:[]});
    const all=db.prepare("SELECT * FROM cases WHERE hidden=0 AND review_status IN ('approved','legacy') ORDER BY created_at DESC LIMIT 300").all();
    let out=all.filter(c=>canView(c,u)&&(!dept||dept==='all'||c.dept===dept)
      &&(!groupId||c.group_id===groupId)&&(!search||[c.title,c.pearl,c.hospital,c.dept].join(' ').toLowerCase().includes(search))
      &&(!onlySaved||db.prepare('SELECT 1 FROM bookmarks WHERE user_id=? AND case_id=?').get(u.id,c.id)));
    return reply(res,200,{cases:out.slice(0,100).map(c=>asCase(c,u))});
  }
  if(method==='POST'&&p==='/api/cases') {
    const user=requiredStudent(req),b=await readBody(req),title=str(b.title,160),dept=str(b.dept,30),
      hospital=str(b.hospital,120),pearl=str(b.pearl,1200),year=str(b.year,70),audience=b.audience==='group'?'group':'public',
      groupId=audience==='group'?str(b.groupId,40):null,doctorId=str(b.doctorId,40);
    if(title.length<5||!DEPTS.has(dept)||b.privacyAgree!==true)err(400,'أكمل عنوان الحالة والتخصص وتأكيد إخفاء الهوية');
    if(!db.prepare("SELECT 1 FROM users WHERE id=? AND role='doctor'").get(doctorId))err(400,'اختيار الدكتور المسجل مطلوب قبل إرسال الهستري');
    if(possibleIdentifier([title,hospital,pearl].join(' ')))err(400,'تم اكتشاف بريد أو رقم هاتف محتمل. احذف بيانات التعريف قبل النشر');
    if(audience==='group'&&(!groupId||!db.prepare('SELECT 1 FROM memberships WHERE user_id=? AND group_id=?').get(user.id,groupId)))err(403,'يجب الانضمام إلى المجموعة قبل النشر فيها');
    const pages=b.canvasPages;
    if(!Array.isArray(pages)||pages.length>MAX_PAGES||pages.some(page=>!validImageDataUrl(page)))err(400,'حجم صفحات الكتابة كبير أو الصورة غير صالحة؛ جرّب تقليل عدد الصفحات (1–6)');
    const pdf=validPdfData(b.pdfData||null);
    if(!pages.length&&!pdf)err(400,'ارفع ملف PDF أو اكتب الهستري في دفتر الكتابة');
    const id=uid();
    db.exec('BEGIN IMMEDIATE');
    try {
      db.prepare(`INSERT INTO cases(id,author_id,author_name,title,dept,hospital,year,pearl,audience,group_id,pages_json,created_at,doctor_id,review_status)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(id,user.id,user.name,title,dept,hospital||user.university,year,pearl,audience,groupId,JSON.stringify(pages),now(),doctorId,'pending');
      if(pdf)db.prepare('INSERT INTO history_files(case_id,filename,mime,bytes,created_at) VALUES(?,?,?,?,?)')
        .run(id,'Clinical_History.pdf','application/pdf',pdf,now());
      db.exec('COMMIT');
    }catch(e){db.exec('ROLLBACK');throw e;}
    return reply(res,201,{case:asCase(getCase(id,user),user,true),status:'pending'});
  }
  const m=p.match(/^\/api\/cases\/([a-f0-9-]{36})(?:\/(like|bookmark|comments|report))?$/);
  if(m) {
    const id=m[1],sub=m[2],c=getCase(id,u);
    if(method==='GET'&&!sub)return reply(res,200,{case:asCase(c,u,true)});
    if(method==='DELETE'&&!sub){
      const user=requiredUser(req);
      if(c.author_id!==user.id)err(403,'يمكنك حذف حالاتك فقط');
      if(c.review_status!=='legacy')err(403,'سجل الهستري المرسل للمراجعة لا يمكن حذفه من الطالب');
      db.prepare('DELETE FROM cases WHERE id=?').run(id);
      return reply(res,200,{ok:true});
    }
    if(method==='POST'&&(sub==='like'||sub==='bookmark')){
      const user=requiredUser(req),table=sub==='like'?'likes':'bookmarks';
      const current=db.prepare(`SELECT 1 FROM ${table} WHERE user_id=? AND case_id=?`).get(user.id,id);
      if(current)db.prepare(`DELETE FROM ${table} WHERE user_id=? AND case_id=?`).run(user.id,id);
      else db.prepare(`INSERT INTO ${table}(user_id,case_id) VALUES(?,?)`).run(user.id,id);
      return reply(res,200,{active:!current});
    }
    if(method==='POST'&&sub==='comments'){
      const user=requiredUser(req),b=await readBody(req),comment=str(b.text,1500);
      if(comment.length<2||possibleIdentifier(comment))err(400,'اكتب تعليقاً مناسباً بدون بيانات تعريف شخصية');
      db.prepare('INSERT INTO comments(id,case_id,author_id,text,created_at) VALUES(?,?,?,?,?)').run(uid(),id,user.id,comment,now());
      return reply(res,201,{case:asCase(c,user,true)});
    }
    if(method==='POST'&&sub==='report'){
      const user=requiredUser(req),b=await readBody(req),reason=str(b.reason,300);
      if(reason.length<5)err(400,'وضح سبب الإبلاغ');
      db.prepare('INSERT OR IGNORE INTO reports(id,user_id,case_id,reason,created_at) VALUES(?,?,?,?,?)').run(uid(),user.id,id,reason,now());
      return reply(res,200,{ok:true});
    }
  }
  // Administrator actions require BOTH a signed-in account with ADMIN_EMAIL
  // and a separate long ADMIN_KEY (not exposed or persisted by the browser).
  if(method==='GET'&&p==='/api/admin/cases'){
    adminAccess(req,u);
    const search=str(url.searchParams.get('search'),100).toLowerCase();
    const status=str(url.searchParams.get('status'),20);
    const rows=db.prepare(`SELECT c.id,c.title,c.dept,c.author_name,c.hospital,c.year,
      c.audience,c.group_id,c.created_at,c.hidden,c.review_status,
      (SELECT COUNT(*) FROM reports r WHERE r.case_id=c.id) AS reports_count
      FROM cases c ORDER BY c.created_at DESC LIMIT 1000`).all();
    const filtered=rows.filter(c=>(status!=='visible'&&status!=='hidden'||(status==='hidden')===!!c.hidden)
      &&(!search||[c.title,c.dept,c.author_name,c.hospital].join(' ').toLowerCase().includes(search)));
    return reply(res,200,{cases:filtered.slice(0,500),total:rows.length,
      hiddenCount:rows.filter(c=>c.hidden).length,reportCount:db.prepare('SELECT COUNT(*) AS n FROM reports').get().n});
  }
  if(method==='GET'&&p==='/api/admin/reports'){
    adminAccess(req,u);
    return reply(res,200,{reports:db.prepare(`SELECT r.*,c.title,c.hidden,u.email AS reporter_email FROM reports r
      JOIN cases c ON c.id=r.case_id JOIN users u ON u.id=r.user_id
      ORDER BY r.created_at DESC LIMIT 200`).all()});
  }
  const moderation=p.match(/^\/api\/admin\/cases\/([a-f0-9-]{36})(?:\/(hide|restore))?$/);
  if(moderation){
    const adminUser=adminAccess(req,u);
    const [,id,action]=moderation;
    const item=db.prepare('SELECT * FROM cases WHERE id=?').get(id);
    if(!item)err(404,'الحالة غير موجودة');
    if(method==='POST'&&(action==='hide'||action==='restore')){
      db.prepare('UPDATE cases SET hidden=? WHERE id=?').run(action==='hide'?1:0,id);
      logModeration(adminUser,item,action);
      return reply(res,200,{ok:true});
    }
    if(method==='DELETE'&&!action){
      if(item.review_status!=='legacy')err(403,'لا يمكن حذف سجل أكاديمي من نظام مراجعة الهستريات');
      logModeration(adminUser,item,'delete');
      db.prepare('DELETE FROM cases WHERE id=?').run(id);
      return reply(res,200,{ok:true});
    }
  }
  err(404,'المسار غير موجود');
}

const staticMap={'/':'index.html','/index.html':'index.html','/css/style.css':'style.css','/js/app.js':'app.js','/admin.html':'admin.html','/js/admin.js':'admin.js','/student.html':'student.html','/doctor.html':'doctor.html','/css/portal.css':'portal.css','/js/portal.js':'portal.js'};
const mime={'.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.js':'text/javascript; charset=utf-8'};
const server=http.createServer(async(req,res)=>{
  res.setHeader('X-Content-Type-Options','nosniff');
  res.setHeader('Referrer-Policy','strict-origin-when-cross-origin');
  res.setHeader('X-Frame-Options','DENY');
  res.setHeader('Permissions-Policy','camera=(), microphone=(), geolocation=()');
  res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self' https://unpkg.com; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data: https://images.unsplash.com; connect-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'");
  try {
    const url=new URL(req.url,'http://localhost');
    if(url.pathname.startsWith('/api/'))return await api(req,res,url);
    if(!['GET','HEAD'].includes(req.method))err(405,'طريقة طلب غير مدعومة');
    const file=staticMap[url.pathname];
    if(!file)err(404,'الصفحة غير موجودة');
    res.writeHead(200,{'Content-Type':mime[path.extname(file)],'Cache-Control':'no-cache'});
    if(req.method==='HEAD')return res.end();
    fs.createReadStream(path.join(ROOT,file)).pipe(res);
  }catch(e){
    if(!res.headersSent)reply(res,e.status||500,{error:e.status?e.message:'حدث خطأ داخلي في الخادم'});
    else res.end();
    if(!e.status)console.error(e);
  }
});
if(require.main===module)server.listen(PORT,'0.0.0.0',()=>console.log(`MedStudentsHub ready: http://localhost:${PORT}`));
module.exports={server,db};
