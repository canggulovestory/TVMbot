'use strict';
// Host supplies the authenticated user; model input cannot choose an owner.
function createReminderTools(assistant,userKey){
 if(!['afni','syifa'].includes(userKey))throw Error('unauthorized');
 const invalid=()=>({ok:false,error:'invalid_arguments',message:'Give reminder text and an explicit valid future time in Bali, for example tomorrow 09:00.'});
 const project=r=>({id:r.id,text:r.text,at:assistant.epochToWitaString(r.at),recurrence:r.recurrence||'',timeZone:'Asia/Makassar'});
 return {
  async personal_list_reminders(input){
   if(!input||Array.isArray(input)||Object.keys(input).length)return invalid();
   const reminders=await assistant.listReminders(userKey);
   return {ok:true,items:reminders.slice(0,50).map(project),total:reminders.length};
  },
  async personal_add_reminder(input,{beforeWrite=async()=>{}}={}){
   if(!input||Array.isArray(input)||Object.keys(input).some(k=>!['text','when'].includes(k))||typeof input.text!=='string'||!input.text.trim()||input.text.length>500||typeof input.when!=='string'||input.when.length>80)return invalid();
   const tokens=input.when.trim().split(/\s+/),clock=input.when.match(/\b(\d{1,2}):(\d{2})\b/);
   if(!clock&&!/^\+\d+[mh]$/.test(input.when))return invalid();
   if(clock&&(Number(clock[1])>23||Number(clock[2])>59))return invalid();
   const date=input.when.match(/^\d{4}-\d{2}-\d{2}/)?.[0];
   if(date&&(!Number.isFinite(Date.parse(date))||new Date(date).toISOString().slice(0,10)!==date))return invalid();
   const when=assistant.parseWhen(tokens);
   if(!when||when.consumed!==tokens.length||when.at<=Date.now())return invalid();
   await beforeWrite();
   return {ok:true,...project(await assistant.addReminder({userKey,text:input.text.trim(),at:when.at,recurrence:when.recurrence}))};
  }
 };
}
module.exports={createReminderTools};
