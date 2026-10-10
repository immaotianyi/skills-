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
const debugBase=`http://127.0.0.1:${debugPort}`;
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

async function poll(fn,{attempts=100,delay=50,label='condition',diagnostic=()=>''}={}) {
  let last;
  for(let i=0;i<attempts;i++) {
    try {
      const value=await fn();
      if(value) return value;
      last=value;
    } catch(err) { last=err; }
    await sleep(delay);
  }
  const extra=diagnostic();
  throw new Error(`Timed out waiting for ${label}${last instanceof Error?`: ${last.message}`:''}${extra?`\n${extra}`:''}`);
}

function hasExited(child) {
  return !child || child.exitCode!==null || child.signalCode!==null;
}

async function terminate(child,label) {
  if(hasExited(child)) return;
  const exited=new Promise(resolve=>child.once('exit',resolve));
  child.kill('SIGTERM');
  await Promise.race([exited,sleep(2000)]);
  if(!hasExited(child)) {
    const forcedExit=new Promise(resolve=>child.once('exit',resolve));
    child.kill('SIGKILL');
    await Promise.race([forcedExit,sleep(2000)]);
  }
  if(!hasExited(child)) console.warn(`${label} did not report exit before cleanup`);
}

const server=spawn(process.execPath,[path.join(root,'server.mjs')],{
  env:{...process.env,PORT:String(port),XHS_STUDIO_DATA:dataDir},
  stdio:['ignore','pipe','pipe'],
});
let chrome;
let socket;
let chromeStdout='';
let chromeStderr='';
try {
  await poll(async()=>{
    try{return (await fetch(`${base}/api/health`)).ok}catch{return false}
  },{attempts:200,delay:50,label:'Studio health'});

  const chromeBin=await findChrome();
  chrome=spawn(chromeBin,[
    '--headless=new',
    '--no-sandbox',
    '--disable-gpu',
    '--disable-dev-shm-usage',
    '--no-first-run',
    '--no-default-browser-check',
    '--remote-debugging-address=127.0.0.1',
    `--remote-debugging-port=${debugPort}`,
    `--user-data-dir=${chromeDir}`,
    'about:blank',
  ],{stdio:['ignore','pipe','pipe']});
  chrome.stdout?.on('data',chunk=>{chromeStdout=(chromeStdout+chunk.toString()).slice(-12000)});
  chrome.stderr?.on('data',chunk=>{chromeStderr=(chromeStderr+chunk.toString()).slice(-12000)});

  const chromeDiagnostic=()=>[
    `Chrome binary: ${chromeBin}`,
    `Chrome exitCode: ${chrome?.exitCode ?? 'running'}`,
    chromeStderr?`Chrome stderr:\n${chromeStderr}`:'',
    chromeStdout?`Chrome stdout:\n${chromeStdout}`:'',
  ].filter(Boolean).join('\n');

  await poll(async()=>{
    if(chrome.exitCode!==null) throw new Error(`Chrome exited with code ${chrome.exitCode}`);
    try {
      const response=await fetch(`${debugBase}/json/version`);
      if(!response.ok) return false;
      const version=await response.json();
      return version.webSocketDebuggerUrl?version:false;
    } catch { return false; }
  },{attempts:400,delay:50,label:'Chrome DevTools endpoint',diagnostic:chromeDiagnostic});

  const target=await poll(async()=>{
    if(chrome.exitCode!==null) throw new Error(`Chrome exited with code ${chrome.exitCode}`);
    try {
      const list=await fetch(`${debugBase}/json/list`).then(r=>r.ok?r.json():[]);
      return list.find(x=>x.type==='page'&&x.webSocketDebuggerUrl)||false;
    } catch { return false; }
  },{attempts:120,delay:50,label:'Chrome page target',diagnostic:chromeDiagnostic}).catch(async error=>{
    try {
      const created=await fetch(`${debugBase}/json/new?about%3Ablank`,{method:'PUT'});
      if(created.ok) {
        const value=await created.json();
        if(value?.webSocketDebuggerUrl) return value;
      }
    } catch {}
    throw error;
  });

  socket=new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>reject(new Error('WebSocket connection timeout')),5000);
    socket.addEventListener('open',()=>{clearTimeout(timer);resolve()},{once:true});
    socket.addEventListener('error',event=>{clearTimeout(timer);reject(new Error(`WebSocket error: ${event?.message||'unknown'}`))},{once:true});
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
    if(msg.method==='Log.entryAdded'&&msg.params?.entry?.level==='error') browserErrors.push(`error: ${msg.params.entry.text}`);
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
    },8000).unref?.();
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
  await poll(()=>evaluate(`document.readyState==='complete'&&!!document.querySelector('#demoBtn')`),{attempts:200,delay:50,label:'page ready',diagnostic:chromeDiagnostic});
  const templateCount=await poll(async()=>{
    const count=await evaluate(`document.querySelectorAll('.template').length`);
    return count>=3?count:false;
  },{attempts:200,delay:50,label:'templates rendered',diagnostic:chromeDiagnostic});

  await evaluate(`document.querySelector('#demoBtn').click(); true`);
  const rendered=await poll(async()=>{
    return await evaluate(`!document.querySelector('#projectView').hidden && document.querySelectorAll('#topNotes .note').length>=3`);
  },{attempts:240,delay:50,label:'demo project render',diagnostic:chromeDiagnostic});
  assert.equal(rendered,true);

  const metrics=await evaluate(`document.querySelector('#metrics').innerText`);
  assert.match(metrics,/笔记/);
  assert.match(metrics,/评论/);
  const sourceProtocolsOk=await evaluate(`Array.from(document.querySelectorAll('a[href]')).every(a=>['http:','https:'].includes(new URL(a.href).protocol))`);
  assert.equal(sourceProtocolsOk,true);

  await evaluate(`document.querySelector('.tabs button[data-tab="report"]').click(); true`);
  const reportReady=await poll(()=>evaluate(`document.querySelector('#reportText').textContent.includes('Methodology / interpretation limits')`),{attempts:200,delay:50,label:'client report render',diagnostic:chromeDiagnostic});
  assert.equal(reportReady,true);

  await sleep(150);
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
  await terminate(chrome,'Chrome');
  await terminate(server,'Studio server');
  await Promise.all([
    fs.rm(dataDir,{recursive:true,force:true,maxRetries:5,retryDelay:100}),
    fs.rm(chromeDir,{recursive:true,force:true,maxRetries:5,retryDelay:100}),
  ]);
}
