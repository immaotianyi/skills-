import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { normalizeHarvest } from '../lib/normalize.mjs';
import { analyze, diffHarvest } from '../lib/analysis.mjs';
import { ensureData, loadSnapshot } from '../lib/storage.mjs';

function makeHarvest({notes=500, commentsPerNote=10, capturedAt='2026-10-10T00:00:00Z', likeDelta=0}={}) {
  const rawNotes=[];
  const comments=[];
  for (let i=0;i<notes;i++) {
    const noteId=`scale-${i}`;
    rawNotes.push({
      noteId,
      title:`防晒产品体验 ${i}`,
      author:{userId:`u${i}`,nickname:`作者${i}`},
      stats:{likes:i+likeDelta,collects:i%100,comments:commentsPerNote,shares:i%20},
      tags:['防晒','敏感肌'],
      sourceUrl:`https://example.test/note/${i}`,
      captureMethod:'initial_state',
      confidence:.98,
    });
    for (let j=0;j<commentsPerNote;j++) {
      comments.push({
        id:`c-${i}-${j}`,
        noteId,
        content:j%4===0?'这个防晒会辣眼吗？':j%4===1?'不辣眼，通勤很好用':j%4===2?'多少钱？想买':'有点搓泥，但是可以接受',
        likes:j,
        user:`访客${j}`,
        sourceUrl:`https://example.test/note/${i}`,
      });
    }
  }
  return normalizeHarvest({
    schemaVersion:'2.0',
    source:{platform:'xiaohongshu',capturedAt,entry:'search',captureMethod:'initial_state'},
    notes:rawNotes,
    comments,
    authors:[],
    queries:[{keyword:'敏感肌防晒',capturedAt,results:rawNotes.slice(0,100).map((n,i)=>({noteId:n.noteId,rankingPosition:i+1,sourceUrl:n.sourceUrl,title:n.title,author:n.author.nickname}))}],
    meta:{collected:notes,deduped:notes,gaps:[],loginRequired:false,riskState:'NORMAL',sampleBudget:notes,stoppedBecause:'scale-test'},
  });
}

test('old snapshot analysis is recomputed in memory for current report consumers', async () => {
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'xhs-compat-test-'));
  try {
    await ensureData(dir);
    const projectId='prj_legacy';
    const snapshotId='snap_legacy';
    const snapshotDir=path.join(dir,'snapshots',projectId);
    await fs.mkdir(snapshotDir,{recursive:true});
    const harvest=makeHarvest({notes:2,commentsPerNote:2});
    const legacy={
      id:snapshotId,
      projectId,
      createdAt:harvest.source.capturedAt,
      harvest,
      analysis:{coverage:{notes:2,comments:4,authors:2,gaps:[],riskState:'NORMAL'}},
    };
    await fs.writeFile(path.join(snapshotDir,`${snapshotId}.json`),JSON.stringify(legacy),'utf8');
    const loaded=await loadSnapshot(dir,projectId,snapshotId);
    assert.equal(loaded.migration.analysisRecomputedInMemory,true);
    assert.ok(loaded.analysis.quality);
    assert.ok(loaded.analysis.methodology);
    assert.ok(loaded.analysis.engagement.model);
    assert.ok(Array.isArray(loaded.analysis.evidenceClusters));
  } finally {
    await fs.rm(dir,{recursive:true,force:true});
  }
});

test('500 notes / 5,000 comments analyze and diff within a generous CI budget', () => {
  const before=makeHarvest({notes:500,commentsPerNote:10,capturedAt:'2026-10-10T00:00:00Z'});
  const after=makeHarvest({notes:500,commentsPerNote:10,capturedAt:'2026-10-11T00:00:00Z',likeDelta:100});
  const start=performance.now();
  const first=analyze(before);
  const diff=diffHarvest(before,after);
  const elapsedMs=performance.now()-start;
  assert.equal(first.coverage.notes,500);
  assert.equal(first.coverage.comments,5000);
  assert.equal(diff.topMovers.length,20);
  assert.ok(diff.topMovers.every(x=>x.delta.likes===100));
  assert.ok(elapsedMs<10000,`analysis+diff took ${elapsedMs.toFixed(1)}ms`);
  console.log(JSON.stringify({scale:{notes:500,comments:5000,elapsedMs:Number(elapsedMs.toFixed(1))}}));
});
