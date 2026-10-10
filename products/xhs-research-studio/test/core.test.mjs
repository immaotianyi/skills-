import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { num, normalizeHarvest } from '../lib/normalize.mjs';
import { validateHarvestInput, validateNormalizedHarvest } from '../lib/validation.mjs';
import { analyze, classifyComment, diffHarvest, engagementScore, evidenceClusters, topTokens, tokenize } from '../lib/analysis.mjs';
import { ensureData, listSnapshots, loadSnapshot, saveProjects, getProjects, saveSnapshot } from '../lib/storage.mjs';

function baseRaw(overrides={}) {
  return {
    schemaVersion:'2.0',
    source:{platform:'xiaohongshu',capturedAt:'2026-10-10T00:00:00Z',entry:'search',captureMethod:'initial_state'},
    notes:[],comments:[],authors:[],queries:[],
    meta:{gaps:[],loginRequired:false,riskState:'NORMAL'},
    ...overrides,
  };
}

test('num parses common social-count suffixes without negatives', () => {
  assert.equal(num('1.2万'), 12000);
  assert.equal(num('3.5w+'), 35000);
  assert.equal(num('2.1k'), 2100);
  assert.equal(num('1.1亿'), 110000000);
  assert.equal(num('-5'), 0);
  assert.equal(num('n/a'), 0);
});

test('normalizeHarvest always emits schema-valid v2 shape and preserves input schema provenance', () => {
  const normalized = normalizeHarvest({
    capturedAt:'2026-10-10T01:02:03Z',
    source:{entry:'search',captureMethod:'ocr'},
    notes:[
      {id:'n1',displayTitle:'测试',user:{userId:'u1',nickName:'作者'},interactInfo:{likedCount:'1.2万',collectedCount:'20'},url:'https://example.test/n1'},
      {id:'n1',displayTitle:'重复',user:{userId:'u1',nickName:'作者'},interactInfo:{}},
    ],
    comments:[{commentId:'c1',noteId:'n1',content:'会不会辣眼？',likeCount:'3',userInfo:{nickname:'A'}}],
    queries:[{keyword:'防晒',results:[{id:'n1',rank:0,displayTitle:'测试'}]}],
    meta:{loginRequired:true,riskState:'NORMAL'},
  });
  assert.equal(normalized.schemaVersion,'2.0');
  assert.equal(normalized.meta.inputSchemaVersion,'legacy/unknown');
  assert.equal(normalized.notes.length,1);
  assert.equal(normalized.notes[0].stats.likes,12000);
  assert.equal(normalized.notes[0].confidence,0.72);
  assert.equal(normalized.meta.riskState,'LOGIN_REQUIRED');
  assert.equal(normalized.authors.length,1);
  assert.equal(normalized.queries[0].results[0].rankingPosition,1);
  assert.equal(validateNormalizedHarvest(normalized).ok,true);
});

test('validator rejects structurally malformed v2 inputs', () => {
  const malformed = baseRaw({notes:{bad:true}});
  const result = validateHarvestInput(malformed);
  assert.equal(result.ok,false);
  assert.ok(result.errors.some(e=>e.path==='$.notes'));
  const missing = validateHarvestInput({schemaVersion:'2.0',source:{platform:'xiaohongshu',capturedAt:'bad',entry:'search'},meta:{riskState:'NORMAL',loginRequired:false,gaps:[]}});
  assert.equal(missing.ok,false);
  assert.ok(missing.errors.some(e=>e.path==='$.source.capturedAt'));
  assert.ok(missing.errors.some(e=>e.path==='$.comments'));
});

test('signal classifier suppresses local negation and keeps real intent', () => {
  const safe = classifyComment({content:'眼睛不刺痛，也不会回购这个色号'});
  assert.equal(safe.complaints.includes('刺痛'),false);
  assert.equal(safe.purchaseIntent.includes('回购'),false);
  assert.equal(safe.positive.includes('回购'),false);
  const complaint = classifyComment({content:'这个真的太贵了，而且有点辣眼'});
  assert.ok(complaint.complaints.includes('太贵') || complaint.complaints.includes('贵'));
  assert.ok(complaint.complaints.includes('辣眼'));
  const intent = classifyComment({content:'多少钱？哪里买，想买一个'});
  assert.ok(intent.questions.length>0);
  assert.ok(intent.purchaseIntent.includes('想买'));
});

test('tokenization uses word-like terms and counts each comment once per term', () => {
  const tokens = tokenize('敏感肌防晒真的很好用，敏感肌也不辣眼。');
  assert.ok(tokens.length>0);
  assert.equal(tokens.includes('真的'),false);
  const terms = topTokens([
    {content:'敏感肌 防晒 防晒 好用'},
    {content:'敏感肌 防晒 不辣眼'},
  ],10);
  const sunscreen = terms.find(x=>x.term==='防晒');
  if (sunscreen) assert.equal(sunscreen.count,2);
});

test('analysis exposes methodology, quality, lexical evidence and transparent engagement', () => {
  const h=normalizeHarvest(baseRaw({
    notes:[
      {noteId:'n1',title:'A',author:{userId:'u1',nickname:'甲'},stats:{likes:10,collects:2,comments:3,shares:4},sourceUrl:'https://example.test/n1',captureMethod:'initial_state',comments:[
        {id:'c1',content:'这个防晒有点辣眼，太贵了',likes:5,user:'A'},
        {id:'c2',content:'防晒哪里买？想买',likes:2,user:'B'},
      ]},
    ],
    comments:[],
  }));
  const a=analyze(h);
  assert.equal(a.methodology.evidenceClustering.includes('not semantic'),true);
  assert.equal(a.quality.status,'good');
  assert.equal(a.signals.complaints.count,1);
  assert.equal(a.signals.purchaseIntent.count,1);
  assert.equal(engagementScore(h.notes[0]),21);
  const clusters=evidenceClusters(h);
  assert.ok(clusters.length>0);
  assert.ok(clusters.every(x=>x.method==='lexical-comment-frequency'));
});

test('diff distinguishes not-observed notes from deletion and creates alerts', () => {
  const a=normalizeHarvest(baseRaw({
    source:{platform:'xiaohongshu',capturedAt:'2026-10-10T00:00:00Z',entry:'search',captureMethod:'initial_state'},
    notes:[{noteId:'n1',title:'A',author:{nickname:'甲'},stats:{likes:10,collects:0,comments:0,shares:0},sourceUrl:'https://example.test/n1'}],
    queries:[{keyword:'防晒',results:[{noteId:'n1',rankingPosition:1}]}],
  }));
  const b=normalizeHarvest(baseRaw({
    source:{platform:'xiaohongshu',capturedAt:'2026-10-11T00:00:00Z',entry:'search',captureMethod:'initial_state'},
    notes:[{noteId:'n2',title:'B',author:{nickname:'乙'},stats:{likes:2000,collects:0,comments:0,shares:0},sourceUrl:'https://example.test/n2'}],
    queries:[{keyword:'防晒',results:[{noteId:'n2',rankingPosition:2}]}],
  }));
  const d=diffHarvest(a,b);
  assert.equal(d.addedNotes.length,1);
  assert.equal(d.notObservedNotes.length,1);
  assert.equal(d.removedNotes.length,1);
  assert.ok(d.alerts.some(x=>x.type==='new-high-signal-note'));
});

test('storage writes valid snapshots and sorts by capturedAt rather than filename', async () => {
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'xhs-core-test-'));
  try {
    await ensureData(dir);
    await saveProjects(dir,[{id:'prj_test',name:'Test'}]);
    assert.equal((await getProjects(dir)).length,1);
    const later=await saveSnapshot(dir,'prj_test',baseRaw({source:{platform:'xiaohongshu',capturedAt:'2026-10-11T00:00:00Z',entry:'search',captureMethod:'initial_state'}}));
    const earlier=await saveSnapshot(dir,'prj_test',baseRaw({source:{platform:'xiaohongshu',capturedAt:'2026-10-10T00:00:00Z',entry:'search',captureMethod:'initial_state'}}));
    const list=await listSnapshots(dir,'prj_test');
    assert.equal(list[0].id,earlier.id);
    assert.equal(list[1].id,later.id);
    assert.equal((await loadSnapshot(dir,'prj_test',later.id)).harvest.schemaVersion,'2.0');
  } finally {
    await fs.rm(dir,{recursive:true,force:true});
  }
});
