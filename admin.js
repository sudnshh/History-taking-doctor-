'use strict';
const $=id=>document.getElementById(id);
const escapeHtml=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
let adminKey='';
function message(text,error=false){
  const e=$('adminMessage');e.hidden=false;e.textContent=text;e.className=error?'admin-alert':'admin-ok';
}
async function request(url,options={}){
  const headers={'Content-Type':'application/json',...(adminKey?{'X-Admin-Key':adminKey}:{}),...(options.headers||{})};
  const res=await fetch(url,{credentials:'same-origin',...options,headers});
  let data;try{data=await res.json()}catch{throw new Error('تعذّر الاتصال بالخادم')}
  if(!res.ok)throw new Error(data.error||`خطأ ${res.status}`);
  return data;
}
function caseCard(c){
  const el=document.createElement('article');el.className='admin-case';
  const reviewLabel=c.review_status==='pending'?'Pending · بانتظار الدكتور':c.review_status==='rejected'?'Rejected · غير منشورة':c.review_status==='approved'?'Approved · مكتملة':'Legacy · حالة سابقة';
  const status=c.hidden?'<span class="admin-badge hidden">محجوبة</span>':c.review_status==='pending'||c.review_status==='rejected'?'<span class="admin-badge hidden">غير منشورة</span>':'<span class="admin-badge">ظاهرة</span>';
  const group=c.audience==='group'?'للمجموعة فقط':'لجميع الطلاب';
  el.innerHTML=`<div class="title">${escapeHtml(c.title)} ${status} <span class="admin-badge">${escapeHtml(reviewLabel)}</span></div>
    <p class="small">الطالب: ${escapeHtml(c.author_name)} · التخصص: ${escapeHtml(c.dept)} · النشر: ${group}<br>
    المستشفى: ${escapeHtml(c.hospital||'غير محدد')} · ${escapeHtml(new Date(c.created_at).toLocaleDateString('ar-IQ'))} · بلاغات: ${Number(c.reports_count)||0}</p>
    <div class="actions">
      <button type="button" class="admin-btn secondary" data-act="toggle">${c.hidden?'إرجاع الحالة للظهور':'حجب الحالة عن الطلاب'}</button>
      ${c.review_status==='legacy'?'<button type="button" class="admin-btn danger" data-act="delete">حذف نهائي</button>':'<span class="small">السجلات الأكاديمية محمية من الحذف</span>'}
    </div>`;
  el.querySelector('[data-act=toggle]').addEventListener('click',async event=>{
    const action=c.hidden?'restore':'hide';
    if(!confirm(c.hidden?'هل تريد إرجاع الحالة للطلاب؟':'هل تريد حجب هذه الحالة من جميع الطلاب؟'))return;
    event.currentTarget.disabled=true;
    try{await request(`/api/admin/cases/${c.id}/${action}`,{method:'POST',body:'{}'});
      message(action==='hide'?'تم حجب الحالة':'تمت إعادة إظهار الحالة');await load();}
    catch(e){message(e.message,true);event.currentTarget.disabled=false;}
  });
  el.querySelector('[data-act=delete]')?.addEventListener('click',async event=>{
    const confirmation=prompt('هذا حذف نهائي للحالة وتعليقاتها. إذا متأكد اكتب كلمة: حذف');
    if(confirmation!=='حذف')return;
    event.currentTarget.disabled=true;
    try{await request(`/api/admin/cases/${c.id}`,{method:'DELETE',body:'{}'});
      message('تم الحذف النهائي للحالة');await load();}
    catch(e){message(e.message,true);event.currentTarget.disabled=false;}
  });
  return el;
}
async function load(){
  const search=$('adminSearch').value.trim();const status=$('adminStatus').value;
  const uri=`/api/admin/cases?search=${encodeURIComponent(search)}&status=${encodeURIComponent(status)}`;
  const [{cases,total,hiddenCount,reportCount},{reports}]=await Promise.all([
    request(uri),request('/api/admin/reports')
  ]);
  $('adminStats').innerHTML=`<span>إجمالي الحالات: <strong>${total}</strong></span><span>محجوبة: <strong>${hiddenCount}</strong></span><span>البلاغات: <strong>${reportCount}</strong></span>`;
  const root=$('adminCases');root.replaceChildren();
  if(!cases.length)root.textContent='ماكو حالات مطابقة للبحث.';
  for(const c of cases)root.append(caseCard(c));
  const reportRoot=$('adminReports');reportRoot.replaceChildren();
  if(!reports.length)reportRoot.textContent='لا توجد بلاغات.';
  for(const r of reports){
    const p=document.createElement('div');p.className='admin-case';
    p.innerHTML=`<strong>${escapeHtml(r.title)}</strong><p class="small">${escapeHtml(r.reason)}<br>من: ${escapeHtml(r.reporter_email)} · ${escapeHtml(new Date(r.created_at).toLocaleDateString('ar-IQ'))} ${r.hidden?'· الحالة محجوبة':''}</p>`;
    reportRoot.append(p);
  }
}
$('adminLogin').addEventListener('submit',async event=>{
  event.preventDefault();adminKey=$('adminKey').value;
  if(adminKey.length<24){message('مفتاح الإدارة يجب أن يحتوي على 24 حرفاً على الأقل',true);return;}
  const btn=$('unlockBtn');btn.disabled=true;
  try{await Promise.all([load(),loadAcademic()]);$('adminKey').value='';$('loginPanel').hidden=true;$('dashboard').hidden=false;$('reportsPanel').hidden=false;$('academicDashboard').hidden=false;
    $('adminMessage').hidden=true;}
  catch(e){adminKey='';message('تعذّر فتح لوحة الإدارة: '+e.message,true);}
  finally{btn.disabled=false;}
});
$('reloadCases').addEventListener('click',()=>load().catch(e=>message(e.message,true)));
$('adminStatus').addEventListener('change',()=>load().catch(e=>message(e.message,true)));
let timer;$('adminSearch').addEventListener('input',()=>{clearTimeout(timer);timer=setTimeout(()=>load().catch(e=>message(e.message,true)),300)});
request('/api/me').then(({user})=>{
  $('adminAccount').textContent=user?
    `أنت مسجل باسم ${user.name} (${user.email}). افتح اللوحة بمفتاح الإدارة.`:
    'لازم تسجّل دخول بحساب المشرف من الصفحة الرئيسية، وبعدين ترجع لهنا.';
}).catch(()=>{});

// Live academic statistics: drawn from the same SQLite database as the main platform.
let academicStudents=[];
const badge=s=>`<span class="status ${escapeHtml(s)}">${escapeHtml(s)}</span>`;
function renderStudentRows(){
 const query=$('studentSearch').value.trim().toLowerCase();
 const rows=academicStudents.filter(s=>[s.name,s.email,s.studentNumber,s.id].join(' ').toLowerCase().includes(query));
 $('studentRows').innerHTML=rows.length?rows.map(s=>`<tr><td><strong>${escapeHtml(s.name)}</strong><div class="muted">${escapeHtml(s.email)}<br>الرقم الجامعي: ${escapeHtml(s.studentNumber||'غير مضاف')}<br>ID: ${escapeHtml(s.id)}</div></td>
  <td>${Number(s.total)}</td><td>${Number(s.approved)}</td><td>${Number(s.rejected)}</td><td>${Number(s.pending)}</td>
  <td><button class="btn secondary" data-student="${escapeHtml(s.id)}">عرض السجل</button></td></tr>`).join(''):'<tr><td colspan="6" class="empty">لا توجد نتائج</td></tr>';
 $('studentRows').querySelectorAll('[data-student]').forEach(btn=>btn.addEventListener('click',()=>openStudent(btn.dataset.student)));
}
async function loadAcademic(){
 const [students,doctors]=await Promise.all([request('/api/admin/students'),request('/api/admin/doctors')]);
 academicStudents=students.students;
 const tot=(k)=>academicStudents.reduce((sum,x)=>sum+Number(x[k]||0),0);
 $('academicStats').innerHTML=`<span>Students: <b>${academicStudents.length}</b></span><span>Doctors: <b>${doctors.doctors.length}</b></span>
 <span>Total: <b>${tot('total')}</b></span><span>Approved: <b>${tot('approved')}</b></span>
 <span>Rejected: <b>${tot('rejected')}</b></span><span>Pending: <b>${tot('pending')}</b></span>`;
 renderStudentRows();
 $('doctorRows').innerHTML=doctors.doctors.length?doctors.doctors.map(d=>`<tr><td><strong>${escapeHtml(d.name)}</strong></td><td>${escapeHtml(d.email)}</td>
 <td>${Number(d.total)}</td><td>${Number(d.reviewed)}</td><td>${Number(d.pending)}</td></tr>`).join(''):
 '<tr><td colspan="5" class="empty">لم تتم إضافة دكاترة بعد</td></tr>';
}
function academicDialog(title){$('adminHistoryTitle').textContent=title;$('adminHistoryBody').replaceChildren();$('adminHistoryDialog').classList.add('open');}
async function openStudent(id){
 try{
  const {student,histories}=await request(`/api/admin/students/${encodeURIComponent(id)}/histories`);
  academicDialog(`Histories · ${student.name}`);
  const body=$('adminHistoryBody');
  if(!histories.length){body.textContent='لم يرفع الطالب أي History بعد';return;}
  for(const h of histories){
   const row=document.createElement('div');row.className='admin-case';
   row.innerHTML=`<strong>${escapeHtml(h.title)}</strong><div class="small">الدكتور: ${escapeHtml(h.doctorName)} · ${escapeHtml(h.status)} · ${escapeHtml(new Date(h.uploadedAt).toLocaleDateString('ar-IQ'))}</div>
    ${h.rejectionReason?`<p class="error">${escapeHtml(h.rejectionReason)}</p>`:''}
    <button class="btn secondary" data-history="${escapeHtml(h.id)}">فتح الهستري</button>`;
   row.querySelector('[data-history]').onclick=()=>openAcademicHistory(h.id);
   body.append(row);
  }
 }catch(e){message(e.message,true);}
}
async function openAcademicHistory(id){
 try{
  const {history:h}=await request(`/api/admin/histories/${encodeURIComponent(id)}`);
  academicDialog(h.title);
  const body=$('adminHistoryBody'),info=document.createElement('div');info.className='history-info';
  info.innerHTML=`الطالب: ${escapeHtml(h.studentName)} · الدكتور: ${escapeHtml(h.doctorName)} · ${badge(h.status)}
    ${h.rejectionReason?`<p class="error">سبب الرفض: ${escapeHtml(h.rejectionReason)}</p>`:''}`;body.append(info);
  if(h.hasPdf){const btn=document.createElement('button');btn.className='btn secondary';btn.textContent='تنزيل ملف PDF';btn.onclick=()=>downloadAdminPdf(h.id);body.append(btn);}
  if(h.canvasPages.length){const wrap=document.createElement('div');wrap.className='notebook-pages';
   for(const [i,src] of h.canvasPages.entries()){const im=document.createElement('img');im.src=src;im.alt=`صفحة ${i+1}`;wrap.append(im);}body.append(wrap);}
 }catch(e){message(e.message,true);}
}
async function downloadAdminPdf(id){
 try{
  const r=await fetch(`/api/histories/${encodeURIComponent(id)}/file`,{credentials:'same-origin',headers:{'X-Admin-Key':adminKey}});
  if(!r.ok){let e;try{e=await r.json()}catch{}throw Error(e?.error||`HTTP ${r.status}`);}
  const blob=await r.blob(),url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download='Clinical_History.pdf';document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),60000);
 }catch(e){message(e.message,true);}
}
$('closeAcademicDialog').onclick=()=>$('adminHistoryDialog').classList.remove('open');
$('adminHistoryDialog').addEventListener('click',e=>{if(e.target===$('adminHistoryDialog'))$('adminHistoryDialog').classList.remove('open');});
$('studentSearch').addEventListener('input',renderStudentRows);
$('refreshAcademic').addEventListener('click',()=>loadAcademic().catch(e=>message(e.message,true)));
$('createDoctor').addEventListener('submit',async e=>{
 e.preventDefault();
 const name=$('doctorName').value.trim(),email=$('doctorEmail').value.trim(),password=$('doctorPassword').value;
 if(!confirm(`إنشاء حساب للدكتور: ${name}؟`))return;
 const btn=e.submitter;if(btn)btn.disabled=true;
 try{await request('/api/admin/doctors',{method:'POST',body:JSON.stringify({name,email,password})});
  $('createDoctor').reset();message('تم إنشاء حساب الدكتور وربطه بقاعدة البيانات');await loadAcademic();}
 catch(err){message(err.message,true);}finally{if(btn)btn.disabled=false;}
});

setInterval(()=>{if(adminKey&&!document.hidden)loadAcademic().catch(()=>{});},30000);
