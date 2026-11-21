'use strict';
// Host supplies the authenticated user; the model can only read/write that user's own memory.
const CATEGORIES=['personal','work','business','preference','decision','relationship','reference'];
// Secrets and money records never belong in conversational memory.
const SECRET=/\b(password|passwd|pass|passcode|pin|otp|login|username|credential|kata sandi|sandi|wachtwoord|key ?box|kode kunci|sleutelcode|cvv|card|kartu|rekening|account|iban|swift|bank|saldo|balance|seed|private key|wallet|api key|token|secret)\b|\d[\d .-]{9,}\d/i;
// Money amounts belong in the finance records, not in conversational memory.
const MONEY=/(rp\.?|idr|usd|eur|\$|\u20ac|juta|jt\b|ribu|rb\b)\s*\d|\d[\d.,]*\s*(rp|idr|usd|eur|juta|jt|ribu|rb|k)\b/i;
// A remembered fact is data about the user, never an instruction to the assistant.
const INSTRUCTION=/\b(ignore|disregard|override|system prompt|instruction|you must|you should|always (?:do|call|create|send|use)|never (?:ask|confirm)|call the tool|tool|execute|run|create (?:a )?task|delete|send (?:an? )?(?:email|message))\b|https?:\/\/|www\./i;
function createMemoryTools(assistant,userKey){
 if(!['afni','syifa'].includes(userKey))throw Error('unauthorized');
 const invalid=message=>({ok:false,error:'invalid_arguments',message});
 const project=e=>({fact:e.fact,category:e.category,at:e.at});
 let saves=0; // tools are created per incoming message, so this caps writes per message
 return {
  async personal_memory_search(input){
   if(!input||Array.isArray(input)||Object.keys(input).some(k=>k!=='q')||(input.q!==undefined&&(typeof input.q!=='string'||input.q.length>200)))return invalid('Input: {q?:string}.');
   const items=await assistant.searchMemory(userKey,input.q||'',12);
   return {ok:true,items:items.map(project)};
  },
  async personal_remember(input,{beforeWrite=async()=>{}}={}){
   if(!input||Array.isArray(input)||Object.keys(input).some(k=>!['fact','category'].includes(k))||typeof input.fact!=='string'||!input.fact.trim()||input.fact.length>300)return invalid('Input: {fact:string (one short sentence),category?:string}.');
   if(input.category!==undefined&&!CATEGORIES.includes(input.category))return invalid('category must be one of: '+CATEGORIES.join(', '));
   if(SECRET.test(input.fact)||MONEY.test(input.fact))return {ok:false,error:'not_saved',message:'Secrets, codes, account details and money amounts are never stored in memory.'};
   if(INSTRUCTION.test(input.fact))return {ok:false,error:'not_saved',message:'Only plain facts about the user can be remembered, not instructions or links.'};
   if(++saves>3)return {ok:false,error:'not_saved',message:'Memory limit for this message reached.'};
   await beforeWrite();
   return {ok:true,saved:project(await assistant.remember(userKey,input.fact.trim(),{category:input.category||'reference',source:'zuzu-auto'}))};
  }
 };
}
module.exports={createMemoryTools};
