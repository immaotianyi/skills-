import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root=path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const html=await fs.readFile(path.join(root,'public','index.html'),'utf8');
const uiFile=path.join(root,'public','client-delivery-ui.js');
const modelFile=path.join(root,'public','client-delivery-model.js');
const ui=await fs.readFile(uiFile,'utf8');
const model=await fs.readFile(modelFile,'utf8');

test('hosted shell loads syntax-valid client delivery as an ES module without replacing raw export controls',()=>{
  for(const file of [uiFile,modelFile]){const checked=spawnSync(process.execPath,['--check',file],{encoding:'utf8'});assert.equal(checked.status,0,checked.stderr||checked.stdout)}
  assert.match(html,/<script type="module" src="\/client-delivery-ui\.js"><\/script>/u);
  assert.match(html,/id="csvBtn"/u);
  assert.match(html,/id="packBtn"/u);
});

test('client delivery UI is read-only and composes only existing workspace/project evidence APIs',()=>{
  assert.match(ui,/XHS_STUDIO_READY/u);
  assert.match(ui,/\/api\/projects\//u);
  assert.match(ui,/\/snapshots\//u);
  assert.match(ui,/\/branding/u);
  assert.match(ui,/\/report/u);
  assert.match(ui,/evidence-pack\?version=1\.2/u);
  assert.doesNotMatch(ui,/method\s*:\s*['"](?:POST|PUT|PATCH|DELETE)['"]/u);
  assert.doesNotMatch(ui,/fetch\([^\n]+export\.csv/u);
});

test('delivery model preserves evidence provenance, formula hardening, envelope authentication boundary, and restrictive print CSP',()=>{
  for(const token of ['noteId','captureMethod','confidence','sourceUrl','canonicalEvidencePackUnmodified','envelopeAuthenticated:false','Content-Security-Policy','default-src \'none\''])assert.match(model,new RegExp(token.replace(/[.*+?^${}()|[\]\\]/gu,'\\$&'),'u'));
  assert.match(model,/\^\[=\+\\-@\]/u);
  assert.match(model,/not population prevalence/u);
  assert.match(model,/not a universal platform ranking/u);
});
