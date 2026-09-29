'use strict';
const fs=require('node:fs/promises');
const path=require('node:path');
const {PDFDocument,StandardFonts,rgb}=require('pdf-lib');
const {inclusions}=require('./schema');

const white=rgb(1,1,1),black=rgb(0,0,0);
const blank='________________________';
function value(data,key,fallback=blank){return String(data[key]||fallback);}
function date(data,key){
 const v=data[key];if(!/^\d{4}-\d{2}-\d{2}$/.test(v||''))return blank;
 return new Intl.DateTimeFormat('en-GB',{day:'numeric',month:'long',year:'numeric',timeZone:'UTC'}).format(new Date(v+'T00:00:00Z'));
}
function money(data,key){
 const v=data[key];if(!/^\d+(?:\.\d{1,2})?$/.test(v||''))return blank;
 return (data['payment.currency']||'IDR')+' '+Number(v).toLocaleString('en-US',{maximumFractionDigits:2});
}
function topY(page,top,size){return page.getHeight()-top-size;}
function cover(page,x,top,width,height){page.drawRectangle({x,y:page.getHeight()-top-height,width,height,color:white});}
function fit(font,text,size,maxWidth,min=6){let out=size;while(out>min&&font.widthOfTextAtSize(text,out)>maxWidth)out-=.25;return out;}
function drawLine(page,font,text,x,top,width,size=10){
 const actual=fit(font,text,size,width);page.drawText(text,{x,y:topY(page,top,actual),size:actual,font,color:black,maxWidth:width});
}
function wrap(font,text,size,width){
 const words=String(text).split(/\s+/),lines=[];let line='';
 for(const word of words){const next=line?line+' '+word:word;if(font.widthOfTextAtSize(next,size)<=width)line=next;else{if(line)lines.push(line);line=word;}}
 if(line)lines.push(line);return lines;
}
function paragraph(page,font,text,x,top,width,size=10,leading=12.5){
 for(const line of wrap(font,text,size,width)){drawLine(page,font,line,x,top,width,size);top+=leading;}return top;
}
function cell(page,font,text,top,{x=237.3,width=283.5,size=10,height=16}={}){
 cover(page,x,top,width,height);drawLine(page,font,text,x+2,top+2,width-4,size);
}
function tenant(page,font,data){
 const rows=[['lessee.full_name',354],['',370],['lessee.nationality',386],['lessee.passport_number',402],['lessee.phone',418],['lessee.sex',434],['lessee.residence',451],['lessee.passport_issue_date',468],['lessee.passport_expiry_date',498]];
 for(const [key,top] of rows){let text=key?value(data,key):[value(data,'lessee.place_of_birth',''),date(data,'lessee.date_of_birth')].filter(x=>x&&x!==blank).join(', ')||blank;if(key.endsWith('_date'))text=date(data,key);cell(page,font,text,top,{height:16});}
}
function pageOne(page,font,bold,italic,data){
 cover(page,70,108,455,58);drawLine(page,font,`This Lease Agreement is made in Bali on ${date(data,'lease.agreement_date')} between PT The Villa Managers and ${blank}:`,72,112,450,10);
 drawLine(page,italic,`Perjanjian Sewa Menyewa ini dibuat di Bali pada ${date(data,'lease.agreement_date')} antara PT The Villa Managers dan ${blank}:`,72,137,450,10);
 tenant(page,font,data);
 const rows=[
  [568,value(data,'property.code')],[584,value(data,'property.name')],[600,value(data,'property.address')],
  [627,`${value(data,'property.bedrooms','___')} bedrooms / ${value(data,'property.bathrooms','___')} bathrooms`],
  [643,`${value(data,'lease.duration_months','___')} months`],[659,`${date(data,'lease.checkin_date')}, ${value(data,'lease.checkin_time','__:__')}`],
  [675,`${date(data,'lease.checkout_date')}, ${value(data,'lease.checkout_time','__:__')}`]
 ];
 for(const [top,text] of rows)cell(page,font,text,top,{height:top===600?27:16});
 const monthly=data['payment.rent_period']==='monthly',rateKey=monthly?'payment.monthly_rent':'payment.yearly_rent';
 cover(page,76,728,160,16);drawLine(page,bold,monthly?'Monthly Rent':'Yearly Rent',77,730,155,10);
 cell(page,font,`${money(data,rateKey)} / ${monthly?'month':'year'}`,728);cell(page,font,money(data,'payment.total_rent'),744);
}
function paymentTable(page,font,data){
 const monthly=data['payment.rent_period']==='monthly',schedule=data['payment.payment_schedule']==='monthly',months=Number(data['lease.duration_months']);
 const depositBasis=monthly?'monthly':'annual';
 const following=schedule?(months===1?'None - no further rent payment':`Remaining ${Number.isFinite(months)?Math.max(0,months-1):'__'} monthly payments of ${money(data,'payment.installment_amount')}`):'None - total rent paid fully upfront';
 const rows=[[113,value(data,'payment.currency','IDR'),16],[129,`${money(data,'payment.deposit')} (${value(data,'payment.deposit_percentage','__')}% of ${depositBasis} rent; refundable security deposit)`,28],[157,money(data,'payment.first_payment'),16],[173,date(data,'payment.first_payment_due_date'),16],[189,following,16],[205,value(data,'payment.method','Bank Transfer'),16]];
 for(const [top,text,height] of rows)cell(page,font,text,top,{height,size:9.6});
}
function inclusionTable(page,font,data){
 const included=[],excluded=[];for(const [key,[en,id]] of Object.entries(inclusions))(data['inclusions.'+key]==='yes'?included:excluded).push(`${en} / ${id}`);
 cover(page,75,366,448,69);
 paragraph(page,font,included.length?included.join('; '):'Villa only / Properti villa saja.',77,369,210,9,11);
 paragraph(page,font,excluded.length?excluded.join('; '):'None / Tidak ada.',303,369,216,8.5,10.5);
}
function propertyNarrative(page,font,italic,data){
 cover(page,70,438,455,184);
 const beds=value(data,'property.bedrooms','___'),name=value(data,'property.name'),address=value(data,'property.address');
 let top=442;top=paragraph(page,font,'Whereas, LESSOR does hereby declare to have let and surrendered in lease to LESSEE, and LESSEE does hereby declare to have rented and accepted in lease from LESSOR, a unit of',72,top,450,10.5,12.7)+3;
 top=paragraph(page,font,`Villa made of ${beds} bedrooms FULLY FURNISHED, known as ${name}, ${address}`,72,top,450,10.5,12.7)+3;
 paragraph(page,font,'(Hereinafter referred to as the "Premises")',72,top,450,10.5,12.7);top+=17;
 top=paragraph(page,italic,`Dimana pemilik dengan ini menyatakan telah menyerahkan kepada PENYEWA untuk disewakan, dan PENYEWA dengan ini menyatakan telah menerima dari PEMILIK untuk disewa, sebuah villa dengan ${beds} kamar tidur DILENGKAPI FURNITURE yang dikenal dengan nama ${name}, ${address} yang seluruhnya merupakan milik PEMILIK.`,72,top,450,10.5,12.7)+2;
 paragraph(page,italic,'(Selanjutnya disebut sebagai "Rumah Dimaksud")',72,top,450,10.5,12.7);
 drawLine(page,italic,`Property location map / Peta lokasi properti: ${value(data,'property.map_url')}`,72,604,450,10);
}
function articleOne(page,font,italic,data){
 cover(page,70,701,485,63);
 let top=704;top=paragraph(page,font,`• The LESSEE will lease the villa for a period of ${value(data,'lease.duration_months','___')} months, effective ${date(data,'lease.checkin_date')} - ${date(data,'lease.checkout_date')}.`,108,top,414,10.5,12.7)+2;
 paragraph(page,italic,`PENYEWA menyewa rumah yang dimaksud selama ${value(data,'lease.duration_months','___')} bulan, berlaku ${date(data,'lease.checkin_date')} - ${date(data,'lease.checkout_date')}.`,108,top,414,10.5,12.7);
}
function articleTwoThree(page,font,italic,data){
 const monthly=data['payment.rent_period']==='monthly',schedule=data['payment.payment_schedule']==='monthly',rateKey=monthly?'payment.monthly_rent':'payment.yearly_rent',period=monthly?'month':'year',periode=monthly?'bulan':'tahun';
 cover(page,70,369,455,91);let top=372;
 top=paragraph(page,font,`The rent is ${money(data,rateKey)} per ${period}, ${schedule?'payable monthly under Article 3':'payable fully upfront'} for the ${value(data,'lease.duration_months','___')}-month lease.`,72,top,450,10.5,12.7)+2;
 top=paragraph(page,italic,`Harga sewa adalah ${money(data,rateKey)} per ${periode}, ${schedule?'dibayar bulanan sesuai Pasal 3':'dibayar penuh di muka'} untuk masa sewa ${value(data,'lease.duration_months','___')} bulan.`,72,top,450,10.5,12.7)+3;
 drawLine(page,font,`CHECK IN: ${date(data,'lease.checkin_date')}, start from ${value(data,'lease.checkin_time','__:__')}`,72,top,450,10.5);top+=13;
 drawLine(page,font,`CHECK OUT: ${date(data,'lease.checkout_date')}, max at ${value(data,'lease.checkout_time','__:__')}`,72,top,450,10.5);
 cover(page,70,544,485,252);top=547;
 const months=Number(data['lease.duration_months']),remaining=Number.isFinite(months)?Math.max(0,months-1):'__';
 const payment=schedule?`The first payment of ${money(data,'payment.first_payment')} is due on ${date(data,'payment.first_payment_due_date')}. ${remaining} following monthly payments of ${money(data,'payment.installment_amount')} are due monthly. Total rent is ${money(data,'payment.total_rent')}.`:`Total rent of ${money(data,'payment.total_rent')} must be fully paid upfront on ${date(data,'payment.first_payment_due_date')}.`;
 const pembayaran=schedule?`Pembayaran pertama ${money(data,'payment.first_payment')} jatuh tempo ${date(data,'payment.first_payment_due_date')}. ${remaining} pembayaran bulanan berikutnya masing-masing ${money(data,'payment.installment_amount')}. Total sewa ${money(data,'payment.total_rent')}.`:`Total sewa ${money(data,'payment.total_rent')} wajib dibayar penuh di muka pada ${date(data,'payment.first_payment_due_date')}.`;
 top=paragraph(page,font,'• '+payment,108,top,414,10.2,12.2)+4;top=paragraph(page,italic,pembayaran,108,top,414,10.2,12.2)+5;
 top=paragraph(page,font,`• The LESSEE will pay a security deposit of ${value(data,'payment.deposit_percentage','__')}% of the ${monthly?'monthly':'annual'} rent, amounting to ${money(data,'payment.deposit')}.`,108,top,414,10.2,12.2)+3;
 paragraph(page,italic,`PENYEWA membayar uang jaminan ${value(data,'payment.deposit_percentage','__')}% dari sewa ${monthly?'bulanan':'tahunan'}, yaitu ${money(data,'payment.deposit')}.`,108,top,414,10.2,12.2);
}
function signature(page,font,data){cover(page,394,727,130,18);drawLine(page,font,value(data,'lessee.full_name'),396,730,126,9.5);}
function appendix(pdf,font,bold,text,company={}){
 if(!String(text||'').trim())return;
 const lines=String(text||'').split(/\n/).flatMap(line=>line?wrap(font,line,10,455):['']),chunks=[];
 while(lines.length)chunks.push(lines.splice(0,47));
 for(const chunk of chunks){
  const page=pdf.addPage([595.28,841.89]);drawLine(page,bold,company.name||'THE VILLA MANAGERS',70,52,455,11);drawLine(page,bold,'ADDITIONAL AGREEMENTS / PERJANJIAN TAMBAHAN',70,88,455,13);
  let top=122;for(const line of chunk){if(line)drawLine(page,font,line,70,top,455,10);top+=14;}
 }
}

async function generateFromMaster(data,{masterPath,blankTemplate=false,company={}}={}){
 const bytes=await fs.readFile(masterPath);const pdf=await PDFDocument.load(bytes);if(pdf.getPageCount()!==13)throw Error('Contract master must have 13 pages');
 const font=await pdf.embedFont(StandardFonts.Helvetica),bold=await pdf.embedFont(StandardFonts.HelveticaBold),italic=await pdf.embedFont(StandardFonts.HelveticaOblique);
 const values=blankTemplate?{}:data;
 pageOne(pdf.getPage(0),font,bold,italic,values);paymentTable(pdf.getPage(1),font,values);inclusionTable(pdf.getPage(1),font,values);propertyNarrative(pdf.getPage(1),font,italic,values);articleOne(pdf.getPage(1),font,italic,values);articleTwoThree(pdf.getPage(2),font,italic,values);signature(pdf.getPage(12),font,values);
 appendix(pdf,font,bold,values['appendix.additional_agreements'],company);
 pdf.setTitle(blankTemplate?'TVM Lease Agreement Blank Template':'TVM Lease Agreement');pdf.setSubject('Generated from the private approved master template');
 return {pdf:Buffer.from(await pdf.save({useObjectStreams:false})),pages:pdf.getPageCount()};
}
function rendererMasterPath(){const candidate=process.env.CONTRACT_MASTER_PDF||path.join(process.cwd(),'master.pdf');return candidate;}
module.exports={generateFromMaster,rendererMasterPath};
