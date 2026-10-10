import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root=path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const html=await fs.readFile(path.join(root,'public','index.html'),'utf8');
const file=path.join(root,'public','saved-templates-ui.js');
const source=await fs.readFile(file,'utf8');

test('hosted shell loads a syntax-valid saved-templates module after app bootstrap',()=>{
  const checked=spawnSync(process.execPath,['--check',file],{encoding:'utf8'});
  assert.equal(checked.status,0,checked.stderr||checked.stdout);
  assert.match(html,/<script src="\/saved-templates-ui\.js"><\/script>/u);
  assert.ok(html.indexOf('/saved-templates-ui.js')>html.indexOf('/app.js'));
});

test('saved templates UI persists only research setup and deliberately clears client when applying',()=>{
  assert.match(source,/category:currentProject\.category/u);
  assert.match(source,/keywords:currentProject\.keywords/u);
  assert.match(source,/competitors:currentProject\.competitors/u);
  assert.doesNotMatch(source,/client:currentProject\.client/u);
  assert.match(source,/target\.elements\.client\.value=''/u);
});

test('saved templates UI waits for hosted readiness, escapes library text, and mutates only template endpoints',()=>{
  assert.match(source,/window\.XHS_STUDIO_READY/u);
  assert.match(source,/esc\(template\.name\)/u);
  assert.match(source,/method:'POST'/u);
  assert.match(source,/method:'DELETE'/u);
  assert.match(source,/\/templates/u);
  assert.doesNotMatch(source,/method:'(?:PATCH|PUT)'/u);
});
