import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { RunService } from '../lib/run-service.mjs';
import { mutateProjects, loadSnapshot } from '../lib/storage.mjs';
import { diffHarvest, evidenceClusters } from '../lib/analysis.mjs';

const root=path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const demoPath=path.join(root,'public','demo-harvest.json');
const mockExecutor=path.join(root,'test','fixtures','mock-harvest-executor.mjs');
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));

async function waitRun(service,projectId,runId){
  for(let i=0;i<280;i++){
    const run=await service.run(projectId,runId);
    if(['completed','failed','manual_action_required','cancelled'].includes(run?.state))return run;
    await sleep(25);
  }
  throw new Error('run did not reach terminal state');
}

async function withEnv(values,fn){
  const previous={};
  for(const [key,value] of Object.entries(values)){
    previous[key]=process.env[key];
    if(value===undefined)delete process.env[key];else process.env[key]=String(value);
  }
  try{return await fn()}finally{
    for(const [key,value] of Object.entries(previous)){
      if(value===undefined)delete process.env[key];else process.env[key]=value;
    }
  }
}

function changedSnapshot(base){
  const next=structuredClone(base);
  next.source.capturedAt='2026-10-10T02:00:00Z';
  next.notes[0].stats.likes+=2400;
  next.notes[0].stats.comments+=90;
  next.notes[0].comments.push(
    {id:'c9',content:'今天实测真的辣眼踩雷，出汗后更明显',likes:120,user:'SmokeA'},
    {id:'c10',content:'肤感油腻又难用，后续上妆也搓泥',likes:95,user:'SmokeB'},
    {id:'c11',content:'眼周刺激而且有点过敏，暂时不会回购',likes:88,user:'SmokeC'},
  );
  next.notes.push({
    noteId:'demo4',title:'新款敏感肌防晒首测',desc:'重点记录眼周刺激和肤感',
    author:{userId:'u4',nickname:'新样本观察员'},
    stats:{likes:1800,collects:900,comments:160,shares:80},
    tags:['敏感肌','防晒首测'],sourceUrl:'https://www.xiaohongshu.com/explore/demo4',
    captureMethod:'initial_state',confidence:0.97,
    comments:[{id:'c12',content:'这款也会辣眼，敏感肌要谨慎',likes:70,user:'SmokeD'}],
  });
  next.queries[0].capturedAt='2026-10-10T02:00:00Z';
  next.queries[0].results=next.queries[0].results.map(row=>row.noteId==='demo2'?{...row,rankingPosition:8}:row);
  next.queries[0].results.push({noteId:'demo4',rankingPosition:3,title:'新款敏感肌防晒首测',author:'新样本观察员',sourceUrl:'https://www.xiaohongshu.com/explore/demo4'});
  next.queries[1].capturedAt='2026-10-10T02:00:00Z';
  next.meta={...next.meta,collected:4,deduped:4,gaps:['Acceptance-test controlled snapshot; not a live platform sample']};
  return next;
}

test('paid-beta second run produces content/comment/rank diffs, attention alerts, and traceable theme evidence',async()=>{
  const dataDir=await fs.mkdtemp(path.join(os.tmpdir(),'xhs-paid-beta-acceptance-'));
  try{
    const project={id:'prj_paid_beta',slug:'paid-beta',name:'Paid Beta Acceptance',client:'Test',category:'防晒',keywords:['敏感肌防晒'],competitors:['A品牌'],createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()};
    await mutateProjects(dataDir,projects=>{projects.push(project);return project});
    const first=JSON.parse(await fs.readFile(demoPath,'utf8'));
    const second=changedSnapshot(first);
    const secondPath=path.join(dataDir,'second-harvest.json');
    await fs.writeFile(secondPath,JSON.stringify(second,null,2));

    await withEnv({
      XHS_STUDIO_HARVEST_EXECUTOR:process.execPath,
      XHS_STUDIO_HARVEST_EXECUTOR_ARGS:JSON.stringify([mockExecutor]),
      XHS_EXECUTOR_FIXTURE_PATH:demoPath,
      XHS_EXECUTOR_MODE:'success',
    },async()=>{
      const service=new RunService(dataDir,{schedulerTickMs:60_000});
      const firstQueued=await service.launch(project,{budget:{maxNotes:20,maxComments:100,maxSeconds:30}});
      const firstRun=await waitRun(service,project.id,firstQueued.id);
      assert.equal(firstRun.state,'completed');

      process.env.XHS_EXECUTOR_FIXTURE_PATH=secondPath;
      const secondQueued=await service.launch(project,{budget:{maxNotes:20,maxComments:100,maxSeconds:30}});
      const secondRun=await waitRun(service,project.id,secondQueued.id);
      assert.equal(secondRun.state,'completed');
      assert.ok(secondRun.snapshotId);

      const before=await loadSnapshot(dataDir,project.id,firstRun.snapshotId);
      const after=await loadSnapshot(dataDir,project.id,secondRun.snapshotId);
      const diff=diffHarvest(before.harvest,after.harvest);

      assert.ok(diff.addedNotes.some(note=>note.noteId==='demo4'),'second run must surface content additions');
      assert.ok(diff.themeDelta.some(item=>item.delta>0),'second run must surface comment/theme changes');
      assert.ok(diff.rankings.changed.some(item=>item.noteId==='demo2'&&item.before===2&&item.after===8),'second run must surface rank changes');
      assert.ok(diff.after.signals.complaints.count>diff.before.signals.complaints.count,'second run must surface complaint growth');

      const alertTypes=new Set(secondRun.attention.map(item=>item.type));
      assert.ok(alertTypes.has('complaint-growth'),'run attention must include complaint growth');
      assert.ok(alertTypes.has('rank-drop'),'run attention must include rank drop');
      assert.ok(alertTypes.has('new-high-signal-note'),'run attention must include a new high-signal note');

      const clusters=evidenceClusters(after.harvest);
      assert.ok(clusters.length>0,'at least one surfaced evidence theme is required');
      for(const cluster of clusters){
        assert.ok(cluster.term&&cluster.method==='lexical-comment-frequency');
        assert.ok(cluster.comments.length>0,`theme ${cluster.term} must expose supporting comments`);
        for(const comment of cluster.comments){
          assert.ok(comment.id&&comment.noteId,`theme ${cluster.term} comment must retain IDs`);
          assert.match(comment.sourceUrl||'',/^https?:\/\//u,`theme ${cluster.term} comment must retain a source URL`);
        }
        for(const note of cluster.notes){
          assert.ok(note.noteId,`theme ${cluster.term} note must retain noteId`);
          assert.match(note.sourceUrl||'',/^https?:\/\//u,`theme ${cluster.term} note must retain a source URL`);
        }
      }
    });
  }finally{
    await fs.rm(dataDir,{recursive:true,force:true});
  }
});
