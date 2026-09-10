'use strict';
const fields=['kind','amount','currency','date','accountId','categoryId','villaId','description','billId','period','paymentMode','existingExpenseId'];
const intentSchema={type:'object',additionalProperties:false,required:['kind','amount','currency','date','description'],properties:Object.fromEntries(fields.map(name=>[name,{type:['string','null']}]))};
intentSchema.properties.kind={type:'string',enum:['income','expense','bill_payment']};
intentSchema.properties.currency={type:'string',enum:['IDR']};
intentSchema.properties.amount={type:'string',pattern:'^[0-9]+(\\.[0-9]{1,2})?$'};
const filters={type:'object',additionalProperties:false,properties:Object.fromEntries(['query','accountId','villaId','categoryId','dateFrom','dateTo'].map(name=>[name,{type:'string'}]))};
const financeTools=[
 {name:'finance_read',description:'Read selected financial records for the verified owner. Resolve accounts, categories and villas before preparing. Accounts/villas/categories accept only query. Transactions accept accountId, villaId, categoryId and ISO dateFrom/dateTo. Unpaid bills accept those except accountId. Never infer that a bill is paid without a record.',input_schema:{type:'object',additionalProperties:false,required:['resource'],properties:{resource:{type:'string',enum:['accounts','villas','categories','transactions','unpaid_bills']},filters,pageSize:{type:'integer',minimum:1,maximum:50},cursor:{type:['object','null']}}}},
 {name:'finance_prepare',description:'Prepare a transaction preview, NOT a payment or saved entry. Ask for missing amount, date, account or ambiguous IDs. Personal expenses need no villa. Save descriptions in English; understand multilingual input. Return the owner confirmation link. A chat yes cannot post. Repeated equal entries require explicit duplicate review.',input_schema:{type:'object',additionalProperties:false,required:['intent'],properties:{intent:intentSchema,duplicateOf:{type:['string','null']}}}},
 {name:'finance_receipt',description:'Check the stored proposal receipt. Only status committed means saved. Pending, expired, cancelled or unavailable never mean saved. Never send private data to a fallback provider.',input_schema:{type:'object',additionalProperties:false,required:['proposalId'],properties:{proposalId:{type:'string'}}}}
];
module.exports={financeTools,intentFields:fields};
