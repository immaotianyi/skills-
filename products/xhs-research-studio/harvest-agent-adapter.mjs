#!/usr/bin/env node
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root=path.dirname(fileURLToPath(import.meta.url));
const MAX_PLAN_BYTES=512_000;
const MAX_RESPONSE_BYTES=20_000_000;
const DEFAULT_TIMEOUT_MS=300_000;
const LOOPBACK_HOSTS=new Set(['127.0.0.1','localhost','::1']);

class AdapterError extends Error{constructor(message,{code='AGENT_BRIDGE_ERROR'}={}){super(message);this.code=code}}
function fail(message,code='AGENT_BRIDGE_ERROR'){throw new AdapterError(message,{code})}
function text(value,max=500){return String(value??'').replace(/[\u0000-\u001f\u007f]/gu,' ').replace(/\s+/gu,' ').trim().slice(0,max)}
function sha256(value){return createHash('sha256').update(value).digest('hex')}
function isLoopback(url){return LOOPBACK_HOSTS.has(url.hostname)}
function envNumber(name,fallback,min,max){const value=Number(process.env[name]);return Number.isFinite(value)?Math.min(max,Math.max(min,value)):fallback}

async function readStdin(){
  const chunks=[];let bytes=0;
  for await(const chunk of process.stdin){bytes+=chunk.length;if(bytes>MAX_PLAN_BYTES)fail(`Executor plan exceeds ${MAX_PLAN_BYTES} bytes.`,'AGENT_PLAN_LIMIT');chunks.push(chunk)}
  const raw=Buffer.concat(chunks).toString('utf8').trim();if(!raw)fail('Executor plan is empty.','AGENT_PLAN');
  try{return JSON.parse(raw)}catch(error){fail(`Executor plan is not valid JSON: ${error.message}`,'AGENT_PLAN')}
}
function validatePlan(plan){
  if(!plan||typeof plan!=='object'||Array.isArray(plan))fail('Executor plan must be one JSON object.','AGENT_PLAN');
  if(plan.schemaVersion!=='xhs-harvest-run-plan/1.0')fail(`Unsupported executor plan schema: ${text(plan.schemaVersion)||'(missing)'}.`,'AGENT_PLAN');
  if(!text(plan.runId,160))fail('Executor plan runId is required.','AGENT_PLAN');
  if(!plan.project||typeof plan.project!=='object'||Array.isArray(plan.project))fail('Executor plan project is required.','AGENT_PLAN');
  if(!Array.isArray(plan.project.keywords)||!Array.isArray(plan.project.competitors))fail('Executor plan keywords/competitors must be arrays.','AGENT_PLAN');
  if(plan.safety?.publicOrAuthorizedReadOnlyOnly!==true||plan.safety?.bypassCaptcha!==false||plan.safety?.bypassLogin!==false||plan.safety?.bypassAccessControls!==false||plan.safety?.bypassRateLimits!==false)fail('Executor plan safety contract is missing or weakened.','AGENT_SAFETY');
}
function gatewayUrl(){
  const raw=String(process.env.XHS_EXECUTOR_AGENT_GATEWAY||'').trim();if(!raw)fail('XHS_EXECUTOR_AGENT_GATEWAY is required.','AGENT_CONFIG');
  let url;try{url=new URL(raw)}catch{fail('XHS_EXECUTOR_AGENT_GATEWAY must be a valid URL.','AGENT_CONFIG')}
  if(url.username||url.password||url.hash)fail('Agent gateway URL must not contain credentials or a fragment.','AGENT_CONFIG');
  if(url.protocol!=='https:'&&!(url.protocol==='http:'&&isLoopback(url)))fail('Agent gateway must use HTTPS; HTTP is allowed only on loopback for local testing.','AGENT_CONFIG');
  return url;
}
async function loadSkill(){
  const configured=String(process.env.XHS_EXECUTOR_HARVEST_SKILL_PATH||'').trim();
  const candidates=[configured,path.resolve(root,'../../.skills/03-domains/xiaohongshu-harvest.yaml'),path.join(root,'agent','xiaohongshu-harvest.yaml')].filter(Boolean);
  let raw='',source='';
  for(const candidate of candidates){try{raw=await fs.readFile(candidate,'utf8');source=candidate;break}catch(error){if(error?.code!=='ENOENT')throw error}}
  if(!raw)fail('Bundled Xiaohongshu Harvest skill is unavailable.','AGENT_SKILL');
  const idMatch=raw.match(/^id:\s*([^\n]+)$/mu),typeMatch=raw.match(/^type:\s*([^\n]+)$/mu),promptMarker=raw.match(/^prompt:\s*\|\s*$/mu);
  if(!idMatch||idMatch[1].trim()!=='xiaohongshu-harvest'||!typeMatch||typeMatch[1].trim()!=='prompt'||!promptMarker)fail('Harvest skill file does not match the expected prompt skill contract.','AGENT_SKILL');
  const after=raw.slice((promptMarker.index??0)+promptMarker[0].length).replace(/^\r?\n/u,'');
  const lines=after.split(/\r?\n/u),prompt=[];
  for(const line of lines){if(line.startsWith('  '))prompt.push(line.slice(2));else if(line.trim()==='')prompt.push('');else break}
  const body=prompt.join('\n').trim();if(!body)fail('Harvest skill prompt is empty.','AGENT_SKILL');
  return{id:'xiaohongshu-harvest',type:'prompt',sha256:sha256(raw),promptSha256:sha256(body),prompt:body,source:path.basename(source)};
}
function authHeaders(body){
  const token=String(process.env.XHS_EXECUTOR_AGENT_TOKEN||'').trim(),secret=String(process.env.XHS_EXECUTOR_AGENT_HMAC_SECRET||'');
  const headers={'content-type':'application/json','accept':'application/json','x-xhs-agent-bridge':'1.0'};
  if(token)headers.authorization=`Bearer ${token}`;
  if(secret){if(Buffer.byteLength(secret,'utf8')<32)fail('XHS_EXECUTOR_AGENT_HMAC_SECRET must be at least 32 UTF-8 bytes.','AGENT_CONFIG');const timestamp=String(Math.floor(Date.now()/1000));headers['x-xhs-timestamp']=timestamp;headers['x-xhs-signature']=`v1=${createHmac('sha256',secret).update(`${timestamp}.${body}`).digest('hex')}`}
  return headers;
}
function requireRemoteAuth(url){if(!isLoopback(url)&&!String(process.env.XHS_EXECUTOR_AGENT_TOKEN||'').trim()&&!String(process.env.XHS_EXECUTOR_AGENT_HMAC_SECRET||''))fail('Remote agent gateway requires XHS_EXECUTOR_AGENT_TOKEN or XHS_EXECUTOR_AGENT_HMAC_SECRET.','AGENT_CONFIG')}
function validateGatewayResult(value){
  if(!value||typeof value!=='object'||Array.isArray(value))fail('Agent gateway must return one JSON object.','AGENT_PROTOCOL');
  const status=String(value.status||'').trim();
  if(status==='manual_action_required'){
    const riskState=text(value.riskState,80).toUpperCase();
    if(!riskState)fail('manual_action_required response requires riskState.','AGENT_PROTOCOL');
    return{status,reason:text(value.reason||'Manual action is required.',500),riskState,gaps:Array.isArray(value.gaps)?value.gaps.map(item=>text(item,300)).filter(Boolean).slice(0,100):[]};
  }
  if(status!=='completed'||!value.harvest||typeof value.harvest!=='object'||Array.isArray(value.harvest))fail('Agent gateway must return completed+harvest or manual_action_required.','AGENT_PROTOCOL');
  return{status:'completed',harvest:value.harvest};
}

async function main(){
  const plan=await readStdin();validatePlan(plan);
  const url=gatewayUrl();requireRemoteAuth(url);
  const skill=await loadSkill();
  const request={schemaVersion:'xhs-authorized-browser-agent-job/1.0',requestedAt:new Date().toISOString(),skill,plan,contract:{authorizedPublicReadOnlyOnly:true,hardStops:['CAPTCHA','LOGIN_REQUIRED','ACCESS_DENIED','BLOCKED','THROTTLED'],onHardStop:'manual_action_required',requiredResult:'completed+Harvest v2 OR manual_action_required'}};
  const body=JSON.stringify(request),controller=new AbortController(),timeout=setTimeout(()=>controller.abort(),envNumber('XHS_EXECUTOR_AGENT_TIMEOUT_MS',DEFAULT_TIMEOUT_MS,1_000,1_800_000));
  try{
    const response=await fetch(url,{method:'POST',headers:authHeaders(body),body,redirect:'error',signal:controller.signal});
    if(!response.ok)fail(`Agent gateway returned HTTP ${response.status}.`,'AGENT_HTTP');
    const buffer=Buffer.from(await response.arrayBuffer());if(buffer.length>MAX_RESPONSE_BYTES)fail(`Agent gateway response exceeds ${MAX_RESPONSE_BYTES} bytes.`,'AGENT_RESPONSE_LIMIT');
    let parsed;try{parsed=JSON.parse(buffer.toString('utf8'))}catch(error){fail(`Agent gateway response is not valid JSON: ${error.message}`,'AGENT_PROTOCOL')}
    process.stdout.write(JSON.stringify(validateGatewayResult(parsed))+'\n');
  }catch(error){if(error?.name==='AbortError')fail('Agent gateway request timed out.','AGENT_TIMEOUT');throw error}finally{clearTimeout(timeout)}
}

main().catch(error=>{const code=error?.code||'AGENT_BRIDGE_ERROR';process.stderr.write(`${code}: ${error?.message||String(error)}\n`);process.exitCode=1});
