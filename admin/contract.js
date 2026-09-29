'use strict';
const $=id=>document.getElementById(id),base='/api/admin/contracts';
let draft=null,schema={},pending={},saving=null,timer=null,blocked=false;
const title=key=>key.split('.').pop().replaceAll('_',' ').replace(/^./,s=>s.toUpperCase());
function status(text,error=false){$('status').textContent=text;$('status').classList.toggle('error',error);}
async function api(suffix='',options={}){
 const response=await fetch(base+suffix,{...options,headers:{'Content-Type':'application/json',...options.headers},cache:'no-store'});
 const data=await response.json();if(!response.ok){const e=Error(data.error||'Request failed');e.status=response.status;e.issues=data.issues;throw e;}return data;
}
function issueList(issues=[]){$('review-section').hidden=!issues.length;$('issues').replaceChildren();for(const issue of issues){const li=document.createElement('li'),a=document.createElement('a');a.href='#';a.textContent=title(issue.field)+': '+issue.message;a.onclick=e=>{e.preventDefault();focusField(issue.field)};li.className=issue.level;li.append(a);$('issues').append(li);}}
function focusField(key,button){
 if(!Object.hasOwn(schema,key)||!draft)return;
 if($('passport-panel').open)$('passport-panel').close();
 button=button||document.querySelector('button[data-field="'+key+'"]');
 if(!button)return;
 const input=document.createElement(/address|residence|additional_agreements/.test(key)?'textarea':key==='payment.currency'?'select':'input');
 input.className='inline-field';input.setAttribute('aria-label',title(key));input.maxLength=schema[key];
 if(input.tagName==='SELECT')for(const currency of ['IDR','USD','EUR','AUD','GBP','SGD'])input.add(new Option(currency,currency));
 else if(input.tagName==='INPUT')input.type=key.endsWith('_date')||key.endsWith('date_of_birth')?'date':key.endsWith('_time')?'time':'text';
 input.value=pending[key]??draft.data[key]??'';input.autocomplete='off';
 input.oninput=()=>{pending[key]=input.value;status('Saving…');clearTimeout(timer);timer=setTimeout(()=>save().catch(showError),800);};
 input.onkeydown=e=>{if(e.key==='Enter'&&(input.tagName!=='TEXTAREA'||e.ctrlKey||e.metaKey)){e.preventDefault();input.blur();}};
 input.onblur=()=>{save().then(async()=>{if(input.isConnected)input.replaceWith(button);await preview();}).catch(showError);};
 button.replaceWith(input);input.focus();input.scrollIntoView({block:'nearest'});
}
async function preview(){const id=draft.id;const r=await fetch(base+'/'+id+'/preview',{cache:'no-store'});if(!r.ok)throw Error('Document preview unavailable');const html=await r.text();if(draft.id===id&&!document.querySelector('.inline-field:focus'))$('document').innerHTML=html;}
function versions(){ $('versions-section').hidden=!draft.versions?.length;$('versions').replaceChildren();for(const v of draft.versions||[]){const a=document.createElement('a');a.href=base+'/'+draft.id+'/versions/'+v.id;a.textContent='Download revision '+v.revision+' · '+new Date(v.createdAt).toLocaleString('en-GB');$('versions').append(a);}}
function showError(e){status(e.message,true);if(e.issues)issueList(e.issues);if(e.status===409||e.status===401||e.status===403){blocked=true;status(e.message+' Your unsaved entries remain here. Copy them before reloading.',true);}}
async function save(){
 clearTimeout(timer);if(saving)return saving;if(!draft||!Object.keys(pending).length)return;if(blocked)throw Error('Saving is paused. Copy unsaved entries, then reload the draft.');
 saving=(async()=>{do{while(Object.keys(pending).length){const patch=pending;pending={};status('Saving…');try{draft=await api('/'+draft.id,{method:'PATCH',body:JSON.stringify({revision:draft.revision,fields:patch})});issueList(draft.issues);}catch(e){pending={...patch,...pending};throw e;}}await preview();}while(Object.keys(pending).length);status('Saved automatically');})();
 try{await saving;}finally{saving=null;}
}
async function list(){const items=await api();$('drafts').replaceChildren(new Option('Contracts',''));for(const [index,item] of items.entries())$('drafts').add(new Option([item.propertyName,item.tenantName].filter(Boolean).join(' — ')||'Contract '+(items.length-index),item.id));if(draft)$('drafts').value=draft.id;return items;}
async function open(id){if(Object.keys(pending).length||saving)await save();draft=await api('/'+id);blocked=false;pending={};versions();passportReview();await preview();$('generate').disabled=false;$('passport').disabled=false;$('show-passport').disabled=false;status('Saved automatically');issueList();}
$('new').onclick=async()=>{try{await save();const d=await api('',{method:'POST',body:'{}'});await open(d.id);await list();}catch(e){showError(e)}};
$('drafts').onchange=async e=>{if(!e.target.value)return;try{await open(e.target.value)}catch(e){showError(e);e.target.value=draft?.id||''}};
$('document').onclick=e=>{const field=e.target.closest('button[data-field]');if(field)focusField(field.dataset.field,field)};
$('show-passport').onclick=()=>$('passport-panel').showModal();
$('close-passport').onclick=()=>$('passport-panel').close();
$('appendix').dataset.field='appendix.additional_agreements';
$('appendix').onclick=()=>focusField('appendix.additional_agreements',$('appendix'));
$('generate').onclick=async()=>{try{await save();$('reviewed').checked=false;$('confirm').showModal()}catch(e){showError(e)}};
$('confirm').onclose=async()=>{if($('confirm').returnValue!=='generate')return;$('generate').disabled=true;try{await save();status('Generating PDF…');await api('/'+draft.id+'/pdf',{method:'POST',body:JSON.stringify({revision:draft.revision,reviewed:true})});draft=await api('/'+draft.id);versions();status('PDF ready to download.');}catch(e){showError(e)}finally{$('generate').disabled=false}};
window.addEventListener('beforeunload',e=>{if(saving||Object.keys(pending).length){e.preventDefault();e.returnValue='';}});
function passportReview(){
 const area=$('passport-review');area.replaceChildren();const extraction=draft?.extraction;if(!extraction)return;
 const remove=document.createElement('button');remove.type='button';remove.textContent='Remove passport source';remove.onclick=async()=>{if(!confirm('Remove all uploaded passport sources and extraction candidates? Approved contract fields and PDFs stay. Backups follow their own retention schedule.'))return;try{await save();draft=await api('/'+draft.id+'/passport',{method:'DELETE',body:JSON.stringify({revision:draft.revision})});passportReview();status('Passport sources removed. Approved fields retained.');}catch(e){showError(e)}};area.append(remove);
 const link=document.createElement('a');link.href=base+'/'+draft.id+'/passport';link.textContent='Download original passport for comparison';area.append(link);
 if(extraction.reviewedBy){const p=document.createElement('p');p.textContent='Reviewed and applied. Click a tenant field in the document to edit it.';area.append(p);return;}
 for(const warning of extraction.warnings){const p=document.createElement('p');p.className='warning';p.textContent=warning;area.append(p);}
 const values=[];for(const [key,candidate] of Object.entries(extraction.fields)){
  const label=document.createElement('label'),check=document.createElement('input'),input=document.createElement('input'),name=document.createElement('span');check.type='checkbox';input.type='text';input.value=candidate.value||'';input.maxLength=schema[key]||300;name.textContent=' '+title(key)+(candidate.raw?' · source: '+candidate.raw:' · unreadable / not available');
  label.append(check,name,input);area.append(label);values.push({key,check,input});
 }
 const approve=document.createElement('button');approve.type='button';approve.textContent='Apply checked, reviewed fields';approve.onclick=async()=>{try{await save();const fields=Object.fromEntries(values.filter(x=>x.check.checked).map(x=>[x.key,x.input.value]));if(!Object.keys(fields).length)throw Error('Select the fields you have checked against the passport.');draft=await api('/'+draft.id+'/review',{method:'POST',body:JSON.stringify({revision:draft.revision,extractionId:extraction.id,reviewed:true,fields})});passportReview();await preview();status('Reviewed passport fields saved.');}catch(e){showError(e)}};area.append(approve);
}
async function upload(file){
 if(!draft||!file)return;if(file.size>10*1024*1024)return showError(Error('Maximum passport size is 10 MB.'));
 $('passport').disabled=true;$('document').inert=true;$('new').disabled=true;$('drafts').disabled=true;$('generate').disabled=true;
 try{await save();status('Reading passport privately…');const r=await fetch(base+'/'+draft.id+'/passport',{method:'POST',headers:{'Content-Type':file.type,'X-Contract-Revision':String(draft.revision)},body:file});const data=await r.json();if(!r.ok)throw Error(data.error||'Passport upload failed');draft=data;passportReview();status('Passport read. Review and check each field before applying.');}
 catch(e){showError(e)}finally{$('passport').disabled=false;$('document').inert=false;$('new').disabled=false;$('drafts').disabled=false;$('generate').disabled=false;$('passport').value='';}
}
$('passport').onchange=e=>upload(e.target.files[0]);
$('dropzone').ondragover=e=>e.preventDefault();$('dropzone').ondrop=e=>{e.preventDefault();if(!$('passport').disabled)upload(e.dataTransfer.files[0]);};
$('dropzone').onkeydown=e=>{if(e.target===$('dropzone')&&(e.key==='Enter'||e.key===' ')){e.preventDefault();$('passport').click();}};
async function initialize(){
 schema=(await api('/schema')).fields;
 const items=await list();
 const current=items[0]||await api('',{method:'POST',body:'{}'});
 await open(current.id);await list();$('new').disabled=false;
}
initialize().catch(showError);
