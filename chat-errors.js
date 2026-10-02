'use strict';
const CODES=new Set(['service_unavailable','provider_unavailable','invalid_model_reply','outcome_uncertain','request_conflict','runtime_not_isolated','tool_limit','unauthorized','connector_disabled','AbortError','TimeoutError']);
function failureReply(error={}){
 if(error.mayWrite||['outcome_uncertain','request_conflict'].includes(error.code||error.message))return 'I lost confirmation of that change. Please check the record before repeating it so we do not create a duplicate.';
 if(error.code==='service_unavailable')return 'I could not reach the saved records just now. That does not mean the record is missing. You can give me the figures here and I can still help calculate.';
 return 'I could not finish that reply because the assistant service failed. Please try the question again.';
}
function reportFailure(error={}){
 const value=error.code||error.message||error.name,code=CODES.has(value)?value:CODES.has(error.name)?error.name:'unexpected_error';
 console.warn('[Zuzu chat]',JSON.stringify({code,mayWrite:error.mayWrite===true}));
 return failureReply(error);
}
module.exports={failureReply,reportFailure};
