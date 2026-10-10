import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeHarvest } from '../lib/normalize.mjs';
import { analyze } from '../lib/analysis.mjs';
import { buildGroundedSynthesisInput, validateGroundedSynthesis, synthesizeWithOpenAI, synthesizeWithCommand } from '../lib/synthesis.mjs';

const root=path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const demo=JSON.parse(await fs.readFile(path.join(root,'public','demo-harvest.json'),'utf8'));
const harvest=normalizeHarvest(demo);
const snapshot={id:'snp_test',createdAt:'2026-10-10T00:00:00.000Z',harvest,analysis:analyze(harvest)};
const project={id:'prj_test',name:'防晒研究',category:'防晒',keywords:['敏感肌防晒'],competitors:['A品牌']};

function validDocument(input){
  return {
    title:'敏感肌防晒观测摘要',
    claims:[
      {id:'c1',type:'fact',text:'样本中存在关于辣眼风险的直接追问。',evidenceIds:[input.evidence.find(item=>item.kind==='comment').id]},
      {id:'c2',type:'recommendation',text:'后续研究应优先核查眼周刺激相关证据。',evidenceIds:[input.evidence.find(item=>item.kind==='note').id]},
    ],
    counterEvidence:[],
    limitations:['这是有边界的观测样本，不能外推到整体用户群体。'],
  };
}

test('grounded synthesis validates every claim against known note/comment evidence IDs',()=>{
  const input=buildGroundedSynthesisInput(project,snapshot);
  assert.ok(input.evidence.some(item=>item.id.startsWith('note:')));
  assert.ok(input.evidence.some(item=>item.id.startsWith('comment:')));
  const validated=validateGroundedSynthesis(validDocument(input),input);
  assert.equal(validated.grounding.validated,true);
  assert.equal(validated.claims.length,2);
});

test('grounded synthesis rejects unknown evidence, missing evidence, and population prevalence language',()=>{
  const input=buildGroundedSynthesisInput(project,snapshot);
  const unknown=validDocument(input);
  unknown.claims[0].evidenceIds=['comment:not-real'];
  assert.throws(()=>validateGroundedSynthesis(unknown,input),error=>error?.code==='SYNTHESIS_GROUNDING_FAILED'&&error.details.some(item=>/Unknown evidence ID/u.test(item.message)));

  const missing=validDocument(input);
  missing.claims[0].evidenceIds=[];
  assert.throws(()=>validateGroundedSynthesis(missing,input),error=>error?.details?.some(item=>/At least one evidence ID/u.test(item.message)));

  const prevalence=validDocument(input);
  prevalence.claims[0].text='80% 的用户都会遇到辣眼问题。';
  assert.throws(()=>validateGroundedSynthesis(prevalence,input),error=>error?.details?.some(item=>/prevalence/u.test(item.message)));
});

test('OpenAI adapter uses Responses structured outputs and still performs local grounding validation',async()=>{
  const input=buildGroundedSynthesisInput(project,snapshot);
  const document=validDocument(input);
  let requestBody=null;
  const fetchImpl=async(url,options)=>{
    assert.equal(url,'https://api.openai.com/v1/responses');
    requestBody=JSON.parse(options.body);
    return {
      ok:true,status:200,
      async text(){return JSON.stringify({id:'resp_test',output:[{type:'message',content:[{type:'output_text',text:JSON.stringify(document)}]}]})},
    };
  };
  const result=await synthesizeWithOpenAI(input,{fetchImpl,env:{XHS_STUDIO_OPENAI_API_KEY:'sk-test',XHS_STUDIO_OPENAI_MODEL:'test-model'}});
  assert.equal(requestBody.text.format.type,'json_schema');
  assert.equal(requestBody.text.format.strict,true);
  assert.equal(requestBody.store,false);
  assert.equal(result.provider.name,'openai');
  assert.equal(result.provider.responseId,'resp_test');
  assert.equal(result.grounding.validated,true);
});

test('fixed-command synthesis adapter runs with shell disabled protocol and local grounding validation',async()=>{
  const input=buildGroundedSynthesisInput(project,snapshot);
  const result=await synthesizeWithCommand(input,{
    env:{
      XHS_STUDIO_SYNTHESIS_EXECUTOR:process.execPath,
      XHS_STUDIO_SYNTHESIS_EXECUTOR_ARGS:JSON.stringify([path.join(root,'test','fixtures','mock-synthesis-executor.mjs')]),
    },
    timeoutMs:5000,
  });
  assert.equal(result.provider.name,'command');
  assert.equal(result.grounding.validated,true);
  assert.ok(result.claims.every(claim=>claim.evidenceIds.length>0));
});
