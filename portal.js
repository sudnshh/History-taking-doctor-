'use strict';
const $=id=>document.getElementById(id);
const role=document.body.dataset.role;
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const date=s=>s?new Date(s).toLocaleDateString('ar-IQ',{year:'numeric',month:'short',day:'numeric'}):'—';
const labels={pending:'Pending · بانتظار الموافقة',approved:'Approved · مقبول',rejected:'Rejected · مرفوض'};
const status=s=>`<span class="status ${esc(s)}">${esc(labels[s]||s)}</span>`;
let items=[];
function msg(text,error=false){$('message').innerHTML=`<p class="${error?'error':'info'}">${esc(text)}</p>`;}
async function request(url,opt={}){
 const r=await fetch(url,{credentials:'same-origin',...opt,headers:{'Content-Type':'application/json',...(opt.headers||{})}});
 const b=await r.json();if(!r.ok)throw Error(b.error||`HTTP ${r.status}`);return b;
}
function metric(name,num,emoji){return `<div class="metric"><span class="emoji">${emoji}</span><span class="number">${Number(num)||0}</span><span class="name">${esc(name)}</span></div>`;}
function render(){
 const q=$('search').value.trim().toLowerCase(),list=items.filter(h=>[h.title,h.studentName,h.doctorName,h.dept].join(' ').toLowerCase().includes(q));
 $('rows').innerHTML=list.length?list.map(h=>`<tr><td><strong>${esc(h.title)}</strong><div class="muted">${esc(h.dept)}</div></td>
 <td>${esc(role==='doctor'?h.studentName:h.doctorName)}</td><td>${date(h.uploadedAt)}</td><td>${status(h.status)}</td>
 <td><button class="btn secondary" data-open="${esc(h.id)}">فتح الملف</button></td></tr>`).join(''):'<tr><td colspan="5" class="empty">ماكو Histories مطابقة</td></tr>';
 $('rows').querySelectorAll('[data-open]').forEach(btn=>btn.addEventListener('click',()=>openHistory(btn.dataset.open)));
}
function showPages(h){
 const root=$('detail'),info=document.createElement('div');info.className='history-info';
 info.innerHTML=`<div>الطالب: <strong>${esc(h.studentName)}</strong> · الدكتور: <strong>${esc(h.doctorName)}</strong></div>
 <div>تاريخ الرفع: ${date(h.uploadedAt)} · الحالة: ${status(h.status)}</div>
 ${h.rejectionReason?`<p class="error">سبب الرفض: ${esc(h.rejectionReason)}</p>`:''}`;
 root.append(info);
 if(h.hasPdf){const link=document.createElement('a');link.className='btn secondary';link.style.display='inline-block';link.style.marginTop='12px';link.href=`/api/histories/${encodeURIComponent(h.id)}/file`;link.textContent='تنزيل ملف الـPDF';root.append(link);}
 if(h.canvasPages.length){const wrap=document.createElement('div');wrap.className='notebook-pages';h.canvasPages.forEach((src,i)=>{const img=document.createElement('img');img.src=src;img.alt=`صفحة History ${i+1}`;img.loading='lazy';wrap.append(img);});root.append(wrap);}
}
async function openHistory(id){
 try{
  const {history:h}=await request(`/api/${role}/histories/${encodeURIComponent(id)}`);
  $('detailTitle').textContent=h.title;$('detail').replaceChildren();showPages(h);
  if(role==='doctor'&&h.status==='pending'){
   const actions=document.createElement('div');actions.className='actions';
   const approve=document.createElement('button');approve.className='btn';approve.textContent='موافقة (Approve)';
   const reject=document.createElement('button');reject.className='btn reject';reject.textContent='رفض (Reject)';
   const reason=document.createElement('textarea');reason.className='field';reason.placeholder='سبب الرفض إلزامي (5 أحرف على الأقل)';reason.style.width='100%';reason.style.display='none';
   const confirmReject=document.createElement('button');confirmReject.className='btn reject';confirmReject.textContent='تأكيد الرفض';confirmReject.style.display='none';
   actions.append(approve,reject);$('detail').append(reason,actions,confirmReject);
   reject.onclick=()=>{reason.style.display='block';confirmReject.style.display='inline-block';reason.focus();};
   const decide=async(decision,why='')=>{
    if(decision==='rejected'&&why.trim().length<5){msg('اكتب سبب الرفض أولاً',true);return;}
    if(!confirm(decision==='approved'?'تأكيد موافقتك على هذا الهستري؟':'تأكيد رفض الهستري؟'))return;
    approve.disabled=reject.disabled=confirmReject.disabled=true;
    try{await request(`/api/doctor/histories/${encodeURIComponent(h.id)}/review`,{method:'POST',body:JSON.stringify({decision,reason:why})});
     $('dialog').classList.remove('open');msg('تم حفظ قرار المراجعة بنجاح');await load();}
    catch(e){msg(e.message,true);approve.disabled=reject.disabled=confirmReject.disabled=false;}
   };
   approve.onclick=()=>decide('approved');confirmReject.onclick=()=>decide('rejected',reason.value);
  }
  $('dialog').classList.add('open');
 }catch(e){msg(e.message,true);}
}
async function load(){
 const {histories,stats}=await request(`/api/${role}/histories`);items=histories;
 $('metrics').innerHTML=role==='student'?
 metric('Total · جميع الهستريات',stats.total,'📚')+metric('Approved · المكتملة',stats.approved,'✅')+
 metric('Rejected · المرفوضة',stats.rejected,'✕')+metric('Pending · بانتظار الموافقة',stats.pending,'⏳'):
 metric('بانتظار مراجعتي',stats.pending,'⏳')+metric('تمت مراجعتها',stats.reviewed,'🩺')+
 metric('مقبولة',stats.approved,'✅')+metric('مرفوضة',stats.rejected,'✕');
 render();
}
$('closeDialog').onclick=()=>$('dialog').classList.remove('open');
$('dialog').addEventListener('click',e=>{if(e.target===$('dialog'))$('dialog').classList.remove('open');});
$('search').addEventListener('input',render);
(async()=>{try{const {user}=await request('/api/me');
 if(!user){msg('سجّل الدخول من الصفحة الرئيسية أولاً.',true);return;}
 if(user.role!==role){msg('لا تملك صلاحية الدخول إلى هذه البوابة.',true);return;}
 $('welcome').textContent=`مرحباً ${user.name} · ${role==='student'?'متابعة الهستريات المرفوعة':'مراجعة حالات الطلاب المرتبطة بحسابك'}`;
 await load();}catch(e){msg('تعذر تحميل البيانات: '+e.message,true);}})();

// Refresh counts and statuses from SQLite while the dashboard is open.
setInterval(()=>{if(!document.hidden)load().catch(()=>{});},30000);
