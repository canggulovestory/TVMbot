'use strict';
document.getElementById('contract-login').onsubmit=async e=>{
 e.preventDefault();const button=document.getElementById('sign-in'),error=document.getElementById('error');button.disabled=true;error.textContent='';
 try{
  const response=await fetch('/contract/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({password:document.getElementById('password').value})});
  const result=await response.json();if(!response.ok)throw Error(result.error||'Could not sign in.');
  location.replace('/contract');
 }catch(e){error.textContent=e.message;button.disabled=false;}
};
