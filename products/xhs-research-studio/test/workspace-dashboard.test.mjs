import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mutateProjects, saveSnapshot } from '../lib/storage.mjs';
import { createRun, transitionRun } from '../lib/runs.mjs';
import { createSchedule, recordScheduleRun } from '../lib/schedules.mjs';
import { buildWorkspaceDashboard } from '../lib/workspace-dashboard.mjs';

const root=path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const demo=JSON.parse(await fs.readFile(path.join(root,'public','demo-harvest.json'),'utf8'));

async function makeProject(dataDir,{id,name,workspaceId}){
  const project={id,name,slug:id,workspaceId,client:'Agency Client',category:'防晒',keywords:['敏感肌防晒'],competitors:[],createdAt:'2026-10-10T00:00:00.000Z',updatedAt:'2026-10-10T00:00:00.000Z'};
  await mutateProjects(dataDir,rows=>{rows.push(project);return project});
  return project;
}

test('workspace dashboard aggregates only scoped projects with stable traceable alerts and nearest schedule',async()=>{
  const dataDir=await fs.mkdtemp(path.join(os.tmpdir(),'xhs-workspace-dashboard-'));
  try{
    const a=await makeProject(dataDir,{id:'prj_a',name:'Brand A',workspaceId:'wsp_agency'});
    const b=await makeProject(dataDir,{id:'prj_b',name:'Brand B',workspaceId:'wsp_agency'});
    await makeProject(dataDir,{id:'prj_other',name:'Other Workspace',workspaceId:'wsp_other'});

    const first=structuredClone(demo);first.source.capturedAt='2026-10-10T01:00:00Z';
    const snapshot=await saveSnapshot(dataDir,a.id,first);
    const completed=await createRun(dataDir,a,{budget:{maxNotes:20,maxComments:100,maxSeconds:30}});
    await transitionRun(dataDir,a.id,completed.id,'running');
    await transitionRun(dataDir,a.id,completed.id,'completed',{
      snapshotId:snapshot.id,counts:{notes:3,comments:8,queries:2},riskState:'NORMAL',
      attention:[{level:'high',type:'rank-drop',title:'Search rank dropped: 敏感肌防晒',detail:'Brand A #2 → #8'}],
    });

    const manual=await createRun(dataDir,b,{budget:{maxNotes:20,maxComments:100,maxSeconds:30}});
    await transitionRun(dataDir,b.id,manual.id,'running');
    await transitionRun(dataDir,b.id,manual.id,'manual_action_required',{riskState:'CAPTCHA',stoppedBecause:'CAPTCHA requires operator handoff.'});

    const later=await createSchedule(dataDir,a.id,{intervalMinutes:1440,startAt:'2026-10-12T00:00:00Z'});
    const sooner=await createSchedule(dataDir,a.id,{intervalMinutes:1440,startAt:'2026-10-11T00:00:00Z'});
    await recordScheduleRun(dataDir,later.id,{state:'skipped_overlap',error:'Previous run still active.',at:'2026-10-10T02:00:00Z'});

    const projects=[a,b,{id:'prj_other',name:'Other Workspace',workspaceId:'wsp_other'}];
    const one=await buildWorkspaceDashboard(dataDir,{workspaceId:'wsp_agency',projects});
    const two=await buildWorkspaceDashboard(dataDir,{workspaceId:'wsp_agency',projects});

    assert.equal(one.schemaVersion,'xhs-workspace-dashboard/1.0');
    assert.equal(one.summary.projects,2);
    assert.equal(one.summary.manualActionRequired,1);
    assert.equal(one.summary.enabledSchedules,2);
    assert.ok(one.summary.highAlerts>=2);
    assert.deepEqual(one.projects.map(row=>row.id).sort(),['prj_a','prj_b']);
    const projectA=one.projects.find(row=>row.id==='prj_a');
    assert.equal(projectA.schedules.nextRunAt,sooner.nextRunAt,'dashboard must expose the nearest enabled schedule, not the latest one');

    const rankAlert=one.alerts.find(alert=>alert.type==='rank-drop');
    assert.ok(rankAlert);
    assert.equal(rankAlert.projectId,a.id);
    assert.equal(rankAlert.snapshotId,snapshot.id);
    assert.match(rankAlert.source.run,/\/api\/projects\/prj_a\/runs\//u);
    assert.match(rankAlert.source.snapshot,/\/api\/projects\/prj_a\/snapshots\//u);

    const manualAlert=one.alerts.find(alert=>alert.type==='manual-action-required');
    assert.equal(manualAlert.level,'high');
    assert.match(manualAlert.detail,/CAPTCHA/u);
    assert.ok(one.alerts.some(alert=>alert.type==='schedule-overlap'));

    assert.deepEqual(one.alerts.map(alert=>alert.id),two.alerts.map(alert=>alert.id),'derived alert IDs must be deterministic so acknowledgement/webhook delivery can deduplicate safely');
  }finally{
    await fs.rm(dataDir,{recursive:true,force:true});
  }
});
