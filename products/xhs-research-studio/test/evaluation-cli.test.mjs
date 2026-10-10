import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const execFileAsync=promisify(execFile);
const root=path.dirname(path.dirname(fileURLToPath(import.meta.url)));

test('evaluate-signals CLI reads JSONL and writes an auditable report',async()=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'xhs-eval-cli-'));
  try{
    const input=path.join(dir,'labels.jsonl');
    const output=path.join(dir,'report.json');
    const records=[
      {id:'a',content:'这个太贵了，辣眼',labels:{complaints:true},reviewer:'alice',category:'防晒'},
      {id:'b',content:'多少钱？想买',labels:{questions:true,purchaseIntent:true},reviewer:'bob',category:'防晒'},
    ];
    await fs.writeFile(input,records.map(x=>JSON.stringify(x)).join('\n')+'\n','utf8');
    const {stdout,stderr}=await execFileAsync(process.execPath,[path.join(root,'evaluate-signals.mjs'),input,'--out',output],{encoding:'utf8'});
    assert.equal(stderr,'');
    assert.equal(stdout.trim(),output);
    const report=JSON.parse(await fs.readFile(output,'utf8'));
    assert.equal(report.schemaVersion,'xhs-signal-evaluation/2.0');
    assert.equal(report.audit.sampleSize,2);
    assert.equal(report.perClass.complaints.tp,1);
    assert.equal(report.perClass.purchaseIntent.tp,1);
    assert.ok(report.perClass.complaints.precision95);
    assert.equal(report.claimGate.eligibleForValidatedClassifierClaim,false);
  } finally {
    await fs.rm(dir,{recursive:true,force:true});
  }
});
