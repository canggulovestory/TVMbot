'use strict';
// Shared contract values only. Legal text and company settings are not client fields.
const groups={
 lessee:['full_name','place_of_birth','date_of_birth','nationality','passport_number','phone','sex','residence','passport_issue_date','passport_expiry_date'],
 property:['code','name','address','bedrooms','bathrooms','map_url'],
 lease:['agreement_date','duration_months','checkin_date','checkin_time','checkout_date','checkout_time'],
 payment:['currency','yearly_rent','total_rent','deposit_percentage','deposit','first_payment','first_payment_due_date','method'],
 appendix:['additional_agreements']
};
const fields=Object.freeze(Object.fromEntries(Object.entries(groups).flatMap(([group,keys])=>keys.map(key=>[`${group}.${key}`,key==='additional_agreements'?12000:key==='address'||key==='residence'?2000:300]))));
function blankContract(now=new Date()){return {...Object.fromEntries(Object.keys(fields).map(k=>[k,''])),
 'lease.agreement_date':new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Makassar',year:'numeric',month:'2-digit',day:'2-digit'}).format(now),
 'lease.checkin_time':'15:00','lease.checkout_time':'12:00','payment.currency':'IDR','payment.method':'Bank Transfer'};}
function applyFields(data,patch){
 if(!patch||Array.isArray(patch)||Object.getPrototypeOf(patch)!==Object.prototype)throw Error('Invalid contract fields');
 const result={...data};
 for(const [key,value] of Object.entries(patch)){
  if(!Object.hasOwn(fields,key)||typeof value!=='string'||value.length>fields[key]||/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value))throw Error('Invalid contract field: '+key);
  result[key]=value.trim();
 }
 return result;
}
function validDate(value){
 if(!/^\d{4}-\d{2}-\d{2}$/.test(value)||value<'1900-01-01'||value>'2199-12-31')return false;
 const d=new Date(value+'T00:00:00Z');return Number.isFinite(d.getTime())&&d.toISOString().slice(0,10)===value;
}
function suggestCheckout(start,months){
 if(!validDate(start)||!Number.isInteger(months)||months<1||months>120)throw Error('Invalid lease duration or start date');
 const d=new Date(start+'T00:00:00Z'),day=d.getUTCDate();
 d.setUTCDate(1);d.setUTCMonth(d.getUTCMonth()+months);
 const last=new Date(Date.UTC(d.getUTCFullYear(),d.getUTCMonth()+1,0)).getUTCDate();
 d.setUTCDate(Math.min(day,last)-1);
 return d.toISOString().slice(0,10);
}
function moneyMinor(value){
 if(typeof value!=='string'||!/^(0|[1-9]\d{0,11})(\.\d{1,2})?$/.test(value))throw Error('Use a non-negative amount with at most two decimals and no separators');
 const [whole,fraction='']=value.split('.');return BigInt(whole)*100n+BigInt(fraction.padEnd(2,'0'));
}
function validate(data,today){
 if(!validDate(today))throw Error('Invalid review date');
 const issues=[],add=(field,message,level='error')=>issues.push({field,message,level});
 const required=['lessee.full_name','lessee.passport_number','lessee.nationality','property.name','property.address','property.bedrooms','property.bathrooms',
 'lease.agreement_date','lease.duration_months','lease.checkin_date','lease.checkout_date','lease.checkin_time','lease.checkout_time',
 'payment.currency','payment.yearly_rent','payment.total_rent','payment.deposit','payment.deposit_percentage','payment.first_payment','payment.first_payment_due_date','payment.method'];
 for(const k of required)if(!data[k])add(k,'Required');
 for(const k of Object.keys(fields).filter(k=>k.endsWith('_date')||k==='lessee.date_of_birth'))if(data[k]&&!validDate(data[k]))add(k,'Enter a valid date');
 for(const k of ['lease.checkin_time','lease.checkout_time'])if(data[k]&&!/^([01]\d|2[0-3]):[0-5]\d$/.test(data[k]))add(k,'Enter a valid 24-hour time');
 for(const k of ['property.bedrooms','property.bathrooms','lease.duration_months'])if(data[k]&&(!/^[1-9]\d{0,2}$/.test(data[k])||Number(data[k])>(k==='lease.duration_months'?120:100)))add(k,'Enter a valid positive whole number');
 const start=data['lease.checkin_date'],end=data['lease.checkout_date'];
 if(validDate(start)&&validDate(end)){
  if(end<=start)add('lease.checkout_date','Check-out must be after check-in');
  const months=Number(data['lease.duration_months']);
  if(Number.isInteger(months)&&months>=1&&months<=120&&suggestCheckout(start,months)!==end)add('lease.duration_months','Dates differ from the suggested duration; confirm the override','warning');
 }
 if(data['property.map_url']){try{const u=new URL(data['property.map_url']);if(!['https:','http:'].includes(u.protocol)||u.username||u.password)throw Error();}catch{add('property.map_url','Use an HTTP or HTTPS map link without credentials');}}
 if(data['payment.currency']&&!['IDR','USD','EUR','AUD','GBP','SGD'].includes(data['payment.currency']))add('payment.currency','Unsupported currency');
 const amounts={};
 for(const k of ['yearly_rent','total_rent','deposit','first_payment'])if(data['payment.'+k]){
  try{amounts[k]=moneyMinor(data['payment.'+k]);if(k!=='deposit'&&amounts[k]===0n)add('payment.'+k,'Amount must be greater than zero');}catch(e){add('payment.'+k,e.message);}
 }
 if(amounts.first_payment!==undefined&&amounts.total_rent!==undefined&&amounts.first_payment!==amounts.total_rent)add('payment.first_payment','This template requires total rent paid upfront');
 if(data['lease.duration_months']==='12'&&amounts.yearly_rent!==undefined&&amounts.total_rent!==undefined&&amounts.yearly_rent!==amounts.total_rent)add('payment.total_rent','A 12-month lease must match its annual rent');
 if(data['payment.deposit_percentage']){
  try{const percentage=moneyMinor(data['payment.deposit_percentage']);if(percentage>10000n)throw Error();
   if(amounts.yearly_rent!==undefined&&amounts.deposit!==undefined&&(amounts.yearly_rent*percentage+5000n)/10000n!==amounts.deposit)add('payment.deposit','Deposit does not match the configured percentage of annual rent');
  }catch{add('payment.deposit_percentage','Enter a percentage from 0 to 100');}
 }
 const expiry=data['lessee.passport_expiry_date'];
 if(validDate(expiry)&&(expiry<today||(validDate(end)&&expiry<end)))add('lessee.passport_expiry_date',expiry<today?'Passport has expired':'Passport expires before lease end','warning');
 const birth=data['lessee.date_of_birth'],issue=data['lessee.passport_issue_date'];
 if(validDate(birth)&&birth>today)add('lessee.date_of_birth','Birth date is in the future');
 if(validDate(issue)&&validDate(expiry)&&issue>=expiry)add('lessee.passport_issue_date','Issue date must precede expiry');
 return issues;
}
module.exports={fields,blankContract,applyFields,validate,suggestCheckout,moneyMinor};
