(function(root){
  'use strict';
  function createWebChat(api,base,changed=()=>{},{pollMs=750}={}){
    const state={busy:false,run:null,deciding:false,error:''};
    async function request(path,options={}){
      const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),15000);
      try{return await api(path,{...options,signal:controller.signal})}finally{clearTimeout(timer)}
    }
    state.cancel=async()=>{
      if(!state.busy||!state.run?.id)return;
      try{await request(base+'/'+state.run.id+'/cancel',{method:'POST'});state.run={...state.run,status:'cancelling',approval:null}}
      catch(error){state.error='Could not confirm cancellation. Check saved records before retrying.'}
      changed(state);
    };
    state.decide=async choice=>{
      if(state.deciding||!state.run?.approval)return;
      const token=state.run.approval.token;
      state.deciding=true;state.error='';changed(state);
      try{await request(base+'/'+state.run.id+'/decision',{method:'POST',body:JSON.stringify({token,choice})});state.run={...state.run,status:'running',approval:null}}
      catch(error){state.error=error.message}
      finally{state.deciding=false;changed(state)}
    };
    state.send=async message=>{
      if(state.busy)throw Error('A chat request is already running.');
      state.busy=true;state.run=null;state.error='';changed(state);
      const id=root.crypto.randomUUID();
      try{
        state.run=await request(base,{method:'POST',body:JSON.stringify({id,message})});
        const deadline=Date.now()+210000;
        while(!['completed','failed','cancelled'].includes(state.run.status)){
          changed(state);
          if(Date.now()>deadline)throw Error('Chat request timed out');
          await new Promise(resolve=>setTimeout(resolve,pollMs));
          state.run=await request(base+'/'+state.run.id);
        }
        if(state.run.status!=='completed')throw Error(state.run.error||'Request did not finish');
        return {reply:state.run.reply};
      }catch(error){
        // Never resubmit a possibly mutating request. Stop best-effort; the
        // server also cancels abandoned runs when the browser lease expires.
        if(state.run?.id&&!['completed','failed','cancelled'].includes(state.run.status))await state.cancel();
        throw error;
      }finally{state.busy=false;state.run=null;changed(state)}
    };
    return state;
  }
  createWebChat.renderControls=(box,state)=>{
    if(!box)return;
    box.replaceChildren();
    if(state.error){const error=document.createElement('p');error.setAttribute('role','alert');error.textContent=state.error;box.append(error)}
    if(!state.busy)return;
    const status=document.createElement('p');status.setAttribute('role','status');
    status.textContent=state.run?.approval?'Review this action. Approval allows it once; it does not grant permanent access.':state.run?.status==='cancelling'?'Cancelling… check records before repeating an action.':'Zuzu is working…';
    box.append(status);
    if(state.run?.approval){
      const pre=document.createElement('pre');pre.textContent=state.run.approval.command;pre.style.cssText='white-space:pre-wrap;overflow-wrap:anywhere;max-height:220px;overflow:auto';box.append(pre);
      const expiry=document.createElement('small');expiry.textContent='Approval expires at '+new Date(state.run.approval.expiresAt).toLocaleTimeString('en-GB');box.append(expiry);
      for(const [label,choice] of [['Approve once','once'],['Deny','deny']]){
        const button=document.createElement('button');button.type='button';button.className='btn';button.textContent=label;button.disabled=state.deciding;button.onclick=()=>state.decide(choice);box.append(button);
      }
    }
    const cancel=document.createElement('button');cancel.type='button';cancel.className='btn secondary';cancel.textContent='Cancel request';cancel.disabled=state.run?.status==='cancelling';cancel.onclick=()=>state.cancel();box.append(cancel);
  };
  if(typeof module!=='undefined'&&module.exports)module.exports=createWebChat;
  else root.createWebChat=createWebChat;
})(globalThis);
