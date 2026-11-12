'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const net = require('node:net');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');

const ROOT = path.join(__dirname, '..');
const KEY = 'academic-test-secret-' + 'x'.repeat(30);
const ADMIN_EMAIL = 'academic.admin@example.invalid';
const PDF = 'data:application/pdf;base64,' + Buffer.from('%PDF-1.4\n1 0 obj\n<<>>\nendobj\n%%EOF\n').toString('base64');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}
async function serverStart(dataDir) {
  const port = await freePort();
  const origin = `http://127.0.0.1:${port}`;
  const errors = [];
  const proc = spawn(process.execPath, ['server.js'], {
    cwd: ROOT, env: {...process.env, PORT: String(port), DATA_DIR: dataDir,
      APP_ORIGIN: origin, COOKIE_SECURE: 'false', ADMIN_EMAIL, ADMIN_KEY: KEY}, stdio: ['ignore','pipe','pipe']
  });
  proc.stderr.on('data', chunk => errors.push(String(chunk)));
  let ready = false;
  for(let n=0; n<110; n++) {
    if(proc.exitCode !== null) break;
    try { const r=await fetch(origin+'/api/health'); if(r.status === 200) {ready=true;break;} } catch {}
    await delay(45);
  }
  if(!ready) {proc.kill(); throw Error('Server failed to start:\n'+errors.join('').slice(-3000));}
  return {proc, origin, errors};
}
async function serverStop(proc) {
  if(proc.exitCode !== null) return;
  proc.kill('SIGTERM');
  await Promise.race([new Promise(resolve => proc.once('exit',resolve)),delay(2500)]);
  if(proc.exitCode === null)proc.kill('SIGKILL');
}
function client(origin) {
  let cookie = '';
  return {
    async req(route,method='GET',data,admin=false) {
      const headers = {};
      if(cookie)headers.Cookie=cookie;
      if(method!=='GET') {headers.Origin=origin;headers['Content-Type']='application/json';}
      if(admin)headers['X-Admin-Key']=KEY;
      const r=await fetch(origin+route,{method,headers,body:data===undefined?undefined:JSON.stringify(data)});
      const set=r.headers.get('set-cookie');
      if(set)cookie=set.split(';')[0];
      const contentType=r.headers.get('content-type')||'';
      const value=contentType.includes('application/json')?await r.json():Buffer.from(await r.arrayBuffer());
      return {status:r.status,data:value};
    }
  };
}
async function register(c,email,name,studentNumber='') {
  const r=await c.req('/api/register','POST',{email,name,password:'absolutelyStrongPassword123',studentNumber});
  assert.equal(r.status,200,`registration ${email}: ${JSON.stringify(r.data)}`);
  return r.data.user;
}
async function login(c,email,password) {
  const r=await c.req('/api/login','POST',{email,password});
  assert.equal(r.status,200,`login ${email}: ${JSON.stringify(r.data)}`);
  return r.data.user;
}

// All test users, PDFs and cases are created in a temporary offline SQLite database.
test('Three portals: registration, allocation, approvals, numbers, stats and isolation',async t => {
  const folder=fs.mkdtempSync(path.join(os.tmpdir(),'medhub-e2e-'));
  const {proc,origin}=await serverStart(folder);
  t.after(async()=>{await serverStop(proc);fs.rmSync(folder,{recursive:true,force:true});});
  const admin=client(origin),student=client(origin),other=client(origin),doctorA=client(origin),doctorB=client(origin),guest=client(origin);
  await register(admin,ADMIN_EMAIL,'Faculty Admin');
  const stu = await register(student,'s1@example.invalid','Student One','2026-A01');
  await register(other,'s2@example.invalid','Student Two','2026-A02');
  assert.equal((await other.req('/api/register','POST',{email:'s3@example.invalid',name:'Student Three',password:'strong-password-123',studentNumber:'2026-A01'})).status,409);
  assert.equal((await student.req('/api/me')).data.user.studentNumber,'2026-A01');
  assert.equal((await student.req('/api/profile','PUT',{name:'Student One',university:'Faculty of Medicine',studentNumber:'2026-NEW'})).status,200);
  assert.equal((await other.req('/api/profile','PUT',{name:'Student Two',studentNumber:'2026-NEW'})).status,409);

  assert.equal((await guest.req('/api/admin/students')).status,403);
  const rA=await admin.req('/api/admin/doctors','POST',{name:'Dr. Ahmed',email:'d-a@example.invalid',password:'doctorstrongpassword!'},true);
  const rB=await admin.req('/api/admin/doctors','POST',{name:'Dr. Basim',email:'d-b@example.invalid',password:'doctorstrongpassword!'},true);
  assert.equal(rA.status,201);assert.equal(rB.status,201);
  const doctorIdA=rA.data.doctor.id,doctorIdB=rB.data.doctor.id;
  await login(doctorA,'d-a@example.invalid','doctorstrongpassword!');
  await login(doctorB,'d-b@example.invalid','doctorstrongpassword!');
  assert.equal((await doctorA.req('/api/change-password','POST',{currentPassword:'wrong',newPassword:'mynewdoctorpassword!'})).status,403);
  assert.equal((await doctorA.req('/api/change-password','POST',{currentPassword:'doctorstrongpassword!',newPassword:'mynewdoctorpassword!'})).status,200);
  assert.equal((await client(origin).req('/api/login','POST',{email:'d-a@example.invalid',password:'doctorstrongpassword!'})).status,401);
  await login(client(origin),'d-a@example.invalid','mynewdoctorpassword!');
  assert.equal((await doctorA.req('/api/cases','POST',{title:'Not allowed',dept:'باطنية',doctorId:doctorIdA,privacyAgree:true,canvasPages:[],pdfData:PDF})).status,403);
  assert.equal((await admin.req('/api/cases','POST',{title:'Admin not student',dept:'باطنية',doctorId:doctorIdA,privacyAgree:true,canvasPages:[],pdfData:PDF})).status,403);
  assert.equal((await student.req('/api/cases','POST',{title:'Missing doctor',dept:'باطنية',privacyAgree:true,canvasPages:[],pdfData:PDF})).status,400);
  assert.equal((await student.req('/api/cases','POST',{title:'Fake doctor',dept:'باطنية',doctorId:'nonsense',privacyAgree:true,canvasPages:[],pdfData:PDF})).status,400);
  const create=async(title,doctorId)=>student.req('/api/cases','POST',{title,dept:'باطنية',doctorId,privacyAgree:true,canvasPages:[],pdfData:PDF,audience:'public'});
  const p1=await create('Test History 1',doctorIdA);assert.equal(p1.status,201);
  const id1=p1.data.case.id;
  const p2=await create('Test History 2',doctorIdB);assert.equal(p2.status,201);
  const id2=p2.data.case.id;
  const p3=await create('Test History 3',doctorIdA);assert.equal(p3.status,201);
  const id3=p3.data.case.id;
  assert.equal((await guest.req('/api/cases')).data.cases.length,0);
  assert.equal((await guest.req(`/api/cases/${id1}`)).status,404);
  assert.equal((await doctorB.req(`/api/cases/${id1}`)).status,404);
  assert.equal((await other.req(`/api/cases/${id1}`)).status,404);
  assert.equal((await other.req(`/api/student/histories/${id1}`)).status,404);
  assert.equal((await other.req(`/api/histories/${id1}/file`)).status,403);
  assert.equal((await doctorB.req(`/api/histories/${id1}/file`)).status,403);
  assert.equal((await doctorB.req(`/api/doctor/histories/${id1}`)).status,404);
  assert.equal((await doctorB.req(`/api/doctor/histories/${id1}/review`,'POST',{decision:'approved'})).status,404);
  assert.equal((await doctorA.req(`/api/doctor/histories/${id1}/review`,'POST',{decision:'rejected'})).status,400);
  assert.equal((await doctorA.req(`/api/doctor/histories/${id1}/review`,'POST',{decision:'approved'})).status,200);
  assert.equal((await doctorA.req(`/api/doctor/histories/${id1}/review`,'POST',{decision:'rejected',reason:'Late correction'})).status,409);
  assert.equal((await doctorB.req(`/api/cases/${id1}`)).status,404,'doctor B must not view doctor A even after approval');
  assert.equal((await doctorB.req(`/api/histories/${id1}/file`)).status,403);
  assert.equal((await guest.req(`/api/cases/${id1}`)).status,200,'approved public history visible to learners');
  assert.equal((await student.req(`/api/histories/${id1}/file`)).status,200);
  assert.equal((await doctorB.req(`/api/doctor/histories/${id2}/review`,'POST',{decision:'rejected',reason:'HPI is incomplete'})).status,200);
  assert.equal((await doctorA.req(`/api/doctor/histories/${id2}`)).status,404);
  assert.equal((await doctorA.req(`/api/doctor/histories/${id3}/review`,'POST',{decision:'approved'})).status,200);
  const statuses=(await student.req('/api/student/histories')).data.stats;
  assert.deepEqual(statuses,{total:3,approved:2,rejected:1,pending:0});
  assert.equal((await guest.req('/api/cases')).data.cases.length,2);
  assert.equal((await guest.req(`/api/cases/${id2}`)).status,404);
  assert.equal((await student.req(`/api/cases/${id1}`,'DELETE')).status,403);
  const adminStudent=(await admin.req('/api/admin/students?search=2026-NEW','GET',undefined,true)).data.students;
  assert.equal(adminStudent.length,1);assert.equal(adminStudent[0].id,stu.id);
  assert.deepEqual([adminStudent[0].total,adminStudent[0].approved,adminStudent[0].rejected,adminStudent[0].pending],[3,2,1,0]);
  const doctors=(await admin.req('/api/admin/doctors','GET',undefined,true)).data.doctors;
  assert.equal(doctors.find(d=>d.id===doctorIdA).reviewed,2);
  assert.equal(doctors.find(d=>d.id===doctorIdB).reviewed,1);
  assert.equal((await admin.req(`/api/admin/histories/${id2}`,'GET',undefined,true)).status,200);
  assert.equal((await student.req('/api/admin/students','GET',undefined,true)).status,403);
  assert.equal((await doctorA.req('/api/student/histories')).status,403);
  const db = new DatabaseSync(path.join(folder,'medstudentshub.sqlite'));
  assert.equal(db.prepare('SELECT COUNT(*) n FROM history_review_events').get().n,3);
  db.close();
  for(const endpoint of ['/','/index.html','/admin.html','/student.html','/doctor.html','/css/portal.css','/js/portal.js','/js/app.js','/css/style.css'])assert.equal((await guest.req(endpoint)).status,200);
});

test('Additive migration preserves real older schema rows and is idempotent after restart',async t=>{
  const folder=fs.mkdtempSync(path.join(os.tmpdir(),'medhub-legacy-'));
  t.after(()=>fs.rmSync(folder,{recursive:true,force:true}));
  const dbfile=path.join(folder,'medstudentshub.sqlite');
  const db=new DatabaseSync(dbfile);
  // Minimal historical schema faithfully uses original column names and constraints.
  db.exec(`PRAGMA foreign_keys=ON;
    CREATE TABLE users (id TEXT PRIMARY KEY,email TEXT NOT NULL UNIQUE,password_hash TEXT NOT NULL,name TEXT NOT NULL,
      university TEXT NOT NULL DEFAULT '',country TEXT NOT NULL DEFAULT '',grade TEXT NOT NULL DEFAULT '',created_at TEXT NOT NULL);
    CREATE TABLE groups (id TEXT PRIMARY KEY,name TEXT NOT NULL,description TEXT NOT NULL,initials TEXT NOT NULL,color TEXT NOT NULL,created_by TEXT REFERENCES users(id));
    CREATE TABLE cases (id TEXT PRIMARY KEY,author_id TEXT REFERENCES users(id) ON DELETE SET NULL,author_name TEXT NOT NULL,
      title TEXT NOT NULL,dept TEXT NOT NULL,hospital TEXT NOT NULL,year TEXT NOT NULL DEFAULT '',pearl TEXT NOT NULL,
      audience TEXT NOT NULL DEFAULT 'public',group_id TEXT REFERENCES groups(id) ON DELETE SET NULL,
      pages_json TEXT NOT NULL DEFAULT '[]',summary_json TEXT,created_at TEXT NOT NULL,hidden INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE memberships (user_id TEXT NOT NULL REFERENCES users(id),group_id TEXT NOT NULL REFERENCES groups(id),PRIMARY KEY(user_id,group_id));`);
  const userId=crypto.randomUUID(),caseId=crypto.randomUUID(),salt='abcd1234cafefeed';
  const pwHash=salt+':'+crypto.scryptSync('legacy-student-password',salt,64).toString('hex');
  db.prepare('INSERT INTO users(id,email,password_hash,name,created_at) VALUES(?,?,?,?,?)').run(userId,'legacy@example.invalid',pwHash,'Existing Student','2026-11-10T10:00:00.000Z');
  db.prepare('INSERT INTO groups(id,name,description,initials,color) VALUES(?,?,?,?,?)').run('realgroup','Legacy group','Saved discussion','LG','#000000');
  db.prepare('INSERT INTO memberships(user_id,group_id) VALUES(?,?)').run(userId,'realgroup');
  db.prepare('INSERT INTO cases(id,author_id,author_name,title,dept,hospital,pearl,audience,group_id,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)')
    .run(caseId,userId,'Existing Student','Unmodified existing case','باطنية','Teaching Hospital','Old data','group','realgroup','2026-11-10T10:00:00.000Z');
  db.close();
  for(let run=0;run<2;run++){
    const {proc,origin}=await serverStart(folder);
    try {
      const c=client(origin),guest=client(origin);
      const user=await login(c,'legacy@example.invalid','legacy-student-password');
      assert.equal(user.id,userId);assert.equal(user.role,'student');
      const cases=(await c.req('/api/cases')).data.cases;
      assert.ok(cases.some(x=>x.id===caseId),'original group case and ownership must remain');
      assert.ok(!(await guest.req('/api/cases')).data.cases.some(x=>x.id===caseId),'original group privacy retained');
      assert.equal((await c.req('/api/student/histories')).data.stats.total,0,'legacy cases not falsely marked approved');
      const g=(await c.req('/api/groups')).data.groups;
      assert.equal(g.find(x=>x.id==='realgroup').joined,true);
      assert.equal((await c.req('/api/cases/'+caseId)).status,200);
    }finally{await serverStop(proc);}
  }
  const after =new DatabaseSync(dbfile);
  assert.equal(after.prepare('SELECT COUNT(*) n FROM cases WHERE id=?').get(caseId).n,1);
  assert.equal(after.prepare('SELECT review_status FROM cases WHERE id=?').get(caseId).review_status,'legacy');
  assert.equal(after.prepare('SELECT COUNT(*) n FROM users WHERE id=?').get(userId).n,1);
  assert.ok(after.prepare("PRAGMA table_info('cases')").all().some(x=>x.name==='doctor_id'));
  after.close();
});
