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
async function request(url,opts={}) {
  const r=await fetch(base+url,{headers:{'content-type':'application/json'},...opts});
  const t=await r.text();
  if(!r.ok) throw new Error(`${r.status} ${t}`);
  return (r.headers.get('content-type')||'').includes('json') ? JSON.parse(t) : t;
}

try {
  let ready=false;
  for(let i=0;i<40;i++) {
    try { if((await request('/api/health')).ok){ready=true;break;} } catch {}
    await sleep(50);
  }
  assert.equal(ready,true,'server did not start');

  const templates=await request('/api/templates');
  assert.ok(templates.templates.length>=3);

  const project=await request('/api/projects',{method:'POST',body:JSON.stringify({name:'Smoke',category:'防晒',keywords:['敏感肌防晒'],competitors:['A']})});
  const demo=JSON.parse(await fs.readFile(path.join(root,'public','demo-harvest.json'),'utf8'));
  const s1=await request(`/api/projects/${project.id}/ingest`,{method:'POST',body:JSON.stringify(demo)});
  assert.equal(s1.analysis.coverage.notes,3);
  assert.equal(s1.analysis.coverage.comments,8);
  assert.equal(s1.analysis.rankings.byKeyword['敏感肌防晒'][0].rankingPosition,2);
  assert.ok(s1.analysis.evidenceClusters.length>0);
  assert.equal(s1.analysis.signals.complaints.examples.some(x=>x.content.includes('眼睛不刺痛，通勤很好用')),false);

  const d2=structuredClone(demo);
  d2.source.capturedAt='2026-10-10T16:00:00Z';
  d2.notes[0].stats.likes += 2000;
  d2.notes.push({noteId:'demo4',title:'敏感肌防晒新选择',desc:'',author:{userId:'u4',nickname:'新作者'},stats:{likes:500,collects:300,comments:20,shares:10},tags:['敏感肌'],sourceUrl:'https://www.xiaohongshu.com/explore/demo4',comments:[{id:'c9',content:'这个会辣眼吗？',likes:12,user:'L'}]});
  d2.queries[0].results[0].rankingPosition=1;
  d2.queries[0].results[1].rankingPosition=8;
  d2.queries[0].results.push({noteId:'demo4',rankingPosition:4,title:'敏感肌防晒新选择',author:'新作者'});
  await request(`/api/projects/${project.id}/ingest`,{method:'POST',body:JSON.stringify(d2)});

  const diff=(await request(`/api/projects/${project.id}/diff`)).diff;
  assert.equal(diff.addedNotes.length,1);
  assert.ok(diff.topMovers[0].score>=2000);
  assert.ok(diff.rankings.changed.length>=2);
  assert.ok(diff.rankings.entered.length>=1);

  const term=s1.analysis.evidenceClusters[0].term;
  const evidence=await request(`/api/projects/${project.id}/evidence?term=${encodeURIComponent(term)}`);
  assert.equal(evidence.clusters.length,1);

  const report=await request(`/api/projects/${project.id}/report`);
  assert.match(report,/Search visibility/);
  assert.match(report,/Search rank changes/);
  const csv=await request(`/api/projects/${project.id}/export.csv`);
  assert.match(csv,/noteId,title,author/);

  console.log(JSON.stringify({ok:true,notes:s1.analysis.coverage.notes,comments:s1.analysis.coverage.comments,rankChanges:diff.rankings.changed.length,entered:diff.rankings.entered.length,clusters:s1.analysis.evidenceClusters.length},null,2));
} finally {
  child.kill('SIGTERM');
}
