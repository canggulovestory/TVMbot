(function(root){
  'use strict';
  // Correct multiplication noise at decimal half boundaries; match Intl's
  // half-away-from-zero display rounding, including negative adjustments.
  const round=value=>Math.sign(value)*Math.round(Math.abs(value)+Number.EPSILON*Math.abs(value));
  function format(amount,currency='IDR'){
    if(amount===null||amount===undefined||amount==='')return '—';
    currency=currency||'IDR';
    return new Intl.NumberFormat('id-ID',{style:'currency',currency,minimumFractionDigits:currency==='IDR'?0:2,maximumFractionDigits:currency==='IDR'?0:2}).format(Number(amount));
  }
  function totals(txns,stays={},fallback='IDR'){
    const groups=new Map();
    for(const x of txns){
      const currency=String(x.currency||fallback).trim().toUpperCase(),scale=currency==='IDR'?1:100;
      if(!groups.has(currency))groups.set(currency,{currency,income:0,expenses:0,commission:0});
      const group=groups.get(currency),amount=round(Number(x.amount||0)*scale);
      if(x.type==='Income'){group.income+=amount;group.commission+=round(amount*Number(stays[x.tenancyId]?.agencyCommissionPercent||0)/100)}
      else if(x.type==='Expense')group.expenses+=amount;
    }
    if(!groups.size)groups.set(fallback,{currency:fallback,income:0,expenses:0,commission:0});
    return [...groups.values()].sort((a,b)=>a.currency.localeCompare(b.currency)).map(g=>{const scale=g.currency==='IDR'?1:100;return {currency:g.currency,income:g.income/scale,expenses:g.expenses/scale,commission:g.commission/scale,payout:(g.income-g.commission-g.expenses)/scale}});
  }
  if(typeof module!=='undefined'&&module.exports)module.exports={format,totals};
  else root.TVMMoney={format,totals};
})(globalThis);
