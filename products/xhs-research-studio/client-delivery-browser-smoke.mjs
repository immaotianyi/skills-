#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

const root=path.dirname(fileURLToPath(import.meta.url));
const dataDir=await fs.mkdtemp(path.join(os.tmpdir(),'xhs-client-delivery-data-'));
const chromeDir=await fs.mkdtemp(path.join(os.tmpdir(),'xhs-client-delivery-chrome-'));
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));

async function freePort(){return new Promise((resolve,reject)=>{const server=net.createServer();server.unref();server.once('error',reject);server.listen(0,'127.0.0.1',()=>{const address=server.address(),port=typeof address==='object'&&address?address.port:0;server.close(error=>error?reject(error):resolve(port))})})}
async function findChrome(){for(const candidate of [process.env.CHROME_BIN,'/usr/bin/google-chrome','/usr/bin/google-chrome-stable','/usr/bin/chromium','/usr/bin/chromium-browser'].filter(Boolean)){try{await fs.access(candidate);return candidate}catch{}}throw new Error('Chrome/Chromium not found')}
async function poll(fn,{attempts=200,delay=50,label='condition',diagnostic=()=>''}={}){let last;for(let i=0;i<attempts;i++){try{const value=await fn();if(value)return value;last=value}catch(error){last=error}await sleep(delay)}throw new Error(`Timed out waiting for ${label}${last instanceof Error?`: ${last.message}`:''}\n${diagnostic()}`)}
function exited(child){return !child||child.exitCode!==null||child.signalCode!==null}
async function terminate(child){if(exited(child))return;const done=new Promise(resolve=>child.once('exit',resolve));child.kill('SIGTERM');await Promise.race([done,sleep(2000)]);if(!exited(child)){child.kill('SIGKILL');await Promise.race([done,sleep(1000)])}}

const port=await freePort(),debugPort=await freePort(),base=`http://127.0.0.1:${port}`,debugBase=`http://127.0.0.1:${debugPort}`;
const signingSecret=crypto.randomBytes(32).toString('hex'),password=`Delivery-${crypto.randomBytes(12).toString('hex')}!`;
const server=spawn(process.execPath,[path.join(root,'server-v3.mjs')],{cwd:root,stdio:['ignore','pipe','pipe'],env:{...process.env,PORT:String(port),HOST:'127.0.0.1',XHS_STUDIO_DATA:dataDir,XHS_STUDIO_HOSTED:'1',XHS_STUDIO_PUBLIC_URL:base,XHS_STUDIO_STRIPE_WEBHOOK_SECRET:signingSecret,XHS_STUDIO_STRIPE_PRICE_PILOT:'price_delivery_pilot',XHS_STUDIO_HARVEST_EXECUTOR:''}});
let serverLogs='';server.stdout.on('data',chunk=>{serverLogs=(serverLogs+chunk.toString()).slice(-16000)});server.stderr.on('data',chunk=>{serverLogs=(serverLogs+chunk.toString()).slice(-16000)});
let chrome,socket,chromeLogs='';
try{
  await poll(async()=>{try{return (await fetch(`${base}/api/health`)).ok}catch{return false}},{label:'hosted server',diagnostic:()=>serverLogs});
  const chromeBin=await findChrome();
  chrome=spawn(chromeBin,['--headless=new','--no-sandbox','--disable-gpu','--disable-dev-shm-usage','--no-first-run','--no-default-browser-check','--remote-debugging-address=127.0.0.1',`--remote-debugging-port=${debugPort}`,`--user-data-dir=${chromeDir}`,'about:blank'],{stdio:['ignore','pipe','pipe']});
  chrome.stdout?.on('data',chunk=>{chromeLogs=(chromeLogs+chunk.toString()).slice(-16000)});chrome.stderr?.on('data',chunk=>{chromeLogs=(chromeLogs+chunk.toString()).slice(-16000)});
  const diagnostic=()=>`server:\n${serverLogs}\nchrome:\n${chromeLogs}`;
  await poll(async()=>{try{return (await fetch(`${debugBase}/json/version`)).ok}catch{return false}},{attempts:300,label:'Chrome DevTools',diagnostic});
  const target=await poll(async()=>{try{const list=await fetch(`${debugBase}/json/list`).then(r=>r.json());return list.find(item=>item.type==='page'&&item.webSocketDebuggerUrl)||false}catch{return false}},{label:'Chrome target',diagnostic});
  socket=new WebSocket(target.webSocketDebuggerUrl);await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('WebSocket timeout')),5000);socket.addEventListener('open',()=>{clearTimeout(timer);resolve()},{once:true});socket.addEventListener('error',()=>{clearTimeout(timer);reject(new Error('WebSocket error'))},{once:true})});
  let id=0;const pending=new Map(),browserErrors=[];
  socket.addEventListener('message',event=>{const message=JSON.parse(event.data);if(message.id&&pending.has(message.id)){const p=pending.get(message.id);pending.delete(message.id);message.error?p.reject(new Error(message.error.message)):p.resolve(message.result||{});return}if(message.method==='Runtime.exceptionThrown')browserErrors.push(message.params?.exceptionDetails?.text||'Runtime.exceptionThrown');if(message.method==='Log.entryAdded'&&message.params?.entry?.level==='error')browserErrors.push(message.params.entry.text)});
  const cdp=(method,params={})=>new Promise((resolve,reject)=>{const next=++id;pending.set(next,{resolve,reject});socket.send(JSON.stringify({id:next,method,params}));setTimeout(()=>{if(pending.has(next)){pending.delete(next);reject(new Error(`CDP timeout: ${method}`))}},8000).unref?.()});
  const evaluate=async expression=>{const result=await cdp('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});if(result.exceptionDetails)throw new Error(result.exceptionDetails.text||'browser evaluate failed');return result.result?.value};
  await cdp('Runtime.enable');await cdp('Log.enable');await cdp('Page.enable');await cdp('Page.navigate',{url:base});
  await poll(()=>evaluate(`document.readyState==='complete'&&!!document.querySelector('#hostedAuthGate')&&!document.querySelector('#hostedAuthGate').hidden`),{label:'auth gate',diagnostic});
  await evaluate(`(()=>{const f=document.querySelector('#hostedAuthForm');document.querySelector('#authRegisterTab').click();f.elements.email.value='delivery-owner@example.test';f.elements.password.value=${JSON.stringify(password)};f.elements.workspaceName.value='Delivery Agency';f.requestSubmit();return true})()`);
  await poll(()=>evaluate(`document.querySelector('#hostedAuthGate').hidden&&!!document.querySelector('#hostedBar')`),{attempts:240,label:'authenticated app',diagnostic});
  const workspaceId=await evaluate(`localStorage.getItem('xhs-studio-workspace')`);assert.ok(workspaceId);

  const event={id:'evt_delivery_checkout',type:'checkout.session.completed',data:{object:{object:'checkout.session',mode:'subscription',payment_status:'paid',client_reference_id:workspaceId,customer:'cus_delivery',subscription:'sub_delivery',metadata:{workspace_id:workspaceId,plan:'pilot'}}}};
  const raw=JSON.stringify(event),timestamp=Math.floor(Date.now()/1000),signature=crypto.createHmac('sha256',signingSecret).update(`${timestamp}.${raw}`).digest('hex');
  const webhook=await fetch(`${base}/api/billing/webhook`,{method:'POST',headers:{'content-type':'application/json','stripe-signature':`t=${timestamp},v1=${signature}`},body:raw});assert.equal(webhook.status,200);
  await cdp('Page.reload',{ignoreCache:true});
  await poll(()=>evaluate(`document.readyState==='complete'&&document.querySelector('#hostedPlan')?.innerText.includes('pilot')`),{attempts:240,label:'active entitlement',diagnostic});

  await evaluate(`document.querySelector('#demoBtn').click();true`);
  await poll(()=>evaluate(`!document.querySelector('#projectView').hidden&&document.querySelectorAll('#topNotes .note').length>=3`),{attempts:280,label:'demo project',diagnostic});
  await poll(()=>evaluate(`!!document.querySelector('#hostedBranding')`),{label:'branding button',diagnostic});
  await evaluate(`document.querySelector('#hostedBranding').click();true`);
  await poll(()=>evaluate(`!!document.querySelector('#brandingForm')`),{label:'branding form',diagnostic});
  await evaluate(`(()=>{const f=document.querySelector('#brandingForm');f.elements.agencyName.value='North Star Agency';f.elements.reportTitle.value='Client Intelligence Brief';f.elements.accentColor.value='#0055aa';f.elements.footerText.value='Confidential client delivery';f.requestSubmit();return true})()`);
  await poll(()=>evaluate(`document.querySelector('#brandingStatus')?.innerText.includes('已保存')`),{label:'branding save',diagnostic});

  await poll(()=>evaluate(`!!document.querySelector('#hostedClientDelivery')`),{label:'client delivery button',diagnostic});
  await evaluate(`document.querySelector('#hostedClientDelivery').click();true`);
  await poll(()=>evaluate(`!!document.querySelector('#clientDeliveryCsv')&&document.querySelector('#hostedPanel').innerText.includes('品牌化客户交付')`),{label:'client delivery panel',diagnostic});
  await evaluate(`document.querySelector('#clientDeliveryCsv').click();true`);
  await poll(()=>evaluate(`document.querySelector('#clientDeliveryStatus')?.innerText.includes('品牌化 CSV 已生成')`),{label:'client CSV generation',diagnostic});
  await evaluate(`document.querySelector('#clientDeliveryEvidence').click();true`);
  await poll(()=>evaluate(`document.querySelector('#clientDeliveryStatus')?.innerText.includes('Evidence Delivery 已生成')`),{label:'evidence delivery generation',diagnostic});
  await evaluate(`document.querySelector('#clientDeliveryPrint').click();true`);
  await poll(()=>evaluate(`document.querySelector('#clientDeliveryStatus')?.innerText.includes('打印版 HTML 已生成')`),{label:'print HTML generation',diagnostic});

  const delivery=await evaluate(`(async()=>{const projects=await fetch('/api/projects').then(r=>r.json());const project=(projects.projects||[]).find(p=>/Demo/.test(p.name));if(!project)throw new Error('demo project missing');const detail=await fetch('/api/projects/'+project.id).then(r=>r.json()),latest=detail.snapshots.at(-1);const [snapshot,branding,report,packResponse,module]=await Promise.all([fetch('/api/projects/'+project.id+'/snapshots/'+latest.id).then(r=>r.json()),fetch('/api/workspaces/${workspaceId}/branding').then(r=>r.json()),fetch('/api/projects/'+project.id+'/report').then(r=>r.text()),fetch('/api/projects/'+project.id+'/evidence-pack?version=1.2'),import('/client-delivery-model.js')]);const pack=await packResponse.json(),authenticated=packResponse.headers.get('x-xhs-evidence-pack-authenticated')==='true';const csv=module.buildClientDeliveryCsv({project,snapshot,branding:branding.branding});const envelope=module.buildEvidenceDelivery({project,snapshot,branding:branding.branding,evidencePack:pack,verification:{ok:true,authenticated,checksumOnly:!authenticated&&pack.integrity?.algorithm==='sha256'}});const html=module.buildClientDeliveryHtml({project,snapshot,branding:branding.branding,markdown:report});return{csv,envelope,html}})()`);
  assert.match(delivery.csv,/North Star Agency/u);assert.match(delivery.csv,/Client Intelligence Brief/u);assert.match(delivery.csv,/noteId,title,author/u);assert.match(delivery.csv,/,demo1,/u);assert.match(delivery.csv,/initial_state/u);assert.match(delivery.csv,/https?:\/\//u);
  assert.equal(delivery.envelope.schemaVersion,'xhs-client-evidence-delivery/1.0');assert.equal(delivery.envelope.delivery.canonicalEvidencePackUnmodified,true);assert.equal(delivery.envelope.delivery.envelopeAuthenticated,false);assert.equal(delivery.envelope.evidencePack.schemaVersion,'xhs-evidence-pack/1.2');
  assert.match(delivery.html,/North Star Agency/u);assert.match(delivery.html,/Client Intelligence Brief/u);assert.match(delivery.html,/--accent:#0055aa/u);assert.match(delivery.html,/Content-Security-Policy/u);assert.match(delivery.html,/not population prevalence/u);assert.doesNotMatch(delivery.html,/<script/u);
  await sleep(150);assert.deepEqual(browserErrors,[],`browser errors: ${browserErrors.join(' | ')}`);
  console.log(JSON.stringify({ok:true,chrome:path.basename(chromeBin),workspaceId,clientDelivery:true,canonicalPackVersion:delivery.envelope.evidencePack.schemaVersion,browserErrors},null,2));
}finally{
  try{socket?.close()}catch{}
  await terminate(chrome);await terminate(server);
  await Promise.all([fs.rm(dataDir,{recursive:true,force:true,maxRetries:5,retryDelay:100}),fs.rm(chromeDir,{recursive:true,force:true,maxRetries:5,retryDelay:100})]);
}
