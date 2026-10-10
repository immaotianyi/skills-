#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

const root=path.dirname(fileURLToPath(import.meta.url));
const dataDir=await fs.mkdtemp(path.join(os.tmpdir(),'xhs-hosted-browser-data-'));
const chromeDir=await fs.mkdtemp(path.join(os.tmpdir(),'xhs-hosted-browser-profile-'));
const port=57450+Math.floor(Math.random()*200),debugPort=58450+Math.floor(Math.random()*200);
const base=`http://127.0.0.1:${port}`,debugBase=`http://127.0.0.1:${debugPort}`;
const signingSecret=crypto.randomBytes(32).toString('hex');
const password=`Browser-${crypto.randomBytes(12).toString('hex')}!`;
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));

async function findChrome(){for(const candidate of [process.env.CHROME_BIN,'/usr/bin/google-chrome','/usr/bin/google-chrome-stable','/usr/bin/chromium','/usr/bin/chromium-browser'].filter(Boolean)){try{await fs.access(candidate);return candidate}catch{}}throw new Error('Chrome/Chromium not found')}
async function poll(fn,{attempts=160,delay=50,label='condition',diagnostic=()=>''}={}){let last;for(let i=0;i<attempts;i++){try{const value=await fn();if(value)return value;last=value}catch(error){last=error}await sleep(delay)}throw new Error(`Timed out waiting for ${label}${last instanceof Error?`: ${last.message}`:''}\n${diagnostic()}`)}
function exited(child){return !child||child.exitCode!==null||child.signalCode!==null}
async function terminate(child){if(exited(child))return;const done=new Promise(resolve=>child.once('exit',resolve));child.kill('SIGTERM');await Promise.race([done,sleep(2000)]);if(!exited(child))child.kill('SIGKILL')}

const server=spawn(process.execPath,[path.join(root,'server-v3.mjs')],{cwd:root,stdio:['ignore','pipe','pipe'],env:{...process.env,PORT:String(port),HOST:'127.0.0.1',XHS_STUDIO_DATA:dataDir,XHS_STUDIO_HOSTED:'1',XHS_STUDIO_PUBLIC_URL:base,XHS_STUDIO_STRIPE_WEBHOOK_SECRET:signingSecret,XHS_STUDIO_STRIPE_PRICE_PILOT:'price_browser_pilot',XHS_STUDIO_HARVEST_EXECUTOR:'',XHS_STUDIO_SYNTHESIS_EXECUTOR:process.execPath,XHS_STUDIO_SYNTHESIS_EXECUTOR_ARGS:JSON.stringify([path.join(root,'test','fixtures','mock-synthesis-executor.mjs')])}});
let serverLogs='';server.stdout.on('data',c=>{serverLogs=(serverLogs+c.toString()).slice(-16000)});server.stderr.on('data',c=>{serverLogs=(serverLogs+c.toString()).slice(-16000)});
let chrome,socket,chromeLogs='';
try{
  await poll(async()=>{try{return (await fetch(`${base}/api/health`)).ok}catch{return false}},{attempts:200,label:'hosted server',diagnostic:()=>serverLogs});
  const chromeBin=await findChrome();
  chrome=spawn(chromeBin,['--headless=new','--no-sandbox','--disable-gpu','--disable-dev-shm-usage','--no-first-run','--no-default-browser-check','--remote-debugging-address=127.0.0.1',`--remote-debugging-port=${debugPort}`,`--user-data-dir=${chromeDir}`,'about:blank'],{stdio:['ignore','pipe','pipe']});
  chrome.stdout?.on('data',c=>{chromeLogs=(chromeLogs+c.toString()).slice(-16000)});chrome.stderr?.on('data',c=>{chromeLogs=(chromeLogs+c.toString()).slice(-16000)});
  const diagnostic=()=>`server:\n${serverLogs}\nchrome:\n${chromeLogs}`;
  await poll(async()=>{try{const r=await fetch(`${debugBase}/json/version`);return r.ok}catch{return false}},{attempts:300,label:'Chrome DevTools',diagnostic});
  const target=await poll(async()=>{try{const list=await fetch(`${debugBase}/json/list`).then(r=>r.json());return list.find(x=>x.type==='page'&&x.webSocketDebuggerUrl)||false}catch{return false}},{label:'Chrome page target',diagnostic});
  socket=new WebSocket(target.webSocketDebuggerUrl);await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('WebSocket timeout')),5000);socket.addEventListener('open',()=>{clearTimeout(timer);resolve()},{once:true});socket.addEventListener('error',()=>{clearTimeout(timer);reject(new Error('WebSocket error'))},{once:true})});
  let id=0;const pending=new Map(),browserErrors=[];
  socket.addEventListener('message',event=>{const msg=JSON.parse(event.data);if(msg.id&&pending.has(msg.id)){const p=pending.get(msg.id);pending.delete(msg.id);msg.error?p.reject(new Error(msg.error.message)):p.resolve(msg.result||{});return}if(msg.method==='Runtime.exceptionThrown')browserErrors.push(msg.params?.exceptionDetails?.text||'Runtime.exceptionThrown');if(msg.method==='Log.entryAdded'&&msg.params?.entry?.level==='error')browserErrors.push(msg.params.entry.text)});
  const cdp=(method,params={})=>new Promise((resolve,reject)=>{const next=++id;pending.set(next,{resolve,reject});socket.send(JSON.stringify({id:next,method,params}));setTimeout(()=>{if(pending.has(next)){pending.delete(next);reject(new Error(`CDP timeout: ${method}`))}},8000).unref?.()});
  const evaluate=async expression=>{const result=await cdp('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});if(result.exceptionDetails)throw new Error(result.exceptionDetails.text||'browser evaluate failed');return result.result?.value};
  await cdp('Runtime.enable');await cdp('Log.enable');await cdp('Page.enable');await cdp('Page.navigate',{url:base});
  await poll(()=>evaluate(`document.readyState==='complete'&&!!document.querySelector('#hostedAuthGate')&&!document.querySelector('#hostedAuthGate').hidden`),{label:'hosted auth gate',diagnostic});
  assert.equal(await evaluate(`document.querySelectorAll('.template').length`),0,'main app must not start before hosted authentication');

  await evaluate(`(()=>{const f=document.querySelector('#hostedAuthForm');document.querySelector('#authRegisterTab').click();f.elements.email.value='browser-owner@example.test';f.elements.password.value=${JSON.stringify(password)};f.elements.workspaceName.value='Browser Agency';f.requestSubmit();return true})()`);
  await poll(()=>evaluate(`document.querySelector('#hostedAuthGate').hidden&&document.querySelector('#hostedBar')&&document.querySelectorAll('.template').length>=3`),{attempts:240,label:'authenticated hosted app',diagnostic});
  const workspaceId=await evaluate(`localStorage.getItem('xhs-studio-workspace')`);assert.ok(workspaceId);
  assert.match(await evaluate(`document.querySelector('#hostedPlan').innerText`),/unpaid.*inactive/u);

  const event={id:'evt_browser_checkout',type:'checkout.session.completed',data:{object:{object:'checkout.session',mode:'subscription',payment_status:'paid',client_reference_id:workspaceId,customer:'cus_browser',subscription:'sub_browser',metadata:{workspace_id:workspaceId,plan:'pilot'}}}};
  const raw=JSON.stringify(event),t=Math.floor(Date.now()/1000),sig=crypto.createHmac('sha256',signingSecret).update(`${t}.${raw}`).digest('hex');
  const webhook=await fetch(`${base}/api/billing/webhook`,{method:'POST',headers:{'content-type':'application/json','stripe-signature':`t=${t},v1=${sig}`},body:raw});assert.equal(webhook.status,200);
  await cdp('Page.reload',{ignoreCache:true});
  await poll(()=>evaluate(`document.readyState==='complete'&&document.querySelector('#hostedPlan')?.innerText.includes('pilot')&&document.querySelector('#hostedPlan')?.innerText.includes('active')`),{attempts:240,label:'active hosted entitlement after reload',diagnostic});

  await evaluate(`document.querySelector('#demoBtn').click();true`);
  await poll(()=>evaluate(`!document.querySelector('#projectView').hidden&&document.querySelectorAll('#topNotes .note').length>=3`),{attempts:280,label:'hosted demo project render',diagnostic});
  assert.match(await evaluate(`document.querySelector('#projectName').innerText`),/Demo/);

  await poll(()=>evaluate(`!!document.querySelector('#hostedPortfolio')`),{label:'hosted portfolio button',diagnostic});
  await evaluate(`document.querySelector('#hostedPortfolio').click();true`);
  await poll(()=>evaluate(`document.querySelector('#hostedPanel').innerText.includes('Portfolio')&&document.querySelector('#hostedPanel').innerText.includes('Demo')&&document.querySelector('#hostedPanel').innerText.includes('有快照')`),{attempts:240,label:'agency portfolio panel',diagnostic});
  assert.equal(await evaluate(`document.querySelectorAll('#portfolioRows [data-portfolio-project]').length>=1`),true);

  await poll(()=>evaluate(`!!document.querySelector('#hostedBranding')`),{label:'hosted branding button',diagnostic});
  await evaluate(`document.querySelector('#hostedBranding').click();true`);
  await poll(()=>evaluate(`!!document.querySelector('#brandingForm')&&document.querySelector('#hostedPanel').innerText.includes('客户报告品牌')`),{attempts:240,label:'branding editor',diagnostic});
  await evaluate(`(()=>{const f=document.querySelector('#brandingForm');f.elements.agencyName.value='North Star Agency';f.elements.reportTitle.value='Client Intelligence Brief';f.elements.accentColor.value='#0055aa';f.elements.footerText.value='Confidential client delivery';f.requestSubmit();return true})()`);
  await poll(()=>evaluate(`document.querySelector('#brandingStatus')?.innerText.includes('已保存')&&document.querySelector('#brandingPreview')?.innerText.includes('North Star Agency')&&document.querySelector('#brandingPreview')?.innerText.includes('Client Intelligence Brief')`),{attempts:240,label:'saved branding preview',diagnostic});
  const brandedShare=await evaluate(`(async()=>{const projects=await fetch('/api/projects').then(r=>r.json());const project=(projects.projects||[]).find(p=>/Demo/.test(p.name))||projects.projects?.[0];if(!project)throw new Error('no project for branded share');const created=await fetch('/api/workspaces/${workspaceId}/shares',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({projectId:project.id})});if(!created.ok)throw new Error('share create '+created.status+': '+await created.text());const payload=await created.json();const response=await fetch(payload.share.url);const html=await response.text();return{status:response.status,cache:response.headers.get('cache-control'),csp:response.headers.get('content-security-policy'),html}})()`);
  assert.equal(brandedShare.status,200);
  assert.match(brandedShare.cache||'',/no-store/u);
  assert.match(brandedShare.csp||'',/frame-ancestors 'none'/u);
  assert.match(brandedShare.html,/North Star Agency/u);
  assert.match(brandedShare.html,/Client Intelligence Brief/u);
  assert.match(brandedShare.html,/Confidential client delivery/u);
  assert.match(brandedShare.html,/--accent:#0055aa/u);
  assert.match(brandedShare.html,/Demo/u);

  await evaluate(`document.querySelector('#hostedProjectActions').click();true`);
  await poll(()=>evaluate(`!!document.querySelector('#hostedSynthesis')&&!document.querySelector('#hostedSynthesis').disabled`),{label:'hosted project action panel',diagnostic});
  assert.equal(await evaluate(`!!document.querySelector('#hostedShare')&&!document.querySelector('#hostedShare').disabled`),true);
  await evaluate(`document.querySelector('#hostedSynthesis').click();true`);
  await poll(()=>evaluate(`document.querySelector('#hostedPanel').innerText.includes('CI grounded synthesis')&&document.querySelector('#hostedPanel').innerText.includes('note:')`),{attempts:240,label:'browser grounded synthesis',diagnostic});

  await evaluate(`document.querySelector('#hostedAccount').click();true`);
  await poll(()=>evaluate(`document.querySelector('#hostedPanel').innerText.includes('pilot / active')&&!!document.querySelector('#hostedPortal')`),{label:'hosted billing controls',diagnostic});
  await sleep(150);
  assert.deepEqual(browserErrors,[],`browser errors: ${browserErrors.join(' | ')}`);
  console.log(JSON.stringify({ok:true,chrome:path.basename(chromeBin),workspaceId,hostedPlan:await evaluate(`document.querySelector('#hostedPlan').innerText`),topNotes:await evaluate(`document.querySelectorAll('#topNotes .note').length`),agencyPortfolio:true,whiteLabelShare:true,groundedSynthesis:true,billingPortalVisible:true,browserErrors},null,2));
}finally{
  try{socket?.close()}catch{}
  await terminate(chrome);await terminate(server);
  await Promise.all([fs.rm(dataDir,{recursive:true,force:true,maxRetries:5,retryDelay:100}),fs.rm(chromeDir,{recursive:true,force:true,maxRetries:5,retryDelay:100})]);
}
