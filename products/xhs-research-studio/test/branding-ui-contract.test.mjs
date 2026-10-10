import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root=path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const html=await fs.readFile(path.join(root,'public','index.html'),'utf8');
const file=path.join(root,'public','branding-ui.js');
const source=await fs.readFile(file,'utf8');

test('hosted shell loads a syntax-valid branding UI after hosted workspace bootstrap',()=>{
  const checked=spawnSync(process.execPath,['--check',file],{encoding:'utf8'});
  assert.equal(checked.status,0,checked.stderr||checked.stdout);
  assert.match(html,/<script src="\/branding-ui\.js"><\/script>/u);
  assert.ok(html.indexOf('/branding-ui.js')>html.indexOf('/hosted-ui.js'));
});

test('branding UI only mutates workspace branding and enforces strict client-side hex colors',()=>{
  assert.match(source,/window\.XHS_STUDIO_READY/u);
  assert.match(source,/\^#\[0-9a-f\]\{6\}\$/u);
  assert.match(source,/method:'PATCH'/u);
  assert.match(source,/\/branding/u);
  assert.doesNotMatch(source,/method:'(?:POST|PUT|DELETE)'/u);
  assert.doesNotMatch(source,/logoUrl|innerHTML\s*=\s*branding/u);
});

test('branding editor stays compatible with the main app strict style-src self CSP',()=>{
  assert.doesNotMatch(source,/\sstyle=/u);
  assert.doesNotMatch(source,/\.style\s*[.=]/u);
  assert.match(source,/强调色：\$\{esc\(accent\)\}/u);
});

test('branding UI escapes every persisted text field rendered into markup',()=>{
  assert.match(source,/esc\(branding\.agencyName/u);
  assert.match(source,/esc\(branding\.reportTitle/u);
  assert.match(source,/esc\(branding\.footerText/u);
  assert.match(source,/safeAccent\(branding\.accentColor/u);
});
