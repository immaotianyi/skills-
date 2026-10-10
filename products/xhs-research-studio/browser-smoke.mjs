#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

const root=path.dirname(fileURLToPath(import.meta.url));
const dataDir=await fs.mkdtemp(path.join(os.tmpdir(),'xhs-browser-data-'));
const chromeDir=await fs.mkdtemp(path.join(os.tmpdir(),'xhs-browser-profile-'));
const port=57000+Math.floor(Math.random()*400);
const debugPort=58000+Math.floor(Math.random()*400);
const base=`http://127.0.0.1:${port}`;
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));

async function findChrome() {
  const candidates=[
    process.env.CHROME_BIN,
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
  ].filter(Boolean);
  for(const candidate of candidates) {
    try { await fs.access(candidate); return candidate; } catch {}
  }
  throw new Error(`Chrome/Chromium not found. Tried: ${candidates.join(', ')}`);
}

async function poll(fn,{attempts=100,delay=50,label='condition'}={}) {
  let last;
  for(let i=0;i<attempts;i++) {
    try {
      const value=await fn();
      if(value) return value;
      last=value;
    } catch(err) { last=err; }
    await sleep(delay);
  }
  throw new Error(`Timed out waiting for ${label}${last instanceof Error?`: ${last.message}`:''}`);
}

const server=spawn(process.execPath,[path.join(root,'server.mjs')],{
  env:{...process.env,PORT:String(port),XHS_STUDIO_DATA:dataDir},
  stdio:['ignore','pipe','pipe'],
});
let chrome;
let socket;
try {
  await poll(async()=>{
    try{return (await fetch(`${base}/api/health`)).ok}catch{return false}
  },{label:'Studio health'});

  const chromeBin=await findChrome();
  chrome=spawn(chromeBin,[
    '--headless=new',
    '--no-sandbox',
    '--disable-gpu',
    '--disable-dev-shm-usage',
    '--no-first-run',
    '--no-default-browser-check',
    `--remote-debugging-port=${debugPort}`,
    `--user-data-dir=${chromeDir}`,
    'about:blank',
  ],{stdio:['ignore','pipe','pipe']});

  const target=await poll(async()=>{
    try {
      const list=await fetch(`http://127.0.0.1:${debugPort}/json/list`).then(r=>r.json());
      return list.find(x=>x.type==='page'&&x.webSocketDebuggerUrl)||false;
    } catch { return false; }
  },{label:'Chrome DevTools target'});

  socket=new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve,reject)=>{
    socket.addEventListener('open',resolve,{once:true});
    socket.addEventListener('error',reject,{once:true});
  });

  let nextId=0;
  const pending=new Map();
  const browserErrors=[];
  socket.addEventListener('message',event=>{
    const msg=JSON.parse(event.data);
    if(msg.id&&pending.has(msg.id)) {
      const {resolve,reject}=pending.get(msg.id);
      pending.delete(msg.id);
      if(msg.error) reject(new Error(`${msg.error.code}: ${msg.error.message}`));
      else resolve(msg.result||{});
      return;
    }
    if(msg.method==='Runtime.exceptionThrown') browserErrors.push(msg.params?.exceptionDetails?.text||'Runtime.exceptionThrown');
    if(msg.method==='Log.entryAdded'&&['error','warning'].includes(msg.params?.entry?.level)) browserErrors.push(`${msg.params.entry.level}: ${msg.params.entry.text}`);
  });

  const cdp=(method,params={})=>new Promise((resolve,reject)=>{
    const id=++nextId;
    pending.set(id,{resolve,reject});
    socket.send(JSON.stringify({id,method,params}));
    setTimeout(()=>{
      if(pending.has(id)) {
        pending.delete(id);
        reject(new Error(`CDP timeout: ${method}`));
      }
    },5000).unref?.();
  });
  const evaluate=async expression=>{
    const response=await cdp('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});
    if(response.exceptionDetails) throw new Error(response.exceptionDetails.text||'browser evaluation failed');
    return response.result?.value;
  };

  await cdp('Runtime.enable');
  await cdp('Log.enable');
  await cdp('Page.enable');
  await cdp('Page.navigate',{url:base});
  await poll(()=>evaluate(`document.readyState==='complete'&&!!document.querySelector('#demoBtn')`),{label:'page ready'});
  const templateCount=await poll(async()=>{
    const count=await evaluate(`document.querySelectorAll('.template').length`);
    return count>=3?count:false;
  },{label:'templates rendered'});

  await evaluate(`document.querySelector('#demoBtn').click(); true`);
  const rendered=await poll(async()=>{
    return await evaluate(`!document.querySelector('#projectView').hidden && document.querySelectorAll('#topNotes .note').length>=3`);
  },{attempts:160,delay:50,label:'demo project render'});
  assert.equal(rendered,true);

  const metrics=await evaluate(`document.querySelector('#metrics').innerText`);
  assert.match(metrics,/笔记/);
  assert.match(metrics,/评论/);
  const sourceProtocolsOk=await evaluate(`Array.from(document.querySelectorAll('a[href]')).every(a=>['http:','https:'].includes(new URL(a.href).protocol))`);
  assert.equal(sourceProtocolsOk,true);

  await evaluate(`document.querySelector('.tabs button[data-tab="report"]').click(); true`);
  const reportReady=await poll(()=>evaluate(`document.querySelector('#reportText').textContent.includes('Methodology / interpretation limits')`),{attempts:120,delay:50,label:'client report render'});
  assert.equal(reportReady,true);

  await sleep(100);
  assert.deepEqual(browserErrors,[],`browser errors: ${browserErrors.join(' | ')}`);
  console.log(JSON.stringify({
    ok:true,
    chrome:path.basename(chromeBin),
    templateCount,
    topNotes:await evaluate(`document.querySelectorAll('#topNotes .note').length`),
    clusters:await evaluate(`document.querySelectorAll('.clusterBtn').length`),
    reportReady,
    browserErrors,
  },null,2));
} finally {
  try { socket?.close(); } catch {}
  chrome?.kill('SIGTERM');
  server.kill('SIGTERM');
  await Promise.all([
    fs.rm(dataDir,{recursive:true,force:true}),
    fs.rm(chromeDir,{recursive:true,force:true}),
  ]);
}
