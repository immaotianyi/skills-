import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createHmac } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runConfiguredExecutor } from '../lib/executor.mjs';

const root=path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const repoRoot=path.resolve(root,'../..');
const adapterPath=path.join(root,'harvest-agent-adapter.mjs');
const sourceSkill=path.join(repoRoot,'.skills','03-domains','xiaohongshu-harvest.yaml');
const bundledSkill=path.join(root,'agent','xiaohongshu-harvest.yaml');
const demoPath=path.join(root,'public','demo-harvest.json');
const hmacSecret='agent-bridge-hmac-secret-at-least-32-bytes-2026';
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));

function project(){return{id:'prj_agent',name:'授权采集项目',client:'Pilot Client',category:'防晒',keywords:['敏感肌防晒','防晒辣眼睛'],competitors:['A品牌','B品牌']}}
function run(){return{id:'run_agent',budget:{maxNotes:40,maxComments:500,maxSeconds:120}}}
async function readRequest(req){const chunks=[];for await(const chunk of req)chunks.push(chunk);return Buffer.concat(chunks).toString('utf8')}
async function listen(handler){const server=http.createServer(handler);await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve)});const address=server.address();return{server,url:`http://127.0.0.1:${address.port}/jobs`}}
async function close(server){await new Promise(resolve=>server.close(()=>resolve()))}
function withExecutorEnv(values,fn){const keys=['XHS_STUDIO_HARVEST_EXECUTOR','XHS_STUDIO_HARVEST_EXECUTOR_ARGS','XHS_EXECUTOR_AGENT_GATEWAY','XHS_EXECUTOR_AGENT_TOKEN','XHS_EXECUTOR_AGENT_HMAC_SECRET','XHS_EXECUTOR_AGENT_TIMEOUT_MS','XHS_EXECUTOR_HARVEST_SKILL_PATH'],before=Object.fromEntries(keys.map(key=>[key,process.env[key]]));for(const key of keys)delete process.env[key];Object.assign(process.env,values);return Promise.resolve().then(fn).finally(()=>{for(const key of keys){if(before[key]===undefined)delete process.env[key];else process.env[key]=before[key]}})}
async function runAdapterDirect(plan,env={}){return new Promise((resolve,reject)=>{const child=spawn(process.execPath,[adapterPath],{cwd:root,env:{...process.env,...env},stdio:['pipe','pipe','pipe']});const stdout=[],stderr=[];child.stdout.on('data',c=>stdout.push(c));child.stderr.on('data',c=>stderr.push(c));child.once('error',reject);child.once('close',code=>resolve({code,stdout:Buffer.concat(stdout).toString('utf8'),stderr:Buffer.concat(stderr).toString('utf8')}));child.stdin.end(JSON.stringify(plan)+'\n')})}

function validPlan(){return{schemaVersion:'xhs-harvest-run-plan/1.0',runId:'run_direct',project:{id:'p1',name:'Direct',client:'',category:'',keywords:['防晒'],competitors:[]},budget:{maxNotes:20,maxComments:100,maxSeconds:60},safety:{publicOrAuthorizedReadOnlyOnly:true,bypassCaptcha:false,bypassLogin:false,bypassAccessControls:false,bypassRateLimits:false,onBlockedState:'manual_action_required'},requiredOutput:{format:'JSON'}}}

test('container-bundled Harvest skill stays byte-identical to the root skill source',async()=>{
  assert.equal(await fs.readFile(bundledSkill,'utf8'),await fs.readFile(sourceSkill,'utf8'));
});

test('Studio fixed-command executor -> authorized agent bridge -> gateway carries project research plan and returns Harvest v2',async()=>{
  const demo=JSON.parse(await fs.readFile(demoPath,'utf8'));
  let received=null;
  const {server,url}=await listen(async(req,res)=>{
    try{
      assert.equal(req.method,'POST');assert.equal(req.url,'/jobs');assert.equal(req.headers.authorization,'Bearer bridge-test-token');
      const raw=await readRequest(req),timestamp=String(req.headers['x-xhs-timestamp']||''),signature=String(req.headers['x-xhs-signature']||'');
      assert.match(timestamp,/^\d{10}$/u);
      const expected=`v1=${createHmac('sha256',hmacSecret).update(`${timestamp}.${raw}`).digest('hex')}`;
      assert.equal(signature,expected);
      received=JSON.parse(raw);
      res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({status:'completed',harvest:demo}));
    }catch(error){res.writeHead(500);res.end(JSON.stringify({error:error.message}))}
  });
  try{
    const result=await withExecutorEnv({
      XHS_STUDIO_HARVEST_EXECUTOR:process.execPath,
      XHS_STUDIO_HARVEST_EXECUTOR_ARGS:JSON.stringify([adapterPath]),
      XHS_EXECUTOR_AGENT_GATEWAY:url,
      XHS_EXECUTOR_AGENT_TOKEN:'bridge-test-token',
      XHS_EXECUTOR_AGENT_HMAC_SECRET:hmacSecret,
    },()=>runConfiguredExecutor(project(),run(),{timeoutMs:10_000}));
    assert.equal(result.status,'completed');
    assert.equal(result.harvest.schemaVersion,'2.0');
    assert.ok(received);
    assert.equal(received.schemaVersion,'xhs-authorized-browser-agent-job/1.0');
    assert.equal(received.skill.id,'xiaohongshu-harvest');
    assert.match(received.skill.prompt,/window\.__INITIAL_STATE__/u);
    assert.match(received.skill.prompt,/CAPTCHA/u);
    assert.deepEqual(received.plan.project.keywords,['敏感肌防晒','防晒辣眼睛']);
    assert.deepEqual(received.plan.project.competitors,['A品牌','B品牌']);
    assert.equal(received.plan.budget.maxNotes,40);
    assert.equal(received.plan.safety.bypassCaptcha,false);
    assert.equal(received.contract.onHardStop,'manual_action_required');
  }finally{await close(server)}
});

test('agent bridge preserves explicit login/CAPTCHA manual handoff instead of pretending collection succeeded',async()=>{
  const {server,url}=await listen(async(req,res)=>{await readRequest(req);res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({status:'manual_action_required',reason:'Please complete login in the authorized browser session.',riskState:'LOGIN_REQUIRED',gaps:['Search results require login.']}))});
  try{
    const result=await withExecutorEnv({XHS_STUDIO_HARVEST_EXECUTOR:process.execPath,XHS_STUDIO_HARVEST_EXECUTOR_ARGS:JSON.stringify([adapterPath]),XHS_EXECUTOR_AGENT_GATEWAY:url},()=>runConfiguredExecutor(project(),run(),{timeoutMs:10_000}));
    assert.equal(result.status,'manual_action_required');
    assert.equal(result.riskState,'LOGIN_REQUIRED');
    assert.match(result.reason,/complete login/u);
    assert.deepEqual(result.gaps,['Search results require login.']);
  }finally{await close(server)}
});

test('agent bridge rejects weakened safety plans before contacting any gateway',async()=>{
  const plan=validPlan();plan.safety.bypassCaptcha=true;
  const result=await runAdapterDirect(plan,{XHS_EXECUTOR_AGENT_GATEWAY:'http://127.0.0.1:9/jobs'});
  assert.notEqual(result.code,0);
  assert.match(result.stderr,/AGENT_SAFETY/u);
});

test('agent bridge rejects insecure remote gateways and unauthenticated remote HTTPS before network access',async()=>{
  const insecure=await runAdapterDirect(validPlan(),{XHS_EXECUTOR_AGENT_GATEWAY:'http://example.com/jobs'});
  assert.notEqual(insecure.code,0);assert.match(insecure.stderr,/AGENT_CONFIG: Agent gateway must use HTTPS/u);
  const unauthenticated=await runAdapterDirect(validPlan(),{XHS_EXECUTOR_AGENT_GATEWAY:'https://example.com/jobs'});
  assert.notEqual(unauthenticated.code,0);assert.match(unauthenticated.stderr,/Remote agent gateway requires/u);
});

test('agent bridge rejects malformed gateway protocol rather than converting it to success',async()=>{
  const {server,url}=await listen(async(req,res)=>{await readRequest(req);res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({ok:true,harvest:{schemaVersion:'2.0'}}))});
  try{
    const result=await runAdapterDirect(validPlan(),{XHS_EXECUTOR_AGENT_GATEWAY:url});
    assert.notEqual(result.code,0);assert.match(result.stderr,/AGENT_PROTOCOL/u);assert.equal(result.stdout,'');
  }finally{await close(server)}
});
