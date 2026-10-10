import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { makeIntegrity, verifyIntegrity, IntegrityError } from '../lib/integrity.mjs';
import { evaluateSignalClassifier, auditEvaluationDataset } from '../lib/evaluation.mjs';
import { buildEvidencePack, verifyEvidencePack } from '../lib/evidence-pack.mjs';
import { ensureData, saveSnapshot, loadSnapshot, listSnapshots } from '../lib/storage.mjs';

function harvest(capturedAt='2026-10-10T00:00:00Z'){
  return {
    schemaVersion:'2.0',
    source:{platform:'xiaohongshu',capturedAt,entry:'search',captureMethod:'initial_state'},
    notes:[{noteId:'n1',title:'证据标题',desc:'',author:{userId:'u1',nickname:'作者'},stats:{likes:10,collects:2,comments:1,shares:0},tags:[],sourceUrl:'https://www.xiaohongshu.com/explore/n1',captureMethod:'initial_state',confidence:1,comments:[]}],
    comments:[],authors:[],queries:[],
    meta:{gaps:[],loginRequired:false,riskState:'NORMAL',stoppedBecause:'sample complete'},
  };
}

test('canonical checksum is stable across object key order and detects mutation without claiming authentication',()=>{
  const a={b:2,a:{y:2,x:1}};
  const b={a:{x:1,y:2},b:2};
  const integrity=makeIntegrity(a,'test-scope');
  const verified=verifyIntegrity(b,integrity,'test-scope');
  assert.equal(integrity.algorithm,'sha256');
  assert.equal(integrity.authenticated,false);
  assert.equal(verified.ok,true);
  assert.equal(verified.authenticated,false);
  assert.equal(verified.checksumOnly,true);
  assert.equal(verifyIntegrity({...b,b:3},integrity,'test-scope').ok,false);
});

test('HMAC integrity authenticates with the external key and fails with missing or wrong keys',()=>{
  const value={evidence:'原始证据',count:3};
  const key='unit-test-hmac-key-at-least-32-bytes-2026';
  const integrity=makeIntegrity(value,'hmac-test',{key,keyId:'unit-v1'});
  assert.equal(integrity.algorithm,'hmac-sha256');
  assert.equal(integrity.authenticated,true);
  const verified=verifyIntegrity(value,integrity,'hmac-test',{key,keyId:'unit-v1'});
  assert.equal(verified.ok,true);
  assert.equal(verified.authenticated,true);
  assert.equal(verified.checksumOnly,false);
  assert.equal(verifyIntegrity(value,integrity,'hmac-test').ok,false);
  assert.equal(verifyIntegrity(value,integrity,'hmac-test',{key:'wrong-key-value-long-enough-for-this-unit-case',keyId:'unit-v1'}).ok,false);
});

test('v2 snapshot integrity protects raw evidence, derived analysis, validation and metadata',async()=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'xhs-integrity-v2-'));
  try{
    await ensureData(dir);
    const snapshot=await saveSnapshot(dir,'prj_test',harvest());
    assert.equal(snapshot.integrity.scope,'xhs-research-studio-snapshot-record-v2');
    assert.equal(snapshot.integrity.algorithm,'sha256');
    assert.equal(snapshot.integrityStatus.verified,true);
    assert.equal(snapshot.integrityStatus.recordProtected,true);
    assert.equal(snapshot.integrityStatus.checksumOnly,true);
    assert.ok(Array.isArray(snapshot.validation.inputWarnings));

    const file=path.join(dir,'snapshots','prj_test',`${snapshot.id}.json`);
    const original=JSON.parse(await fs.readFile(file,'utf8'));

    const evidenceTamper=structuredClone(original);
    evidenceTamper.harvest.notes[0].title='被修改的原始证据';
    await fs.writeFile(file,JSON.stringify(evidenceTamper,null,2),'utf8');
    await assert.rejects(()=>loadSnapshot(dir,'prj_test',snapshot.id),IntegrityError);

    const analysisTamper=structuredClone(original);
    analysisTamper.analysis.coverage.notes=999999;
    await fs.writeFile(file,JSON.stringify(analysisTamper,null,2),'utf8');
    await assert.rejects(()=>loadSnapshot(dir,'prj_test',snapshot.id),IntegrityError);

    const validationTamper=structuredClone(original);
    validationTamper.validation.inputWarnings.push({path:'fake',message:'injected'});
    await fs.writeFile(file,JSON.stringify(validationTamper,null,2),'utf8');
    await assert.rejects(()=>loadSnapshot(dir,'prj_test',snapshot.id),IntegrityError);

    const metadataTamper=structuredClone(original);
    metadataTamper.createdAt='2030-01-01T00:00:00Z';
    await fs.writeFile(file,JSON.stringify(metadataTamper,null,2),'utf8');
    await assert.rejects(()=>loadSnapshot(dir,'prj_test',snapshot.id),IntegrityError);
  } finally {
    await fs.rm(dir,{recursive:true,force:true});
  }
});

test('legacy v1 and unsigned snapshots never trust stored derived analysis',async()=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'xhs-integrity-legacy-'));
  try{
    const snapshot=await saveSnapshot(dir,'prj_legacy',harvest());
    const file=path.join(dir,'snapshots','prj_legacy',`${snapshot.id}.json`);
    const stored=JSON.parse(await fs.readFile(file,'utf8'));

    stored.analysis.coverage.notes=777777;
    stored.integrity=makeIntegrity(stored.harvest,'xhs-harvest-snapshot-evidence-v1');
    await fs.writeFile(file,JSON.stringify(stored,null,2),'utf8');
    const legacyV1=await loadSnapshot(dir,'prj_legacy',snapshot.id);
    assert.equal(legacyV1.integrityStatus.verified,true);
    assert.equal(legacyV1.integrityStatus.recordProtected,false);
    assert.equal(legacyV1.analysis.coverage.notes,1);
    assert.equal(legacyV1.migration.analysisRecomputedInMemory,true);
    assert.equal(legacyV1.migration.reason,'derived-analysis-not-covered-by-record-integrity');

    stored.analysis.coverage.notes=888888;
    delete stored.integrity;
    await fs.writeFile(file,JSON.stringify(stored,null,2),'utf8');
    const unsigned=await loadSnapshot(dir,'prj_legacy',snapshot.id);
    assert.equal(unsigned.integrityStatus.verified,false);
    assert.equal(unsigned.integrityStatus.unsigned,true);
    assert.equal(unsigned.integrityStatus.recordProtected,false);
    assert.equal(unsigned.analysis.coverage.notes,1);
  } finally {
    await fs.rm(dir,{recursive:true,force:true});
  }
});

test('tampered latest snapshot keeps its capture time in listings so default-latest consumers cannot silently fall back',async()=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'xhs-integrity-list-'));
  try{
    const earlier=await saveSnapshot(dir,'prj_list',harvest('2026-10-10T00:00:00Z'));
    const later=await saveSnapshot(dir,'prj_list',harvest('2026-10-11T00:00:00Z'));
    const file=path.join(dir,'snapshots','prj_list',`${later.id}.json`);
    const stored=JSON.parse(await fs.readFile(file,'utf8'));
    stored.analysis.coverage.notes=123456;
    await fs.writeFile(file,JSON.stringify(stored,null,2),'utf8');

    const listing=await listSnapshots(dir,'prj_list');
    assert.equal(listing.length,2);
    assert.equal(listing[0].id,earlier.id);
    assert.equal(listing[1].id,later.id);
    assert.equal(Date.parse(listing[1].createdAt),Date.parse('2026-10-11T00:00:00Z'));
    assert.equal(listing[1].integrityStatus.verified,false);
    await assert.rejects(()=>loadSnapshot(dir,'prj_list',listing.at(-1).id),IntegrityError);
  } finally {
    await fs.rm(dir,{recursive:true,force:true});
  }
});

test('Evidence Pack v1.2 checksum detects mutation but remains explicitly unauthenticated without a key',async()=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'xhs-pack-'));
  try{
    const snapshot=await saveSnapshot(dir,'prj_pack',harvest());
    const pack=buildEvidencePack({id:'prj_pack',name:'Pack Test'},snapshot);
    assert.equal(pack.schemaVersion,'xhs-evidence-pack/1.2');
    assert.ok(pack.snapshot.integrity?.digest);
    assert.equal(pack.integrity.authenticated,false);
    const verification=verifyEvidencePack(pack);
    assert.equal(verification.ok,true);
    assert.equal(verification.authenticated,false);
    assert.equal(verification.checksumOnly,true);
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
