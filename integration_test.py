"""Isolated end-to-end tests; creates no sample users/cases in a real database."""
import base64, contextlib, http.cookiejar, json, os, pathlib, socket, subprocess, tempfile, time, urllib.request, urllib.error
ROOT=pathlib.Path(__file__).resolve().parent
PORT=32583
ORIGIN=f'http://127.0.0.1:{PORT}'
KEY='k'*40

def client():
    return urllib.request.build_opener(urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))

def call(c,path,method='GET',body=None,admin=False):
    payload=None if body is None else json.dumps(body).encode('utf8')
    headers={'Origin':ORIGIN,'Content-Type':'application/json'}
    if admin:headers['X-Admin-Key']=KEY
    req=urllib.request.Request(ORIGIN+path,method=method,headers=headers,data=payload)
    try:
        with c.open(req,timeout=8) as res:
            blob=res.read();return res.status, json.loads(blob) if res.headers.get('Content-Type','').startswith('application/json') else blob
    except urllib.error.HTTPError as err:
        return err.code,json.loads(err.read())

def check(actual,expected,msg=''):
    assert actual==expected, f'{msg}: expected {expected}, got {actual}'

with tempfile.TemporaryDirectory(prefix='medhub-local-test-') as d:
    env=os.environ.copy();env.update({'PORT':str(PORT),'DATA_DIR':d,'ADMIN_EMAIL':'admin@test.invalid','ADMIN_KEY':KEY,'COOKIE_SECURE':'false','APP_ORIGIN':ORIGIN})
    proc=subprocess.Popen(['node','server.js'],cwd=str(ROOT),env=env,stdout=subprocess.PIPE,stderr=subprocess.PIPE)
    try:
        for _ in range(35):
            if proc.poll() is not None: raise RuntimeError('Node server exited: '+proc.stderr.read().decode())
            try:
                with urllib.request.urlopen(ORIGIN+'/api/health',timeout=0.4) as r:
                    if r.status==200:break
            except Exception:time.sleep(0.15)
        admin=client();student=client();other=client();doctor=client();doctor2=client();guest=client()
        for c,em,name in [(admin,'admin@test.invalid','Administrator'),(student,'student@test.invalid','Student One'),(other,'student2@test.invalid','Student Two')]:
            code,data=call(c,'/api/register','POST',{'email':em,'name':name,'password':'reallystrongpassword!'});check(code,200,'register '+name)
        # For non-authenticated users, adminAccess responds 403; no statistics are exposed.
        check(call(guest,'/api/admin/students')[0],403,'anonymous admin denied')
        code,data=call(admin,'/api/admin/doctors','POST',{'name':'Dr A','email':'dr-a@test.invalid','password':'doctorpassword1!'},admin=True);check(code,201,'create doctor A')
        id_a=data['doctor']['id']
        code,data=call(admin,'/api/admin/doctors','POST',{'name':'Dr B','email':'dr-b@test.invalid','password':'doctorpassword2!'},admin=True);check(code,201,'create doctor B')
        id_b=data['doctor']['id']
        for c,em,pw in [(doctor,'dr-a@test.invalid','doctorpassword1!'),(doctor2,'dr-b@test.invalid','doctorpassword2!')]:
            check(call(c,'/api/login','POST',{'email':em,'password':pw})[0],200,'doctor login')
        check(call(student,'/api/doctors')[0],200,'doctor list')
        pdf=b'%PDF-1.4\n1 0 obj\n<<>>\nendobj\n%%EOF\n'
        payload={'title':'Unidentified chest pain','dept':'باطنية','doctorId':id_a,'privacyAgree':True,'canvasPages':[],
          'pdfData':'data:application/pdf;base64,'+base64.b64encode(pdf).decode()}
        check(call(student,'/api/cases','POST',{**payload,'doctorId':''})[0],400,'cannot submit without doctor')
        check(call(student,'/api/cases','POST',payload)[0],201,'create history pending')
        history=call(student,'/api/student/histories')[1]['histories'][0];id1=history['id'];check(history['status'],'pending')
        check(len(call(guest,'/api/cases')[1]['cases']),0,'pending invisible publicly')
        check(call(other,'/api/student/histories/'+id1)[0],404,'student isolation')
        check(call(other,'/api/histories/'+id1+'/file')[0],403,'pdf isolation')
        check(call(doctor2,'/api/doctor/histories/'+id1)[0],404,'doctor detail isolation')
        check(call(doctor2,'/api/doctor/histories/'+id1+'/review','POST',{'decision':'approved'})[0],404,'doctor approval isolation')
        check(call(doctor,'/api/doctor/histories/'+id1+'/review','POST',{'decision':'rejected'})[0],400,'reason mandatory')
        check(call(doctor,'/api/histories/'+id1+'/file')[0],200,'assigned doctor can fetch pdf')
        check(call(doctor,'/api/doctor/histories/'+id1+'/review','POST',{'decision':'approved'})[0],200,'doctor approval')
        check(call(doctor,'/api/doctor/histories/'+id1+'/review','POST',{'decision':'rejected','reason':'Missing HPI'})[0],409,'single final decision')
        check(len(call(guest,'/api/cases')[1]['cases']),1,'approved becomes public')
        code,data=call(student,'/api/cases','POST',{**payload,'title':'Second clinical history'})
        check(code,201,'second history')
        id2=data['case']['id']
        check(call(doctor,'/api/doctor/histories/'+id2+'/review','POST',{'decision':'rejected','reason':'History of presenting complaint incomplete'})[0],200,'rejection')
        code,data=call(student,'/api/student/histories');check(data['stats'],{'total':2,'approved':1,'rejected':1,'pending':0},'student stats')
        check(len(call(guest,'/api/cases')[1]['cases']),1,'rejected stays private')
        check(call(student,'/api/cases/'+id1,'DELETE')[0],403,'student cannot delete reviewed history')
        code,data=call(admin,'/api/admin/students?search=Student',admin=True);check(code,200,'admin student list')
        row=next(x for x in data['students'] if x['name']=='Student One')
        check([row[x] for x in ('total','approved','rejected','pending')],[2,1,1,0],'admin stats')
        code,data=call(admin,'/api/admin/doctors',admin=True)
        d1=next(x for x in data['doctors'] if x['id']==id_a);check(d1['reviewed'],2,'doctor reviewed')
        check(call(admin,'/api/admin/histories/'+id1,admin=True)[0],200,'admin full access')
        check(call(student,'/api/admin/students',admin=True)[0],403,'student forbidden admin stats')
        check(call(student,'/api/doctor/histories')[0],403,'student forbidden doctor list')
        check(call(doctor2,'/api/histories/'+id2+'/file')[0],403,'other doctor pdf isolation')
        check(call(doctor,'/api/student/histories')[0],403,'doctor forbidden student histories')
        for path in ['/student.html','/doctor.html','/admin.html','/css/portal.css','/js/portal.js','/js/app.js']:
            with urllib.request.urlopen(ORIGIN+path,timeout=5) as res:check(res.status,200,'static '+path)
        print('PASS: authentication, doctor allocation, pending/approved/rejected, PDF access, admin counts, isolation & static routes')
    finally:
        proc.terminate()
        try:proc.communicate(timeout=4)
        except subprocess.TimeoutExpired:proc.kill()
