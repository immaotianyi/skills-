import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root=path.dirname(path.dirname(fileURLToPath(import.meta.url)));

async function text(name){return fs.readFile(path.join(root,'public',name),'utf8')}

test('hosted browser bootstrap loads before app and exposes explicit workspace context',async()=>{
  const [html,hosted]=await Promise.all([text('index.html'),text('hosted-ui.js')]);
  assert.ok(html.indexOf('/hosted-ui.js')>=0,'hosted-ui.js must be loaded');
  assert.ok(html.indexOf('/hosted-ui.js')<html.indexOf('/app.js'),'hosted context must load before app.js');
  assert.match(hosted,/XHS_STUDIO_READY/);
  assert.match(hosted,/XHS_HOSTED_HEADERS/);
  assert.match(hosted,/x-xhs-workspace-id/);
  assert.match(hosted,/\/api\/auth\/register/);
  assert.match(hosted,/billing\/checkout/);
  assert.match(hosted,/billing\/portal/);
  assert.match(hosted,/\/invitations/);
  assert.match(hosted,/\/synthesis/);
  assert.match(hosted,/\/shares/);
});

test('hosted browser layer replaces navigation downloads with authenticated workspace-aware fetches',async()=>{
  const hosted=await text('hosted-ui.js');
  assert.match(hosted,/authenticatedDownload/);
  assert.match(hosted,/#csvBtn,#packBtn/);
  assert.match(hosted,/export\.csv/);
  assert.match(hosted,/evidence-pack\?version=1\.2/);
});

test('hosted-ui.js passes an explicit Node syntax gate',()=>{
  const result=spawnSync(process.execPath,['--check',path.join(root,'public','hosted-ui.js')],{encoding:'utf8'});
  assert.equal(result.status,0,result.stderr||result.stdout);
});
