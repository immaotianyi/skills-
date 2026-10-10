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
  assert.equal(health.version,'0.4.0-hosted-beta');
  assert.equal(health.hosted,false,'default local mode must remain non-hosted unless explicitly enabled');

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

  const s2=await request(`/api/projects/${project.id}/ingest`,{method:'POST',body:JSON.stringify(d2)});
  assert.equal(s2.analysis.coverage.notes,4);

  const projectView=await request(`/api/projects/${project.id}`);
  assert.equal(projectView.snapshots.length,2);

  const diff=await request(`/api/projects/${project.id}/diff`);
  assert.equal(diff.diff.added.length,1);
  assert.ok(diff.diff.topMovers.some(x=>x.noteId==='demo1'));
  assert.ok(diff.diff.rankChanges.some(x=>x.noteId==='demo1'));
  assert.ok(diff.diff.alerts.some(x=>x.type==='rank_drop'));
  assert.ok(diff.diff.alerts.some(x=>x.type==='new_high_signal_note'));

  const evidence=await request(`/api/projects/${project.id}/evidence?term=辣眼`);
  assert.ok(Array.isArray(evidence.clusters));

  const report=await request(`/api/projects/${project.id}/report`);
  assert.match(report,/研究方法/);
  assert.match(report,/局限/);

  const csv=await request(`/api/projects/${project.id}/export.csv`);
  assert.match(csv,/noteId,title,author/);

  const pack=await request(`/api/projects/${project.id}/evidence-pack?version=1.2`);
  assert.equal(pack.schemaVersion,'xhs-evidence-pack/1.2');
  assert.equal(pack.integrity.algorithm,'sha256');

  const notFound=await rawRequest('/api/does-not-exist');
  assert.equal(notFound.status,404);
  assert.equal(notFound.headers.get('x-content-type-options'),'nosniff');

  const traversal=await rawRequest('/..%2Fserver.mjs');
  assert.equal(traversal.status,404);

  const huge=await rawRequest('/api/analyze',{method:'POST',body:'x'.repeat(15_000_001)});
  assert.equal(huge.status,413);

  console.log('XHS Research Studio API smoke test passed');
} finally {
  child.kill('SIGTERM');
  await new Promise(resolve=>child.once('exit',resolve));
  await fs.rm(dataDir,{recursive:true,force:true});
}
