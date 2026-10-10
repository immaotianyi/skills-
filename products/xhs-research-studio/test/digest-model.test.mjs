import test from 'node:test';
import assert from 'node:assert/strict';
await import('../public/digest-model.js');
const {buildDigest,digestMarkdown,evidenceForTerm}=globalThis.XHS_DIGEST_MODEL;

function analysis({riskState='NORMAL',complaints=1,purchaseIntent=2}={}){
  return {
    quality:{status:'good',score:94,warnings:['1 explicit coverage gap(s)']},
    coverage:{notes:3,comments:8,authors:3,gaps:['demo gap'],riskState},
    signals:{questions:{count:2},complaints:{count:complaints},purchaseIntent:{count:purchaseIntent},positive:{count:3}},
    evidenceClusters:[{
      term:'搓泥',count:3,
      comments:[{id:'c7',noteId:'demo3',content:'搓泥翻车'},{id:'c8',noteId:'demo3',content:'有没有不搓泥'}],
      notes:[{noteId:'demo3',title:'防晒搓泥',sourceUrl:'https://www.xiaohongshu.com/explore/demo3'}],
    }],
  };
}

const project={id:'prj_digest',name:'敏感肌防晒周报',client:'Client A',category:'防晒'};
const previous={id:'snap_old',createdAt:'2026-10-01T00:00:00Z',analysis:analysis({complaints:1,purchaseIntent:1})};
const latest={id:'snap_new',createdAt:'2026-10-08T00:00:00Z',analysis:analysis({complaints:3,purchaseIntent:2})};
const diff={
  from:'2026-10-01T00:00:00Z',to:'2026-10-08T00:00:00Z',
  alerts:[{level:'medium',type:'complaint-growth',title:'Complaint signals increased by 2',detail:'1 → 3'}],
  rankings:{changed:[{keyword:'敏感肌防晒',noteId:'demo1',title:'夏天通勤防晒实测',before:2,after:6,delta:-4,sourceUrl:'https://www.xiaohongshu.com/explore/demo1'}]},
  themeDelta:[{term:'搓泥',before:1,after:3,delta:2},{term:'没有证据',before:0,after:9,delta:9}],
  addedNotes:[{noteId:'demo4',title:'新品测试 #1',sourceUrl:'https://www.xiaohongshu.com/explore/demo4'}],
  before:previous.analysis,after:latest.analysis,
};

test('weekly digest includes only emerging themes backed by traceable cluster evidence',()=>{
  const row=evidenceForTerm(latest.analysis,'搓泥');
  assert.deepEqual(row,{term:'搓泥',count:3,evidenceIds:['c7','c8','demo3'],sourceUrls:['https://www.xiaohongshu.com/explore/demo3']});
  assert.equal(evidenceForTerm(latest.analysis,'没有证据'),null);

  const digest=buildDigest({project,latestSnapshot:latest,previousSnapshot:previous,diff,branding:{agencyName:'North Star',reportTitle:'Client Weekly Intelligence',footerText:'Confidential'},generatedAt:'2026-10-08T01:00:00Z'});
  assert.equal(digest.schemaVersion,'xhs-client-digest/1.0');
  assert.equal(digest.emergingTerms.length,1);
  assert.equal(digest.emergingTerms[0].term,'搓泥');
  assert.deepEqual(digest.emergingTerms[0].evidenceIds,['c7','c8','demo3']);
  assert.equal(digest.observedSignals.complaints,undefined);
  assert.deepEqual(digest.observedSignals.before,{questions:2,complaints:1,purchaseIntent:1,positive:3});
  assert.deepEqual(digest.observedSignals.after,{questions:2,complaints:3,purchaseIntent:2,positive:3});
});

test('weekly digest markdown preserves evidence references and explicit interpretation limits',()=>{
  const digest=buildDigest({project,latestSnapshot:latest,previousSnapshot:previous,diff,branding:{agencyName:'North Star',reportTitle:'Client Weekly Intelligence',footerText:'Confidential'},generatedAt:'2026-10-08T01:00:00Z'});
  const markdown=digestMarkdown(digest);
  assert.match(markdown,/Client Weekly Intelligence/u);
  assert.match(markdown,/搓泥/u);
  assert.match(markdown,/`c7`/u);
  assert.match(markdown,/`demo3`/u);
  assert.match(markdown,/https:\/\/www\.xiaohongshu\.com\/explore\/demo3/u);
  assert.match(markdown,/Counts and ranking positions describe the captured evidence only/u);
  assert.match(markdown,/not population prevalence estimates/u);
  assert.doesNotMatch(markdown,/没有证据/u);
  assert.match(markdown,/Questions: 2 → 2/u);
  assert.match(markdown,/Complaints: 1 → 3/u);
});

test('weekly digest sanitizes markdown control characters in persisted names',()=>{
  const digest=buildDigest({project:{...project,name:'# injected\nheading'},latestSnapshot:latest,previousSnapshot:previous,diff,branding:{reportTitle:'*danger* [link](javascript:1)'}});
  const markdown=digestMarkdown(digest);
  assert.match(markdown,/\\\*danger\\\*/u);
  assert.match(markdown,/\\\[link\\\]\\\(javascript:1\\\)/u);
  assert.doesNotMatch(markdown,/^# injected$/mu);
});
