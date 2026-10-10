import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root=path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const html=await fs.readFile(path.join(root,'public','index.html'),'utf8');
const source=await fs.readFile(path.join(root,'public','portfolio.js'),'utf8');

test('hosted shell loads the agency portfolio module after existing app scripts',()=>{
  assert.match(html,/<script src="\/portfolio\.js"><\/script>/u);
  assert.ok(html.indexOf('/portfolio.js')>html.indexOf('/hosted-ui.js'));
  assert.ok(html.indexOf('/portfolio.js')>html.indexOf('/app.js'));
});

test('portfolio waits for hosted readiness and reuses read-only workspace-scoped APIs',()=>{
  assert.match(source,/window\.XHS_STUDIO_READY/u);
  assert.match(source,/json\('\/api\/projects'\)/u);
  assert.match(source,/\/snapshots/u);
  assert.match(source,/\/runs/u);
  assert.doesNotMatch(source,/method\s*:\s*['"](?:POST|PATCH|PUT|DELETE)/u);
  assert.doesNotMatch(source,/\/api\/analyze|\/api\/ingest/u);
});

test('portfolio renders escaped project and alert text and limits fan-out concurrency',()=>{
  assert.match(source,/const esc=/u);
  assert.match(source,/mapLimited\(projects,4,loadRow\)/u);
  assert.match(source,/esc\(row\.name\)/u);
  assert.match(source,/esc\(alert\.title/u);
  assert.match(source,/esc\(alert\.detail/u);
});
