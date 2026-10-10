import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPortfolioRow, buildPortfolioSummary } from '../lib/portfolio.mjs';

function note(noteId,title,likes=10){return {noteId,title,author:{nickname:'作者'},stats:{likes,collects:0,comments:0,shares:0},sourceUrl:`https://www.xiaohongshu.com/explore/${noteId}`,captureMethod:'initial_state',confidence:0.98,tags:[]}}
function comment(id,noteId,content){return {id,noteId,content,likes:1,user:'u',sourceUrl:`https://www.xiaohongshu.com/explore/${noteId}?comment=${id}`}}
function harvest({capturedAt,notes,comments,rank=1,riskState='NORMAL'}={}){
  return {
    schemaVersion:'2.0',
    source:{platform:'xiaohongshu',capturedAt,entry:'search',keyword:'测试',sourceUrl:'https://www.xiaohongshu.com/search_result?keyword=test',captureMethod:'initial_state'},
    notes,comments,authors:[],
    queries:[{keyword:'测试',capturedAt,results:[{noteId:'base',rankingPosition:rank,title:'基础笔记',sourceUrl:'https://www.xiaohongshu.com/explore/base'}]}],
    meta:{collected:notes.length,deduped:notes.length,gaps:[],loginRequired:false,riskState},
  };
}

test('portfolio row prioritizes diff alerts and preserves bounded evidence metadata',()=>{
  const previous={id:'snap_old',createdAt:'2026-10-01T00:00:00Z',harvest:harvest({
    capturedAt:'2026-10-01T00:00:00Z',rank:1,
    notes:[note('base','基础笔记',100)],comments:[comment('c1','base','通勤很好用')],
  })};
  const latest={id:'snap_new',createdAt:'2026-10-08T00:00:00Z',harvest:harvest({
    capturedAt:'2026-10-08T00:00:00Z',rank:6,
    notes:[note('base','基础笔记',100),note('new-hot','新高信号笔记',1800)],
    comments:[comment('c1','base','通勤很好用'),comment('c2','base','太贵踩雷'),comment('c3','base','真的难用'),comment('c4','new-hot','求链接怎么买')],
  })};
  const row=buildPortfolioRow({
    project:{id:'prj_a',name:'客户 A',client:'Brand A',category:'防晒',updatedAt:'2026-10-08T01:00:00Z'},
    previousSnapshot:previous,latestSnapshot:latest,
    latestRun:{id:'run_2',state:'completed',trigger:'schedule',updatedAt:'2026-10-08T00:05:00Z',snapshotId:'snap_new'},
  });
  assert.equal(row.projectId,'prj_a');
  assert.equal(row.latestSnapshotAt,'2026-10-08T00:00:00.000Z');
  assert.equal(row.latestRun.state,'completed');
  assert.equal(row.riskState,'NORMAL');
  assert.ok(row.coverage.notes>=2);
  assert.ok(row.coverage.comments>=4);
  const types=new Set(row.alerts.map(alert=>alert.type));
  assert.ok(types.has('rank-drop'));
  assert.ok(types.has('complaint-growth'));
  assert.ok(types.has('new-high-signal-note'));
  assert.equal(row.attentionLevel,'medium');
  assert.equal(row.needsAttention,true);
  assert.ok(row.alerts.every(alert=>!('comments' in alert)&&!('notes' in alert)),'portfolio must expose triage metadata, not duplicate raw evidence');
});

test('portfolio summary sorts hard-risk projects first and makes missing snapshots explicit',()=>{
  const blocked=buildPortfolioRow({
    project:{id:'prj_blocked',name:'Blocked',updatedAt:'2026-10-10T00:00:00Z'},
    latestSnapshot:{id:'snap_blocked',createdAt:'2026-10-10T00:00:00Z',harvest:harvest({capturedAt:'2026-10-10T00:00:00Z',notes:[note('base','基础笔记')],comments:[],riskState:'CAPTCHA'})},
    latestRun:{id:'run_blocked',state:'manual_action_required',riskState:'CAPTCHA',updatedAt:'2026-10-10T00:01:00Z'},
  });
  const empty=buildPortfolioRow({project:{id:'prj_empty',name:'No Snapshot',updatedAt:'2026-10-09T00:00:00Z'}});
  const normal=buildPortfolioRow({
    project:{id:'prj_normal',name:'Normal',updatedAt:'2026-10-08T00:00:00Z'},
    latestSnapshot:{id:'snap_normal',createdAt:'2026-10-08T00:00:00Z',harvest:harvest({capturedAt:'2026-10-08T00:00:00Z',notes:[note('base','基础笔记')],comments:[comment('c1','base','很好用')]})},
    latestRun:{id:'run_normal',state:'completed',updatedAt:'2026-10-08T00:02:00Z'},
  });
  const result=buildPortfolioSummary([normal,empty,blocked]);
  assert.deepEqual(result.summary,{totalProjects:3,withSnapshots:2,withoutSnapshots:1,needsAttention:2,highAttention:1,nonNormalRisk:1,failedOrManualRuns:1});
  assert.equal(result.projects[0].projectId,'prj_blocked');
  assert.equal(result.projects[0].attentionLevel,'high');
  assert.equal(result.projects.at(-1).projectId,'prj_normal');
});
