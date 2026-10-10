import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { HostedStore } from '../lib/hosted-db.mjs';
import { createHostedRunPolicy } from '../lib/hosted-policy.mjs';

test('hosted run resume revalidates entitlement without consuming a second monthly run',async()=>{
  const dataDir=await fs.mkdtemp(path.join(os.tmpdir(),'xhs-hosted-policy-'));
  const store=new HostedStore(dataDir);
  try{
    const created=store.register({email:'resume@example.test',password:'resume-test-password-1234',workspaceName:'Resume'});
    const workspaceId=created.workspace.id;
    store.setEntitlement(workspaceId,{plan:'pilot',status:'active',maxProjects:2,maxRunsMonth:1,maxNotesRun:20,maxCommentsRun:100});
    const policy=createHostedRunPolicy(store),project={id:'prj_resume',workspaceId},budget={maxNotes:20,maxComments:100,maxSeconds:30};

    await policy.beforeRun(project,{budget,trigger:'manual',resume:false});
    assert.equal(store.usage(workspaceId).runs,1);

    await policy.beforeRun(project,{budget,trigger:'resume',resume:true,runId:'run_same'});
    assert.equal(store.usage(workspaceId).runs,1,'resume of the same run must not consume another monthly run');

    store.setEntitlement(workspaceId,{status:'canceled'});
    await assert.rejects(
      ()=>policy.beforeRun(project,{budget,trigger:'resume',resume:true,runId:'run_same'}),
      error=>error?.code==='ENTITLEMENT_REQUIRED'&&error?.statusCode===402,
    );
    assert.equal(store.usage(workspaceId).runs,1);
  }finally{
    store.close();
    await fs.rm(dataDir,{recursive:true,force:true});
  }
});
