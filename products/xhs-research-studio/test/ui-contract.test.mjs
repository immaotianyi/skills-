import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root=path.dirname(path.dirname(fileURLToPath(import.meta.url)));

test('browser app ID references exist in the HTML shell', async () => {
  const [html,app,packV12]=await Promise.all([
    fs.readFile(path.join(root,'public','index.html'),'utf8'),
    fs.readFile(path.join(root,'public','app.js'),'utf8'),
    fs.readFile(path.join(root,'public','pack-v12.js'),'utf8'),
  ]);
  const referenced=new Set([...app.matchAll(/\$\('#([A-Za-z0-9_-]+)'\)/g)].map(match=>match[1]));
  assert.ok(referenced.size>10,'expected a meaningful UI ID contract');
  const missing=[];
  for(const id of referenced) {
    if(!new RegExp(`id=["']${id}["']`).test(html)) missing.push(id);
  }
  assert.deepEqual(missing,[],`app.js references missing DOM IDs: ${missing.join(', ')}`);
  assert.match(html,/src=["']\/app\.js["']/);
  assert.match(html,/src=["']\/pack-v12\.js["']/);
  assert.match(html,/href=["']\/style\.css["']/);
  assert.doesNotMatch(html,/<script(?![^>]*\bsrc=)[^>]*>/i,'inline scripts would violate the current CSP contract');
  assert.match(packV12,/evidence-pack\?version=1\.2/);
  assert.match(packV12,/下载 Evidence Pack v1\.2/);
});

test('client source links use noopener/noreferrer and Evidence Pack delivery remains server-generated', async () => {
  const [app,packV12]=await Promise.all([
    fs.readFile(path.join(root,'public','app.js'),'utf8'),
    fs.readFile(path.join(root,'public','pack-v12.js'),'utf8'),
  ]);
  assert.match(app,/rel=\"noopener noreferrer\"/);
  assert.match(app,/\/evidence-pack/);
  assert.match(packV12,/\/evidence-pack\?version=1\.2/);
  assert.doesNotMatch(app,/xhs-evidence-pack\/1\.0/);
  assert.doesNotMatch(packV12,/xhs-evidence-pack\/1\.0/);
});
