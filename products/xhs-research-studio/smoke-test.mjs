#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'xhs-studio-'));
const port = 55418 + Math.floor(Math.random() * 300);
const child = spawn(process.execPath, [path.join(root,'server.mjs')], {
  env:{...process.env,PORT:String(port),XHS_STUDIO_DATA:dataDir},
  stdio:['ignore','pipe','pipe'],
});
const base=`http://127.0.0.1:${port}`;
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function rawRequest(url,opts={}) {
  return await fetch(base+url,{headers:{'content-type':'application/json',...(opts.headers||{})},...opts});
}
async function request(url,opts={}) {
  const r=await rawRequest(url,opts);
  const t=await r.text();
  if(!r.ok) throw new Error(`${r.status} ${t}`);
  return (r.headers.get('content-type')||'').includes('json') ? JSON.parse(t) : t;
}

try {
  let ready=false;
  for(let i=0;i<60;i++) {
    try { if((await request('/api/health')).ok){ready=true;break;} } catch {}
    await sleep(50);
  }
  assert.equal(ready,true,'server did not start');

  const health=await request('/api/health');
  assert.equal(health.version,'0.3.0-hardening');

  const templates=await request('/api/templates');
  assert.ok(templates.templates.length>=3);

  const demo=JSON.parse(await fs.readFile(path.join(root,'public','demo-harvest.json'),'utf8'));
  const validation=await request('/api/validate',{method:'POST',body:JSON.stringify(demo)});
  assert.equal(validation.ok,true);
  assert.equal(validation.summary.notes,3);
  assert.equal(validation.summary.riskState,'NORMAL');

  const malformed=await rawRequest('/api/validate',{method:'POST',body:JSON.stringify({schemaVersion:'2.0',notes:{bad:true}})});
  assert.equal(malformed.status,422);
  const malformedBody=await malformed.json();
  assert.equal(malformedBody.ok,false);
  assert.ok(malformedBody.errors.length>0);

  const invalidJson=await rawRequest('/api/analyze',{method:'POST',body:'{"broken":'});
  assert.equal(invalidJson.status,400);
  assert.match((await invalidJson.json()).error,/Invalid JSON/);

  const emptyProject=await rawRequest('/api/projects',{method:'POST',body:JSON.stringify({name:'   '})});
  assert.equal(emptyProject.status,400);

  const project=await request('/api/projects',{method:'POST',body:JSON.stringify({name:'Smoke',category:'防晒',keywords:['敏感肌防晒'],competitors:['A']})});
  const s1=await request(`/api/projects/${project.id}/ingest`,{method:'POST',body:JSON.stringify(demo)});
  assert.equal(s1.harvest.schemaVersion,'2.0');
  assert.equal(s1.analysis.coverage.notes,3);
  assert.equal(s1.analysis.coverage.comments,8);
  assert.equal(s1.analysis.rankings.byKeyword['敏感肌防晒'][0].rankingPosition,2);
  assert.ok(s1.analysis.evidenceClusters.length>0);
  assert.equal(s1.analysis.evidenceClusters.every(x=>x.method==='lexical-comment-frequency'),true);
  assert.equal(s1.analysis.signals.complaints.examples.some(x=>x.content.includes('眼睛不刺痛，通勤很好用')),false);
  assert.equal(s1.analysis.quality.status,'good');
  assert.ok(s1.analysis.quality.warnings.some(x=>x.includes('coverage gap')));
  assert.ok(s1.analysis.methodology.signalModel.includes('not a trained sentiment model'));

  const d2=structuredClone(demo);
  d2.source.capturedAt='2026-10-10T16:00:00Z';
  d2.notes[0].stats.likes += 2000;
  d2.notes.push({noteId:'demo4',title:'敏感肌防晒新选择',desc:'',author:{userId:'u4',nickname:'新作者'},stats:{likes:500,collects:300,comments:20,shares:10},tags:['敏感肌'],sourceUrl:'https://www.xiaohongshu.com/explore/demo4',captureMethod:'initial_state',confidence:.98,comments:[{id:'c9',noteId:'demo4',content:'这个会辣眼吗？',likes:12,user:'L',sourceUrl:'https://www.xiaohongshu.com/explore/demo4'}]});
  d2.queries[0].results[0].rankingPosition=1;
  d2.queries[0].results[1].rankingPosition=8;
  d2.queries[0].results.push({noteId:'demo4',rankingPosition:4,title:'敏感肌防晒新选择',author:'新作者'});
  await request(`/api/projects/${project.id}/ingest`,{method:'POST',body:JSON.stringify(d2)});

  const diff=(await request(`/api/projects/${project.id}/diff`)).diff;
  assert.equal(diff.addedNotes.length,1);
  assert.ok(Array.isArray(diff.notObservedNotes));
  assert.ok(diff.topMovers[0].score>=2000);
  assert.ok(diff.rankings.changed.length>=2);
  assert.ok(diff.rankings.entered.length>=1);
  assert.ok(Array.isArray(diff.alerts));

  const term=s1.analysis.evidenceClusters[0].term;
  const evidence=await request(`/api/projects/${project.id}/evidence?term=${encodeURIComponent(term)}`);
  assert.equal(evidence.clusters.length,1);

  const report=await request(`/api/projects/${project.id}/report`);
  assert.match(report,/Search visibility/);
  assert.match(report,/Search rank changes/);
  assert.match(report,/Methodology \/ interpretation limits/);
  assert.match(report,/Previously observed notes not present in current sample/);

  const csvResponse=await rawRequest(`/api/projects/${project.id}/export.csv`);
  assert.equal(csvResponse.status,200);
  assert.match(csvResponse.headers.get('content-disposition')||'',/attachment/);
  assert.match(await csvResponse.text(),/noteId,title,author/);

  const packResponse=await rawRequest(`/api/projects/${project.id}/evidence-pack`);
  assert.equal(packResponse.status,200);
  const pack=await packResponse.json();
  assert.equal(pack.schemaVersion,'xhs-evidence-pack/1.1');
  assert.equal(pack.project.id,project.id);
  assert.ok(pack.methodology);
  assert.ok(Array.isArray(pack.sources));

  const missingSnapshot=await rawRequest(`/api/projects/${project.id}/snapshots/nope`);
  assert.equal(missingSnapshot.status,404);

  const home=await rawRequest('/',{headers:{accept:'text/html'}});
  assert.equal(home.status,200);
  assert.equal(home.headers.get('x-content-type-options'),'nosniff');
  assert.match(home.headers.get('content-security-policy')||'',/default-src 'self'/);

  console.log(JSON.stringify({
    ok:true,
    version:health.version,
    notes:s1.analysis.coverage.notes,
    comments:s1.analysis.coverage.comments,
    rankChanges:diff.rankings.changed.length,
    entered:diff.rankings.entered.length,
    clusters:s1.analysis.evidenceClusters.length,
    quality:s1.analysis.quality,
    evidencePackSources:pack.sources.length,
  },null,2));
} finally {
  child.kill('SIGTERM');
  await fs.rm(dataDir,{recursive:true,force:true});
}
