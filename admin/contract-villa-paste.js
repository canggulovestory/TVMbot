'use strict';
// Runs locally in the browser; only explicit property details become candidates.
function parseVillaDetails(text){
 const aliases={
  'villa name':'name','property name':'name','nama villa':'name','nama vila':'name','name':'name',
  'property code':'code','villa code':'code','kode villa':'code','code':'code',
  'property address':'address','villa address':'address','address':'address','alamat':'address',
  'bedrooms':'bedrooms','bedroom':'bedrooms','beds':'bedrooms','kamar tidur':'bedrooms',
  'bathrooms':'bathrooms','bathroom':'bathrooms','baths':'bathrooms','kamar mandi':'bathrooms',
  'map link':'map_url','google maps':'map_url','map url':'map_url','map':'map_url','location link':'map_url'
 };
 const names=Object.keys(aliases).join('|'),result={};
 const normalized=String(text||'').slice(0,20000).replace(/\r/g,'').replace(new RegExp('[,;]\\s*(?=(?:'+names+')\\s*[:=])','gi'),'\n');
 const lines=normalized.split('\n').map(line=>line.trim().replace(/^[•*]\s*/,''));
 const label=new RegExp('^('+names+')\\s*(?::|=|[–—-])\\s*(.+)$','i');
 const mapUrl=value=>{try{const u=new URL(value);return ['http:','https:'].includes(u.protocol)&&!u.username&&!u.password;}catch{return false;}};
 for(const line of lines){
  const match=line.match(label);if(!match)continue;
  const key=aliases[match[1].toLowerCase()],value=match[2].trim();
  if(key==='bedrooms'||key==='bathrooms'){
   const count=value.match(/^(\d{1,3})(?:\s+(?:bedrooms?|bathrooms?|beds?|baths?|kamar(?: tidur| mandi)?))?$/i);
   if(count&&Number(count[1])>=1&&Number(count[1])<=100)result['property.'+key]=String(Number(count[1]));
  }else if(value.length<=(key==='address'?2000:300)&&(key!=='map_url'||mapUrl(value)))result['property.'+key]=value;
 }
 if(!result['property.name']&&/^villa\s+\S/i.test(lines[0]||'')&&!/[:=]/.test(lines[0])&&lines[0].length<=100)result['property.name']=lines[0];
 if(!result['property.address']){
  const address=lines.find(line=>/^(?:jl\.?|jalan)\s+\S/i.test(line));
  if(address&&address.length<=2000)result['property.address']=address;
 }
 for(const [key,words] of [['bedrooms','bedrooms?|beds?|br|kamar tidur'],['bathrooms','bathrooms?|baths?|kamar mandi']]){
  if(result['property.'+key])continue;
  const counts=[...normalized.matchAll(new RegExp('\\b(\\d{1,3})\\s*(?:'+words+')\\b','gi'))].map(match=>Number(match[1]));
  if(counts.length&&new Set(counts).size===1&&counts[0]>=1&&counts[0]<=100)result['property.'+key]=String(counts[0]);
 }
 if(!result['property.map_url']){
  const urls=normalized.match(/https?:\/\/[^\s<>]+/gi)||[];
  const maps=urls.map(url=>url.replace(/[),.;]+$/,'')).filter(url=>mapUrl(url)&&/^(?:maps\.app\.goo\.gl|maps\.google\.[a-z.]+|goo\.gl)$|^(?:www\.)?google\.[a-z.]+$/.test(new URL(url).hostname)&&(/maps|goo\.gl/.test(url)));
  if(new Set(maps).size===1&&maps[0].length<=300)result['property.map_url']=maps[0];
 }
 return result;
}
if(typeof module!=='undefined')module.exports={parseVillaDetails};
