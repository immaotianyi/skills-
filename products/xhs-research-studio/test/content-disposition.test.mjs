import test from 'node:test';
import assert from 'node:assert/strict';
import { attachmentContentDisposition } from '../lib/content-disposition.mjs';

test('attachment disposition keeps HTTP headers ASCII-safe while preserving Unicode filename via RFC 5987',()=>{
  const header=attachmentContentDisposition('敏感肌防晒-evidence-pack-v1.2.json',{fallback:'xhs-evidence-pack-v1.2.json'});
  assert.match(header,/^attachment; filename="evidence-pack-v1\.2\.json"; filename\*=UTF-8''/u);
  assert.match(header,/%E6%95%8F%E6%84%9F%E8%82%8C%E9%98%B2%E6%99%92/u);
  assert.equal(/[^\x00-\x7f]/u.test(header),false);
});

test('attachment disposition strips header controls and quotes from the ASCII fallback',()=>{
  const header=attachmentContentDisposition('bad\r\n"name";file.csv',{fallback:'xhs.csv'});
  assert.equal(header.includes('\r'),false);
  assert.equal(header.includes('\n'),false);
  assert.match(header,/filename="bad _name__file\.csv"/u);
  assert.match(header,/filename\*=UTF-8''/u);
});
