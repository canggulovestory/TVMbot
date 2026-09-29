'use strict';
const source=require('./template-v1.json');
const {fields,inclusions}=require('./schema');
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
  const value=formatted(data,key,format),short=['property.bedrooms','property.bathrooms','lease.duration_months','payment.deposit_percentage'].includes(key),blank=short?'___':'________________';
  return editable?`<button type="button" class="contract-field ${value?'':'empty'}${short?' short':''}" data-field="${key}" aria-label="Edit ${escape(key.replaceAll('.',' ').replaceAll('_',' '))}">${escape(value||blank)}</button>`:escape(value||blank);
 }).join('');
}
function inclusionChecklist(data,editable){
 return '<table class="inclusions"><colgroup><col style="width:62%"><col style="width:38%"></colgroup><tr><th colspan="2">INCLUSIONS &amp; EXCLUSIONS / TERMASUK &amp; TIDAK TERMASUK</th></tr>'+
 '<tr><td colspan="2">'+(editable?'Villa included. Check services included in rent.<br>Villa termasuk. Centang layanan yang termasuk dalam harga sewa.':'Villa included / Villa termasuk.')+'</td></tr>'+
 Object.entries(inclusions).map(([key,[en,id]])=>{
  const field='inclusions.'+key,checked=data[field]==='yes',label=en+' / '+id;
  const state=checked?'Included / Termasuk':'Excluded / Tidak termasuk';
  return '<tr><td>'+escape(label)+'</td><td>'+(editable?`<label><input type="checkbox" data-inclusion="${field}"${checked?' checked':''} aria-label="${escape(en)}"> <span>${state}</span></label>`:state)+'</td></tr>';
 }).join('')+'</table>';
}
// The checklist controls only service costs; all other source clauses stay fixed.
function serviceText(text){
 const normalized=text.replace(/\s+/g,' ');
 const replacements={
  'No services or running costs are included in the rental price. The rental is for the villa only.':'The villa and services marked Included in the checklist are included in the rent and are the responsibility of the LESSOR.',
  'Biaya-biaya berikut termasuk dalam harga sewa dan menjadi tanggung jawab PEMILIK:':'Villa dan layanan yang ditandai Termasuk pada daftar termasuk dalam harga sewa dan menjadi tanggung jawab PEMILIK.',
  '• Villa only. No services, utilities, fees, cleaning, linen changes, pool cleaning, garbage collection, or other running costs are included.':'',
  '• All utilities and operating costs, including electricity • Cleaning, linen change, pool cleaning, Banjar fees and garbage fees • Personal laundry and personal expenses':'Services marked Excluded, other unlisted running costs and personal expenses are the responsibility of the LESSEE unless otherwise agreed in writing. / Layanan yang ditandai Tidak termasuk, biaya operasional lain yang tidak tercantum, dan pengeluaran pribadi menjadi tanggung jawab PENYEWA kecuali disepakati lain secara tertulis.'
 };
 if(Object.hasOwn(replacements,normalized))return replacements[normalized];
 return text.replace('The actual cost of the electricity token purchased; PLUS','The actual cost of the electricity token purchased, only if electricity is marked Excluded in the checklist; PLUS')
  .replace('Biaya aktual pembelian token listrik tersebut; DITAMBAH','Biaya aktual pembelian token listrik tersebut, hanya jika listrik ditandai Tidak termasuk pada daftar; DITAMBAH')
  .replace('Because the rental is for the villa only and no services or running costs are included,','Except for services marked Included in the checklist,')
  .replace('Karena sewa ini hanya untuk villa dan tidak mencakup layanan maupun biaya operasional,','Kecuali layanan yang ditandai Termasuk pada daftar,');
}
function paymentText(text,data){
 const monthly=data['payment.rent_period']==='monthly',installments=data['payment.payment_schedule']==='monthly';
 if(monthly)text=text.replaceAll(token('payment.yearly_rent','money'),token('payment.monthly_rent','money')).replaceAll('per year','per month').replaceAll('per tahun','per bulan').replaceAll('annual rent','monthly rent').replaceAll('sewa tahunan','sewa bulanan').replaceAll(' / year',' / month');
 if(!installments)return text;
 const count=Number(data['lease.duration_months']),remaining=Number.isInteger(count)&&count>=1?String(count-1):'___';
 const en=count===1?'No further rent payments are due.':`The remaining ${remaining} monthly payments of ${token('payment.installment_amount','money')} are due on the same calendar day in each following month, or the last day of a shorter month.`,id=count===1?'Tidak ada pembayaran sewa berikutnya.':`Sebanyak ${remaining} pembayaran bulanan berikutnya masing-masing ${token('payment.installment_amount','money')} jatuh tempo pada tanggal yang sama setiap bulan berikutnya, atau hari terakhir jika bulan lebih pendek.`;
 if(text.startsWith('• Total rent of'))return `• The first rent payment of ${token('payment.first_payment','money')} must arrive in the LESSOR's bank account by 12:00 PM (local time) on ${token('payment.first_payment_due_date','date')}. ${en} Total rent is ${token('payment.total_rent','money')}. Failure to receive the first payment by this time grants the LESSOR the right to deny entry to the Premises.`;
 if(text.startsWith('Pembayaran total sewa'))return `Pembayaran sewa pertama sebesar ${token('payment.first_payment','money')} wajib diterima dalam rekening bank PEMILIK selambat-lambatnya pukul 12:00 siang (waktu setempat) pada ${token('payment.first_payment_due_date','date')}. ${id} Total sewa adalah ${token('payment.total_rent','money')}. Jika pembayaran pertama tidak diterima tepat waktu, PEMILIK berhak menolak akses ke Rumah Dimaksud.`;
 if(text==='None - annual rent paid fully upfront'||text==='None - monthly rent paid fully upfront')return `${en} / ${id}`;
 return text.replace('payable fully upfront for the','payable in monthly installments under Article 3 for the').replace('dibayarkan penuh di muka untuk','dibayarkan secara bulanan sesuai Pasal 3 untuk');
}
function renderContract(data,{editable=false,company={}}={}){
 const pages=source.pages.map((blocks,i)=>{
  const content=blocks.map((b,j)=>{
   if(i===12&&b.text?.startsWith('THE LESSOR/VILLA MANAGEMENT:'))return '<div class="signatures"><div><strong>THE LESSOR/VILLA MANAGEMENT:</strong><div class="sign-space"></div>'+escape(company.name||'________________')+'<br>Represented by: '+escape(company.representative||'________________')+'</div><div><strong>THE LESSEE/PENYEWA:</strong><div class="sign-space"></div>Name: '+fill(token('lessee.full_name'),data,editable,company)+'</div></div>';
   if(i===12&&b.text?.includes('Name: ____________________________ Represented by:'))return '';
   if(b.kind==='text'){
    if(/^Article \d+/.test(b.text))return `<div class="article-heading"><h2>${escape(b.text)}</h2><p>${escape(blocks[j+1]?.text||'')}</p></div>`;
    if(/^Pasal \d+/.test(b.text))return '';
    const text=serviceText(b.text),bullet=text.startsWith('•'),indented=bullet||blocks[j-1]?.text?.startsWith('•');
    if(text.startsWith('{{company.bank}}'))return '<div class="bank-details">'+fill(text,data,editable,company).replaceAll('\n','<br>')+'</div>';
    return text?`<p class="${b.style}${bullet?' bullet':indented?' indented':''}">${fill(paymentText(compile(text),data),data,editable,company)}</p>`:'';
   }
   if(b.rows[0][0].startsWith('INCLUSIONS & EXCLUSIONS'))return inclusionChecklist(data,editable);
   return '<table><colgroup><col style="width:35%"><col style="width:65%"></colgroup>'+b.rows.map(row=>{
    const cells=row.filter(c=>c!==null),label=String(cells[0]||'').replace(/\s+/g,' ');
    if(cells.length===1)return `<tr><th colspan="2">${escape(label)}</th></tr>`;
    return '<tr>'+cells.map((cell,n)=>`<td>${fill(paymentText(n===1&&rowFields[label]?rowFields[label]:compile(cell),data).replace(/^Yearly Rent$/,data['payment.rent_period']==='monthly'?'Monthly Rent':'Yearly Rent'),data,editable,company)}</td>`).join('')+'</tr>';
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
for(const file of ['template-v1.json','template.js','schema.js','document.css','pdf.js','master-pdf.js'])templateHash.update(fs.readFileSync(path.join(__dirname,file)));
module.exports={renderContract,sourceSha256:source.sourceSha256,templateHash:templateHash.digest('hex')};
