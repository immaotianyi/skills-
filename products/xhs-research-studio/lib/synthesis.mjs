import { spawn } from 'node:child_process';
import { analyze } from './analysis.mjs';

const CLAIM_TYPES=new Set(['fact','inference','recommendation']);
const PREVALENCE_RE=/(?:\b\d+(?:\.\d+)?\s*%|百分之|占比|大多数|多数用户|整体用户|所有用户|代表性样本|\bmajority\b|\bmost users\b|\bprevalence\b|\brepresentative sample\b)/iu;
const DEFAULT_TIMEOUT_MS=60_000;
const MAX_STDOUT_BYTES=2_000_000;

export const SYNTHESIS_SCHEMA=Object.freeze({
  type:'object',
  additionalProperties:false,
  required:['title','claims','counterEvidence','limitations'],
  properties:{
    title:{type:'string'},
    claims:{type:'array',items:{type:'object',additionalProperties:false,required:['id','type','text','evidenceIds'],properties:{id:{type:'string'},type:{type:'string',enum:['fact','inference','recommendation']},text:{type:'string'},evidenceIds:{type:'array',items:{type:'string'}}}}},
    counterEvidence:{type:'array',items:{type:'object',additionalProperties:false,required:['text','evidenceIds'],properties:{text:{type:'string'},evidenceIds:{type:'array',items:{type:'string'}}}}},
    limitations:{type:'array',items:{type:'string'}},
  },
});

export class SynthesisError extends Error{
  constructor(message,{code='SYNTHESIS_ERROR',statusCode=400,details=[]}={}){super(message);this.code=code;this.statusCode=statusCode;this.details=details}
}

function safeText(value,max=4000){return String(value??'').replace(/\u0000/gu,'').trim().slice(0,max)}
function noteScore(note){const s=note?.stats||{};return Number(s.likes||0)+1.5*Number(s.collects||0)+2*Number(s.comments||0)+0.5*Number(s.shares||0)}
function sourceUrlForNote(notes,noteId){return notes.find(note=>note.noteId===noteId)?.sourceUrl||''}
function instructions(){return [
  'You are an evidence-grounded research synthesis engine.',
  'Use only the supplied evidence. Never invent sources or evidence IDs.',
  'Every claim and counter-evidence item must cite at least one supplied evidence ID.',
  'Keep raw facts, inference, and recommendation separated using the required claim type.',
  'Do not state percentages, population prevalence, representativeness, or phrases such as majority/most users from this bounded observational sample.',
  'Include meaningful limitations. If there is contradictory evidence, surface it in counterEvidence rather than hiding it.',
].join(' ')}

export function buildGroundedSynthesisInput(project,snapshot,{maxNotes=60,maxComments=160}={}){
  if(!snapshot?.harvest)throw new SynthesisError('A snapshot with Harvest evidence is required.',{code:'SYNTHESIS_INPUT'});
  const harvest=snapshot.harvest,analysis=snapshot.analysis||analyze(harvest);
  const notes=[...(harvest.notes||[])].sort((a,b)=>noteScore(b)-noteScore(a)).slice(0,Math.max(1,Math.min(200,maxNotes)));
  const comments=[...(harvest.comments||[])].sort((a,b)=>Number(b.likes||0)-Number(a.likes||0)).slice(0,Math.max(1,Math.min(500,maxComments)));
  const evidence=[];
  for(const note of notes){
    if(!note.noteId)continue;
    evidence.push({id:`note:${note.noteId}`,kind:'note',noteId:note.noteId,text:safeText([note.title,note.desc].filter(Boolean).join(' — '),3000),sourceUrl:safeText(note.sourceUrl,1500),stats:note.stats||{},captureMethod:note.captureMethod||'unknown',confidence:note.confidence??null});
  }
  for(const comment of comments){
    if(!comment.id)continue;
    evidence.push({id:`comment:${comment.id}`,kind:'comment',commentId:comment.id,noteId:comment.noteId||null,text:safeText(comment.content,2500),likes:Number(comment.likes||0),sourceUrl:safeText(comment.sourceUrl||sourceUrlForNote(harvest.notes||[],comment.noteId),1500)});
  }
  if(!evidence.length)throw new SynthesisError('No citable note/comment evidence is available for synthesis.',{code:'SYNTHESIS_NO_EVIDENCE',statusCode:409});
  return {
    schemaVersion:'xhs-grounded-synthesis-input/1.0',
    project:{id:project?.id||null,name:safeText(project?.name,200),category:safeText(project?.category,200),keywords:project?.keywords||[],competitors:project?.competitors||[]},
    snapshot:{id:snapshot.id||null,capturedAt:snapshot.createdAt||harvest.source?.capturedAt||null,riskState:harvest.meta?.riskState||'NORMAL',gaps:harvest.meta?.gaps||[]},
    methodology:{sampling:'bounded observational sample; not representative population research',signalLayer:'rule-based analyst triage; not a scientifically validated sentiment classifier',numericPrevalence:'forbidden in synthesized claims unless separately computed by a validated representative study',citationRule:'every fact, inference, recommendation, and counter-evidence statement must cite one or more supplied evidence IDs'},
    observedRankings:analysis.rankings||[],
    evidence,
  };
}

function validateEvidenceIds(ids,available,path,details){
  if(!Array.isArray(ids)||ids.length===0){details.push({path,message:'At least one evidence ID is required.'});return []}
  const clean=[...new Set(ids.map(value=>String(value||'').trim()).filter(Boolean))];
  for(const id of clean)if(!available.has(id))details.push({path,message:`Unknown evidence ID: ${id}`});
  return clean;
}
function validateClaimText(text,path,details){
  const value=safeText(text,4000);
  if(!value)details.push({path,message:'Claim text is required.'});
  if(PREVALENCE_RE.test(value))details.push({path,message:'Unsupported prevalence/representativeness language is forbidden for this observational sample.'});
  return value;
}

export function validateGroundedSynthesis(document,input){
  const details=[],available=new Set((input?.evidence||[]).map(item=>item.id));
  if(!document||typeof document!=='object'||Array.isArray(document))throw new SynthesisError('Synthesis output must be a JSON object.',{code:'SYNTHESIS_INVALID_OUTPUT'});
  const title=safeText(document.title,240);if(!title)details.push({path:'$.title',message:'Title is required.'});
  const claims=Array.isArray(document.claims)?document.claims:[];
  if(!Array.isArray(document.claims))details.push({path:'$.claims',message:'claims must be an array.'});
  if(claims.length>40)details.push({path:'$.claims',message:'At most 40 claims are allowed.'});
  const seen=new Set();
  const normalizedClaims=claims.map((claim,index)=>{
    const path=`$.claims[${index}]`,id=safeText(claim?.id,100),type=String(claim?.type||'');
    if(!/^c[1-9][0-9]*$/u.test(id))details.push({path:`${path}.id`,message:'Claim ID must use c1, c2, ... format.'});
    if(seen.has(id))details.push({path:`${path}.id`,message:'Claim IDs must be unique.'});else seen.add(id);
    if(!CLAIM_TYPES.has(type))details.push({path:`${path}.type`,message:'Claim type must be fact, inference, or recommendation.'});
    return {id,type,text:validateClaimText(claim?.text,`${path}.text`,details),evidenceIds:validateEvidenceIds(claim?.evidenceIds,available,`${path}.evidenceIds`,details)};
  });
  const counter=Array.isArray(document.counterEvidence)?document.counterEvidence:[];
  if(!Array.isArray(document.counterEvidence))details.push({path:'$.counterEvidence',message:'counterEvidence must be an array.'});
  if(counter.length>20)details.push({path:'$.counterEvidence',message:'At most 20 counter-evidence items are allowed.'});
  const normalizedCounter=counter.map((item,index)=>({text:validateClaimText(item?.text,`$.counterEvidence[${index}].text`,details),evidenceIds:validateEvidenceIds(item?.evidenceIds,available,`$.counterEvidence[${index}].evidenceIds`,details)}));
  const limitations=Array.isArray(document.limitations)?document.limitations.map(item=>safeText(item,1000)).filter(Boolean):[];
  if(!Array.isArray(document.limitations))details.push({path:'$.limitations',message:'limitations must be an array.'});
  if(!limitations.length)details.push({path:'$.limitations',message:'At least one limitation is required.'});
  if(details.length)throw new SynthesisError('Grounded synthesis failed evidence validation.',{code:'SYNTHESIS_GROUNDING_FAILED',statusCode:422,details});
  return {schemaVersion:'xhs-grounded-synthesis/1.0',title,claims:normalizedClaims,counterEvidence:normalizedCounter,limitations,grounding:{validated:true,evidenceItems:available.size,validatedAt:new Date().toISOString()}};
}

function extractResponseText(data){
  const pieces=[];
  for(const item of data?.output||[]){
    if(item?.type!=='message')continue;
    for(const part of item.content||[]){
      if(part?.type==='refusal')throw new SynthesisError(`Synthesis provider refused the request: ${safeText(part.refusal,1000)}`,{code:'SYNTHESIS_REFUSAL',statusCode:422});
      if(part?.type==='output_text'&&part.text)pieces.push(part.text);
    }
  }
  return pieces.join('').trim();
}

export function openAiSynthesisConfigured(env=process.env){return Boolean(String(env.XHS_STUDIO_OPENAI_API_KEY||'').trim()&&String(env.XHS_STUDIO_OPENAI_MODEL||'').trim())}
export function commandSynthesisConfigured(env=process.env){return Boolean(String(env.XHS_STUDIO_SYNTHESIS_EXECUTOR||'').trim())}

export async function synthesizeWithOpenAI(input,{fetchImpl=fetch,env=process.env}={}){
  const key=String(env.XHS_STUDIO_OPENAI_API_KEY||'').trim(),model=String(env.XHS_STUDIO_OPENAI_MODEL||'').trim();
  if(!key||!model)throw new SynthesisError('OpenAI synthesis requires XHS_STUDIO_OPENAI_API_KEY and XHS_STUDIO_OPENAI_MODEL.',{code:'SYNTHESIS_NOT_CONFIGURED',statusCode:503});
  const response=await fetchImpl('https://api.openai.com/v1/responses',{method:'POST',headers:{authorization:`Bearer ${key}`,'content-type':'application/json'},body:JSON.stringify({model,instructions:instructions(),input:JSON.stringify(input),store:false,text:{format:{type:'json_schema',name:'xhs_grounded_synthesis',strict:true,schema:SYNTHESIS_SCHEMA}}})});
  const raw=await response.text();let data;try{data=JSON.parse(raw)}catch{data={}}
  if(!response.ok){const message=data?.error?.message||`OpenAI returned HTTP ${response.status}`;throw new SynthesisError(`Synthesis provider request failed: ${safeText(message,1200)}`,{code:'SYNTHESIS_PROVIDER_FAILED',statusCode:502})}
  const text=extractResponseText(data);if(!text)throw new SynthesisError('Synthesis provider returned no structured output text.',{code:'SYNTHESIS_EMPTY_PROVIDER_OUTPUT',statusCode:502});
  let document;try{document=JSON.parse(text)}catch{throw new SynthesisError('Synthesis provider output was not valid JSON.',{code:'SYNTHESIS_PROVIDER_JSON',statusCode:502})}
  const validated=validateGroundedSynthesis(document,input);return {...validated,provider:{name:'openai',model,responseId:data?.id||null}};
}

function parseExecutorArgs(env){
  const raw=String(env.XHS_STUDIO_SYNTHESIS_EXECUTOR_ARGS||'').trim();if(!raw)return[];
  let parsed;try{parsed=JSON.parse(raw)}catch{throw new SynthesisError('XHS_STUDIO_SYNTHESIS_EXECUTOR_ARGS must be a JSON array.',{code:'SYNTHESIS_EXECUTOR_CONFIG',statusCode:503})}
  if(!Array.isArray(parsed)||parsed.some(item=>typeof item!=='string'))throw new SynthesisError('XHS_STUDIO_SYNTHESIS_EXECUTOR_ARGS must be a JSON string array.',{code:'SYNTHESIS_EXECUTOR_CONFIG',statusCode:503});
  return parsed.slice(0,32);
}

export async function synthesizeWithCommand(input,{env=process.env,timeoutMs=DEFAULT_TIMEOUT_MS}={}){
  const command=String(env.XHS_STUDIO_SYNTHESIS_EXECUTOR||'').trim();
  if(!command)throw new SynthesisError('Synthesis command adapter is not configured.',{code:'SYNTHESIS_NOT_CONFIGURED',statusCode:503});
  const args=parseExecutorArgs(env),payload=JSON.stringify({schema:SYNTHESIS_SCHEMA,instructions:instructions(),input});
  const controller=new AbortController();let timer;
  const child=spawn(command,args,{shell:false,stdio:['pipe','pipe','pipe'],env:{PATH:process.env.PATH||'',HOME:process.env.HOME||'',NODE_ENV:process.env.NODE_ENV||'production'},signal:controller.signal});
  let stdout='',stderr='',stdoutBytes=0;
  const done=new Promise((resolve,reject)=>{
    child.stdout.on('data',chunk=>{stdoutBytes+=chunk.length;if(stdoutBytes>MAX_STDOUT_BYTES){controller.abort();reject(new SynthesisError('Synthesis executor exceeded stdout limit.',{code:'SYNTHESIS_EXECUTOR_OUTPUT_LIMIT',statusCode:502}));return}stdout+=chunk.toString('utf8')});
    child.stderr.on('data',chunk=>{if(Buffer.byteLength(stderr,'utf8')<64_000)stderr+=chunk.toString('utf8')});
    child.once('error',error=>{if(error?.name==='AbortError')return;reject(new SynthesisError(`Synthesis executor failed to start: ${error.message}`,{code:'SYNTHESIS_EXECUTOR_START',statusCode:502}))});
    child.once('close',(code,signal)=>resolve({code,signal}));
  });
  try{
    timer=setTimeout(()=>controller.abort(),Math.max(1000,Math.min(180_000,Number(timeoutMs)||DEFAULT_TIMEOUT_MS)));timer.unref?.();
    child.stdin.end(payload);
    const result=await done;
    if(result.code!==0)throw new SynthesisError(`Synthesis executor exited with code ${result.code}${stderr?`: ${safeText(stderr,1200)}`:''}`,{code:'SYNTHESIS_EXECUTOR_FAILED',statusCode:502});
    let document;try{document=JSON.parse(stdout)}catch{throw new SynthesisError('Synthesis executor output was not valid JSON.',{code:'SYNTHESIS_EXECUTOR_JSON',statusCode:502})}
    const validated=validateGroundedSynthesis(document,input);return {...validated,provider:{name:'command',command}};
  }catch(error){
    if(controller.signal.aborted&&!(error instanceof SynthesisError))throw new SynthesisError('Synthesis executor timed out.',{code:'SYNTHESIS_EXECUTOR_TIMEOUT',statusCode:504});
    if(controller.signal.aborted&&error?.code==='ABORT_ERR')throw new SynthesisError('Synthesis executor timed out.',{code:'SYNTHESIS_EXECUTOR_TIMEOUT',statusCode:504});
    throw error;
  }finally{if(timer)clearTimeout(timer);if(!child.killed&&controller.signal.aborted)child.kill('SIGKILL')}
}

export async function synthesizeGrounded(input,options={}){
  const env=options.env||process.env;
  if(commandSynthesisConfigured(env))return synthesizeWithCommand(input,options);
  if(openAiSynthesisConfigured(env))return synthesizeWithOpenAI(input,options);
  throw new SynthesisError('No grounded synthesis provider is configured.',{code:'SYNTHESIS_NOT_CONFIGURED',statusCode:503});
}
