import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root=path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const html=await fs.readFile(path.join(root,'public','index.html'),'utf8');
const modelFile=path.join(root,'public','digest-model.js');
const uiFile=path.join(root,'public','digest-ui.js');
const model=await fs.readFile(modelFile,'utf8');
const ui=await fs.readFile(uiFile,'utf8');

test('hosted shell loads syntax-valid digest model before digest UI',()=>{
  for(const file of [modelFile,uiFile]){
    const checked=spawnSync(process.execPath,['--check',file],{encoding:'utf8'});
    assert.equal(checked.status,0,checked.stderr||checked.stdout);
  }
  assert.match(html,/<script src="\/digest-model\.js"><\/script><script src="\/digest-ui\.js"><\/script>/u);
});

test('weekly digest UI is read-only and uses existing workspace-scoped project/snapshot/diff/branding APIs',()=>{
  assert.match(ui,/window\.XHS_STUDIO_READY/u);
  assert.match(ui,/\/api\/projects/u);
  assert.match(ui,/\/snapshots\//u);
  assert.match(ui,/\/diff/u);
  assert.match(ui,/\/branding/u);
  assert.doesNotMatch(ui,/method\s*:\s*['"](?:POST|PATCH|PUT|DELETE)/u);
});

test('weekly digest model requires traceable evidence for emerging themes and states non-generalization limits',()=>{
  assert.match(model,/evidenceIds/u);
  assert.match(model,/filter\(row=>row\.evidence\)/u);
  assert.match(model,/not population prevalence estimates/u);
  assert.match(model,/not universal platform rank/u);
  assert.match(model,/transparent lexicon rules/u);
});

test('weekly digest preview escapes generated markdown before placing it in DOM',()=>{
  assert.match(ui,/<pre id="digestText">\$\{esc\(markdown\)\}<\/pre>/u);
  assert.match(ui,/navigator\.clipboard\.writeText\(markdown\)/u);
  assert.match(ui,/text\/markdown;charset=utf-8/u);
});
