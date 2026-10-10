import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { makeIntegrity, verifyIntegrity, IntegrityError } from '../lib/integrity.mjs';
import { evaluateSignalClassifier, auditEvaluationDataset } from '../lib/evaluation.mjs';
import { buildEvidencePack, verifyEvidencePack } from '../lib/evidence-pack.mjs';
import { ensureData, saveSnapshot, loadSnapshot } from '../lib/storage.mjs';

function harvest(){
  return {
    schemaVersion:'2.0',
    source:{platform:'xiaohongshu',capturedAt:'2026-10-10T00:00:00Z',entry:'search',captureMethod:'initial_state'},
    notes:[{noteId:'n1',title:'证据标题',desc:'',author:{userId:'u1',nickname:'作者'},stats:{likes:10,collects:2,comments:1,shares:0},tags:[],sourceUrl:'https://www.xiaohongshu.com/explore/n1',captureMethod:'initial_state',confidence:1,comments:[]}],
    comments:[],authors:[],queries:[],
    meta:{gaps:[],loginRequired:false,riskState:'NORMAL',stoppedBecause:'sample complete'},
  };
}

test('canonical integrity is stable across object key order and detects mutation',()=>{
  const a={b:2,a:{y:2,x:1}};
  const b={a:{x:1,y:2},b:2};
  const integrity=makeIntegrity(a,'test-scope');
  assert.equal(verifyIntegrity(b,integrity,'test-scope').ok,true);
  assert.equal(verifyIntegrity({...b,b:3},integrity,'test-scope').ok,false);
});

test('new snapshots are signed and tampering fails closed while legacy unsigned snapshots stay explicit',async()=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'xhs-integrity-'));
  try{
    await ensureData(dir);
    const snapshot=await saveSnapshot(dir,'prj_test',harvest());
    assert.equal(snapshot.integrity.algorithm,'sha256');
    assert.equal(snapshot.integrityStatus.ok,true);
    assert.equal(snapshot.integrityStatus.unsigned,false);

    const file=path.join(dir,'snapshots','prj_test',`${snapshot.id}.json`);
    const stored=JSON.parse(await fs.readFile(file,'utf8'));
    stored.harvest.notes[0].title='被修改';
    await fs.writeFile(file,JSON.stringify(stored,null,2),'utf8');
    await assert.rejects(()=>loadSnapshot(dir,'prj_test',snapshot.id),IntegrityError);

    stored.harvest.notes[0].title='证据标题';
    delete stored.integrity;
    await fs.writeFile(file,JSON.stringify(stored,null,2),'utf8');
    const legacy=await loadSnapshot(dir,'prj_test',snapshot.id);
    assert.equal(legacy.integrityStatus.ok,true);
    assert.equal(legacy.integrityStatus.unsigned,true);
  } finally {
    await fs.rm(dir,{recursive:true,force:true});
  }
});

test('Evidence Pack v1.2 is tamper-evident and carries snapshot integrity',async()=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'xhs-pack-'));
  try{
    const snapshot=await saveSnapshot(dir,'prj_pack',harvest());
    const pack=buildEvidencePack({id:'prj_pack',name:'Pack Test'},snapshot);
    assert.equal(pack.schemaVersion,'xhs-evidence-pack/1.2');
    assert.ok(pack.snapshot.integrity?.digest);
    assert.equal(verifyEvidencePack(pack).ok,true);
    const tampered=structuredClone(pack);
    tampered.sources[0].title='篡改标题';
    assert.equal(verifyEvidencePack(tampered).ok,false);
  } finally {
    await fs.rm(dir,{recursive:true,force:true});
  }
});

test('evaluation reports confidence bounds without falsely granting a scientific claim',()=>{
  const records=[
    {id:'1',content:'这个太贵了，而且辣眼',labels:{complaints:true},reviewer:'r1',category:'防晒'},
    {id:'2',content:'不辣眼，也不会回购',labels:{},reviewer:'r2',category:'防晒'},
    {id:'3',content:'多少钱？哪里买，我想买',labels:{questions:true,purchaseIntent:true},reviewer:'r1',category:'防晒'},
    {id:'4',content:'很好用，推荐',labels:{positive:true},reviewer:'r2',category:'防晒'},
  ];
  const audit=auditEvaluationDataset(records);
  assert.equal(audit.sampleSize,4);
  assert.equal(audit.machineCheckablePreconditions,false);
  assert.ok(audit.warnings.some(x=>x.includes('below the 400-comment')));
  const result=evaluateSignalClassifier(records);
  assert.equal(result.schemaVersion,'xhs-signal-evaluation/2.0');
  assert.equal(result.perClass.complaints.tp,1);
  assert.ok(result.perClass.complaints.precision95.low<1);
  assert.equal(result.perClass.purchaseIntent.tp,1);
  assert.equal(result.perClass.positive.tp,1);
  assert.equal(result.claimGate.uses95PercentLowerBounds,true);
  assert.equal(result.claimGate.eligibleForValidatedClassifierClaim,false);
  assert.equal(result.audit.humanValidationStillRequired,true);
  assert.ok(result.audit.datasetIntegrity.digest);
});

test('machine preconditions require 400 unique, multi-category, double-reviewed holdout records',()=>{
  const classes=['questions','complaints','purchaseIntent','positive'];
  const records=Array.from({length:400},(_,i)=>{
    const target=classes[i%classes.length];
    const labels={questions:false,complaints:false,purchaseIntent:false,positive:false,[target]:true};
    return {
      id:`holdout-${i}`,
      content:`独立验证样本 ${i} 类别 ${target}`,
      category:`category-${i%4}`,
      sourceRef:`source-${i}`,
      reviews:[
        {reviewer:'reviewer-a',labels},
        {reviewer:'reviewer-b',labels},
      ],
    };
  });
  const audit=auditEvaluationDataset(records);
  assert.equal(audit.sampleSize,400);
  assert.equal(audit.doubleReviewedRows,400);
  assert.equal(audit.unresolvedDisagreementRows,0);
  assert.equal(audit.categoryCount,4);
  assert.equal(audit.interRaterTargetsMet,true);
  assert.equal(audit.machineCheckablePreconditions,true);
  for(const k of classes){
    assert.equal(audit.positiveLabels[k],100);
    assert.equal(audit.interRater[k].agreement,1);
    assert.equal(audit.interRater[k].kappa,1);
  }
});
