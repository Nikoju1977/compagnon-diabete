'use strict';
/* DAPHNEE OMNI: browser integration using synthetic observations and real Web Crypto. Harness adapted from NikoAssist and OpenVita, Studio Niko Design. */
// SPDX-License-Identifier: GPL-3.0-or-later
const assert=require('node:assert/strict');
const {spawn,execFileSync}=require('node:child_process');
const fs=require('node:fs/promises');
const os=require('node:os');
const path=require('node:path');

const root=path.resolve(__dirname,'..');
const port=19489,base='http://127.0.0.1:'+port;
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function poll(fn,label,timeout=20000){
 const start=Date.now();let error;
 while(Date.now()-start<timeout){
  try{const result=await fn();if(result)return result;}catch(e){error=e;}
  await sleep(120);
 }
 throw new Error('Timeout '+label+(error?': '+error.message:''));
}
function chromeBinary(){
 if(process.env.CHROME_BIN)return process.env.CHROME_BIN;
 for(const candidate of ['google-chrome','google-chrome-stable','chromium','chromium-browser']){
  try{return execFileSync('which',[candidate],{encoding:'utf8'}).trim();}catch{}
 }
 throw Error('Chromium non disponible sur ce runner.');
}
async function main(){
 let server,chrome,ws;const pending=new Map(),browserErrors=[],httpPosts=[];
 const tmp=await fs.mkdtemp(path.join(os.tmpdir(),'daphnee-browser-'));
 let seq=0,diagnostics='';
 try{
  server=spawn('python3',['-m','http.server',String(port),'--bind','127.0.0.1','--directory','.'],{
   cwd:root,stdio:['ignore','ignore','pipe']
  });
  server.stderr.on('data',chunk=>diagnostics+=String(chunk).slice(-1000));
  await poll(async()=>{const r=await fetch(base+'/');return r.status===200},'local web server');
  chrome=spawn(chromeBinary(),['--headless=new','--no-sandbox','--disable-gpu','--disable-dev-shm-usage',
   '--no-first-run','--no-default-browser-check','--disable-background-networking',
   '--remote-debugging-port=0','--remote-allow-origins=*',
   '--user-data-dir='+path.join(tmp,'chrome'),'about:blank'],{stdio:['ignore','ignore','pipe']});
  chrome.stderr.on('data',chunk=>diagnostics+=String(chunk).slice(-1000));
  const debuggerPort=await poll(async()=>{
   const raw=await fs.readFile(path.join(tmp,'chrome','DevToolsActivePort'),'utf8');
   return Number(raw.split('\n')[0]);
  },'Chrome DevTools');
  const tabs=await(await fetch('http://127.0.0.1:'+debuggerPort+'/json/list')).json();
  const tab=tabs.find(x=>x.type==='page');
  assert.ok(tab?.webSocketDebuggerUrl,'Chrome debugger page missing');
  ws=new WebSocket(tab.webSocketDebuggerUrl);
  await new Promise((resolve,reject)=>{
   ws.addEventListener('open',resolve,{once:true});ws.addEventListener('error',reject,{once:true});
  });
  ws.addEventListener('message',event=>{
   const msg=JSON.parse(event.data);
   if(msg.method==='Runtime.exceptionThrown')browserErrors.push(msg.params?.exceptionDetails?.exception?.description||'Browser exception');
   if(msg.method==='Network.requestWillBeSent'&&msg.params?.request?.method==='POST')httpPosts.push(msg.params.request.url);
   if(!msg.id||!pending.has(msg.id))return;
   const p=pending.get(msg.id);pending.delete(msg.id);
   msg.error?p.reject(Error(JSON.stringify(msg.error))):p.resolve(msg.result);
  });
  function call(method,params={}){
   const id=++seq;
   return new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>{pending.delete(id);reject(Error('DevTools timeout '+method));},12000);
    pending.set(id,{resolve:v=>{clearTimeout(timer);resolve(v);},reject:e=>{clearTimeout(timer);reject(e);}});
    ws.send(JSON.stringify({id,method,params}));
   });
  }
  async function evaluate(expression){
   const out=await call('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});
   if(out.exceptionDetails)throw Error('Browser JS: '+(out.exceptionDetails.exception?.description||out.exceptionDetails.text));
   return out.result?.value;
  }
  const wait=(expression,label)=>poll(()=>evaluate(expression),label,15000);
  await call('Page.enable');await call('Runtime.enable');await call('Network.enable');
  await call('Page.navigate',{url:base+'/'});
  const pass='daphnee-synthetic-test-only',wrong='wrong-daphnee-test-only';
  const expr=(fn,...args)=>'('+fn.toString()+')('+args.map(x=>JSON.stringify(x)).join(',')+')';
  const perform=(fn,...args)=>evaluate(expr(fn,...args));
  const ready=()=>wait('document.readyState==="complete"&&document.querySelector("#entry-count")?.textContent.includes("observation")','journal initialized');
  const idle=()=>wait('!document.querySelector("#export-journal").disabled','operation finished');
  const count=()=>evaluate('document.querySelectorAll("#entries li").length');
  const status=()=>evaluate('document.querySelector("#journal-status").textContent');
  const history=()=>evaluate('document.querySelector("#entries").textContent');
  async function add(value,unit,note,date='2026-11-25T10:00'){
    await perform((v,u,n,d)=>{document.querySelector('#reading').value=v;document.querySelector('#unit').value=u;document.querySelector('#note').value=n;document.querySelector('#observed').value=d;document.querySelector('#entry-form').requestSubmit()},value,unit,note,date);
  }
  async function exportBackup(p,q=p){
    await perform((p,q)=>{document.querySelector('#secret').value=p;document.querySelector('#secret-confirm').value=q;document.querySelector('#export-journal').click()},p,q);await idle();
  }
  async function restore(text,p,accept=true){
    await perform((text,p,accept)=>{window.confirm=()=>accept;const dt=new DataTransfer();dt.items.add(new File([text],'synthetic.json',{type:'application/json'}));document.querySelector('#import-journal').files=dt.files;document.querySelector('#secret').value=p;document.querySelector('#restore-journal').click()},text,p,accept);await idle();
  }
  await ready();assert.equal(await count(),0);
  assert.equal(await evaluate('isSecureContext&&!!crypto.subtle'),true);
  await add('120','','invalid-unit');assert.equal(await count(),0);
  await add('120','mg/dL','SYNTHETIC_DAPHNEE_ONLY');
  await add('6.5','mmol/L','<img src=x onerror=alert(1)>','2026-11-25T11:00');
  assert.equal(await count(),2);assert.equal(await evaluate('document.querySelectorAll("#entries img").length'),0);
  assert.match(await history(),/<img src=x onerror=alert\(1\)>/);
  await perform(()=>{const f=document.querySelector('#filter-unit');f.value='mg/dL';f.dispatchEvent(new Event('change'))});
  assert.equal(await count(),1);assert.match(await history(),/120 mg\/dL/);
  await perform(()=>{document.querySelector('#entries button').click();document.querySelector('#reading').value='121';document.querySelector('#entry-form').requestSubmit()});
  assert.match(await history(),/121 mg\/dL/);
  await perform(()=>{const f=document.querySelector('#filter-unit');f.value='';f.dispatchEvent(new Event('change'));const orig=URL.createObjectURL.bind(URL);URL.createObjectURL=b=>{window.__qaBlob=b;return orig(b)};localStorage.setItem('qa-unrelated-key','keep')});
  const snapshot=await history();
  await exportBackup(pass,wrong);assert.match(await status(),/diffèrent/);assert.equal(await evaluate('!!window.__qaBlob'),false);
  await exportBackup(pass);const backup=await evaluate('window.__qaBlob.text()'),env=JSON.parse(backup);
  assert.equal(env.format,'daphnee-journal-v1');assert.equal(Buffer.from(env.salt,'base64').length,16);assert.equal(Buffer.from(env.iv,'base64').length,12);
  assert.ok(!backup.includes('SYNTHETIC_DAPHNEE_ONLY')&&!backup.includes(pass));
  assert.equal(await evaluate('document.querySelector("#secret").value+document.querySelector("#secret-confirm").value'),'');
  await perform(()=>{window.confirm=()=>true;document.querySelector('#entries li button:last-child').click()});assert.equal(await count(),1);
  await restore(backup,wrong);assert.equal(await count(),1);assert.match(await status(),/incorrecte|altéré/);
  const corrupt=JSON.parse(backup),bytes=Buffer.from(corrupt.ciphertext,'base64');bytes[0]^=1;corrupt.ciphertext=bytes.toString('base64');
  await restore(JSON.stringify(corrupt),pass);assert.equal(await count(),1);assert.match(await status(),/altéré/);
  await restore(backup,pass,false);assert.equal(await count(),1);assert.match(await status(),/annulée/);
  await restore(backup,pass);assert.equal(await count(),2);assert.equal(await history(),snapshot);
  assert.equal(await evaluate('Object.keys(localStorage).some(k=>String(localStorage.getItem(k)).includes("SYNTHETIC_DAPHNEE_ONLY"))'),false);
  await call('Page.navigate',{url:base+'/?reload=1'});await ready();assert.equal(await count(),0,'In-memory journal deliberately resets on reload');
  await restore(backup,pass);assert.equal(await history(),snapshot);
  await perform(()=>{window.confirm=()=>true;document.querySelector('#clear-journal').click()});assert.equal(await count(),0);
  assert.equal(await evaluate('localStorage.getItem("qa-unrelated-key")'),'keep');
  await call('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:3,mobile:true});
  assert.equal(await evaluate('(()=>{const b=document.querySelector("#add-entry").getBoundingClientRect();return b.left>=0&&b.right<=innerWidth+1&&b.height>=40})()'),true);
  assert.deepEqual(browserErrors,[],'Uncaught JS errors');assert.deepEqual(httpPosts,[],'No POST for journal operations');
  console.log('DAPHNEE CHROMIUM PASS: explicit units, edit/filter/delete, escaped notes, real encrypted export, password mismatch, wrong password, tamper, cancel, restore, memory-only reload, scoped clear, mobile viewport, no POST');
 }catch(error){
  throw Error(error.message+(diagnostics?'\nBrowser diagnostics: '+diagnostics.slice(-1000):''));
 }finally{
  try{ws?.close();}catch{}
  try{chrome?.kill('SIGKILL');}catch{}
  try{server?.kill('SIGTERM');}catch{}
  await sleep(300);
  await fs.rm(tmp,{recursive:true,force:true,maxRetries:6,retryDelay:200}).catch(()=>{});
 }
}
main().catch(e=>{console.error(e.stack||e);process.exitCode=1;});
