'use strict';
const source=require('./template-v1.json');
const {fields}=require('./schema');
const escape=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const token=(key,format='')=>'{{'+key+(format?'|'+format:'')+'}}';
function compile(text){
 text=String(text||'').replace(/\s+/g,' ');
 const due=/Total rent|Pembayaran total|Payment must arrive|Dana wajib diterima/.test(text);
 const yearly=/price of rent|Harga sewa rumah/.test(text);
 return text
  .replace(/Hidden Padi, Jl\. Raya Padonan, Tibubeneng, Kec\. Kuta Utara, Kabupaten Badung, Bali 80361/g,token('property.address'))
  .replace(/Hidden Padi/g,token('property.name'))
  .replace(/29 September 2026/g,token('lease.agreement_date','date'))
  .replace(/1 November 2026/g,token(due?'payment.first_payment_due_date':'lease.checkin_date','date'))
  .replace(/31 October 2027/g,token('lease.checkout_date','date'))
  .replace(/IDR 150[,.]000[,.]000/g,token(yearly?'payment.yearly_rent':'payment.total_rent','money'))
  .replace(/IDR 30[,.]000[,.]000/g,token('payment.deposit','money'))
  .replace(/20%/g,token('payment.deposit_percentage')+'%')
  .replace(/\b12(?= months| months,|-month| bulan)/g,token('lease.duration_months'))
  .replace(/\b2(?= bedrooms| kamar tidur)/g,token('property.bedrooms'))
  .replace(/15\.00/g,token('lease.checkin_time'))
  .replace(/12\.00/g,token('lease.checkout_time'))
  .replace(/https:\/\/maps\.app\.goo\.gl\/v5UmhXcG2HxUaU3c6/g,token('property.map_url'))
  .replace(/_{5,}/g,token('lessee.full_name'));
}
const rowFields={
 'Full Name / Nama Lengkap':token('lessee.full_name'),
 'Place & Date of Birth':token('lessee.place_of_birth')+', '+token('lessee.date_of_birth','date'),
 'Nationality / Kewarganegaraan':token('lessee.nationality'),
 'ID Number (KTP/Passport)':token('lessee.passport_number'),
 'Phone Number / No. Telepon':token('lessee.phone'),'Sex / Jenis Kelamin':token('lessee.sex'),
 'Residence / Tempat Tinggal':token('lessee.residence'),
 'Passport Issue Date / Tanggal Terbit':token('lessee.passport_issue_date','date'),
 'Passport Expiry Date / Berlaku Sampai':token('lessee.passport_expiry_date','date'),
 'Property Code':token('property.code'),'Property Name':token('property.name'),'Property Address':token('property.address'),
 'Bedrooms / Bathrooms':token('property.bedrooms')+' bedrooms / '+token('property.bathrooms')+' bathrooms',
 'Lease Duration':token('lease.duration_months')+' months',
 'Check-In Date & Time':token('lease.checkin_date','date')+', '+token('lease.checkin_time'),
 'Check-Out Date & Time':token('lease.checkout_date','date')+', '+token('lease.checkout_time'),
 'Yearly Rent':token('payment.yearly_rent','money')+' / year','Total Rent Amount':token('payment.total_rent','money'),
 'Payment Currency':token('payment.currency'),'Security Deposit':token('payment.deposit','money')+' ('+token('payment.deposit_percentage')+'% of annual rent; refundable security deposit)',
 'First Payment Amount':token('payment.first_payment','money'),'First Payment Due Date':token('payment.first_payment_due_date','date'),
 'Payment Method':token('payment.method')
};
function formatted(data,key,format){
 const value=data[key]||'';if(!value)return '';
 if(format==='date'&&/^\d{4}-\d{2}-\d{2}$/.test(value)){
  const d=new Date(value+'T00:00:00Z');if(Number.isFinite(d.getTime()))return new Intl.DateTimeFormat('en-GB',{day:'numeric',month:'long',year:'numeric',timeZone:'UTC'}).format(d);
 }
 if(format==='money'&&/^\d+(\.\d{1,2})?$/.test(value))return (data['payment.currency']||'IDR')+' '+value.replace(/\B(?=(\d{3})+(?!\d))/g,',');
 return value;
}
function fill(template,data,editable,company={}){
 return template.split(/(\{\{[a-z_.]+(?:\|[a-z]+)?\}\})/g).map(part=>{
  const match=part.match(/^\{\{([a-z_.]+)(?:\|([a-z]+))?\}\}$/);
  if(!match)return escape(part);
  const [,key,format]=match;if(key.startsWith('company.'))return escape(company[key.slice(8)]||'________________');if(!Object.hasOwn(fields,key))throw Error('Unknown template field');
  const value=formatted(data,key,format);
  return editable?`<button type="button" class="contract-field ${value?'':'empty'}" data-field="${key}" aria-label="Edit ${escape(key.replaceAll('.',' ').replaceAll('_',' '))}">${escape(value||'________________')}</button>`:escape(value||'________________');
 }).join('');
}
function renderContract(data,{editable=false,company={}}={}){
 const pages=source.pages.map((blocks,i)=>{
  const content=blocks.map(b=>{
   if(i===12&&b.text?.startsWith('THE LESSOR/VILLA MANAGEMENT:'))return '<div class="signatures"><div><strong>THE LESSOR/VILLA MANAGEMENT:</strong><div class="sign-space"></div>'+escape(company.name||'________________')+'<br>Represented by: '+escape(company.representative||'________________')+'</div><div><strong>THE LESSEE/PENYEWA:</strong><div class="sign-space"></div>Name: '+fill(token('lessee.full_name'),data,editable,company)+'</div></div>';
   if(i===12&&b.text?.includes('Name: ____________________________ Represented by:'))return '';
   if(b.kind==='text')return `<p class="${b.style}">${fill(compile(b.text),data,editable,company)}</p>`;
   return '<table><colgroup><col style="width:35%"><col style="width:65%"></colgroup>'+b.rows.map(row=>{
    const cells=row.filter(c=>c!==null),label=String(cells[0]||'').replace(/\s+/g,' ');
    if(cells.length===1)return `<tr><th colspan="2">${escape(label)}</th></tr>`;
    return '<tr>'+cells.map((cell,n)=>`<td>${fill(n===1&&rowFields[label]?rowFields[label]:compile(cell),data,editable,company)}</td>`).join('')+'</tr>';
   }).join('')+'</table>';
  }).join('');
  return page(content,i+1,company);
 });
 if(data['appendix.additional_agreements'])pages.push(page('<h2>Additional Agreements / Kesepakatan Tambahan</h2><p class="appendix">'+escape(data['appendix.additional_agreements'])+'</p>',14,company));
 return pages.join('');
}
function page(content,number,company){return `<section class="contract-page"><header><div><strong>${escape(company.name||'________________')}</strong><br>NIB ${escape(company.nib||'________________')}<br>${escape(company.header_address||'').replaceAll('\n','<br>')}<br>${escape(company.contact||'')}</div><h1>HOUSE RENTAL<br>AGREEMENT</h1></header><div class="contract-body">${content}</div><footer>Page ${number}</footer></section>`;}
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const templateHash=crypto.createHash('sha256');
for(const file of ['template-v1.json','template.js','document.css','pdf.js'])templateHash.update(fs.readFileSync(path.join(__dirname,file)));
module.exports={renderContract,sourceSha256:source.sourceSha256,templateHash:templateHash.digest('hex')};
