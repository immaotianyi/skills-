import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const root=path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));

async function startHosted(){
  const dataDir=await fs.mkdtemp(path.join(os.tmpdir(),'xhs-auth-http-'));
  const port=61000+Math.floor(Math.random()*3000),base=`http://127.0.0.1:${port}`;
  const child=spawn(process.execPath,[path.join(root,'server-v3.mjs')],{
    cwd:root,stdio:['ignore','pipe','pipe'],env:{...process.env,PORT:String(port),HOST:'127.0.0.1',XHS_STUDIO_DATA:dataDir,XHS_STUDIO_HOSTED:'1',XHS_STUDIO_PUBLIC_URL:base,XHS_STUDIO_STRIPE_WEBHOOK_SECRET:crypto.randomBytes(32).toString('hex')},
  });
  let logs='';child.stdout.on('data',chunk=>{logs=(logs+chunk.toString()).slice(-10000)});child.stderr.on('data',chunk=>{logs=(logs+chunk.toString()).slice(-10000)});
  for(let i=0;i<160;i++){
    try{if((await fetch(`${base}/api/health`)).ok)return {dataDir,port,base,child,logs:()=>logs}}catch{}
    if(child.exitCode!==null)break;
    await sleep(40);
  }
  child.kill('SIGTERM');
  await fs.rm(dataDir,{recursive:true,force:true});
  throw new Error(`hosted auth test server failed to start\n${logs}`);
}

async function stopHosted(ctx){
  if(ctx.child.exitCode===null){
    const done=new Promise(resolve=>ctx.child.once('exit',resolve));
    ctx.child.kill('SIGTERM');
    await Promise.race([done,sleep(2000)]);
    if(ctx.child.exitCode===null)ctx.child.kill('SIGKILL');
  }
  await fs.rm(ctx.dataDir,{recursive:true,force:true});
}

async function api(ctx,path,{body,status}={}){
  const response=await fetch(`${ctx.base}${path}`,{method:'POST',headers:{origin:ctx.base,'content-type':'application/json'},body:JSON.stringify(body||{})});
  const text=await response.text();let data;try{data=JSON.parse(text)}catch{data=text}
  if(status!==undefined)assert.equal(response.status,status,`${path}: ${text}\n${ctx.logs()}`);
  return {response,data};
}

test('hosted login endpoint enforces persistent pair/IP throttling',async()=>{
  const ctx=await startHosted();
  try{
    const password=`Auth-${crypto.randomBytes(12).toString('hex')}!`,email='rate-login@example.test';
    assert.equal((await api(ctx,'/api/auth/register',{body:{email,password,workspaceName:'Auth Rate Test'},status:201})).response.status,201);
    for(let i=0;i<7;i++)await api(ctx,'/api/auth/login',{body:{email,password:`wrong-${i}-${password}`},status:401});
    const blocked=await api(ctx,'/api/auth/login',{body:{email,password:'wrong-final'},status:429});
    assert.equal(blocked.data.code,'AUTH_RATE_LIMIT');
    await api(ctx,'/api/auth/login',{body:{email,password},status:429});
  }finally{await stopHosted(ctx)}
});

test('hosted registration endpoint rate-limits repeated CPU-expensive account creation by client IP',async()=>{
  const ctx=await startHosted();
  try{
    const password=`Register-${crypto.randomBytes(12).toString('hex')}!`;
    for(let i=0;i<12;i++)await api(ctx,'/api/auth/register',{body:{email:`rate-register-${i}@example.test`,password,workspaceName:`W${i}`},status:201});
    const blocked=await api(ctx,'/api/auth/register',{body:{email:'rate-register-blocked@example.test',password,workspaceName:'Blocked'},status:429});
    assert.equal(blocked.data.code,'AUTH_RATE_LIMIT');
  }finally{await stopHosted(ctx)}
});
