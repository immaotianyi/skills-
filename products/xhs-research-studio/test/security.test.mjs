import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeHarvest, safeHttpUrl } from '../lib/normalize.mjs';
import { analyze } from '../lib/analysis.mjs';
import { validateHarvestInput } from '../lib/validation.mjs';

test('provenance URLs only allow http and https schemes', () => {
  assert.equal(safeHttpUrl('javascript:alert(1)'), '');
  assert.equal(safeHttpUrl('data:text/html,boom'), '');
  assert.equal(safeHttpUrl('file:///etc/passwd'), '');
  assert.equal(safeHttpUrl('/relative/path'), '');
  assert.equal(safeHttpUrl('https://example.test/a?x=1'), 'https://example.test/a?x=1');
});

test('normalization removes unsafe URLs from every evidence surface', () => {
  const normalized=normalizeHarvest({
    schemaVersion:'2.0',
    source:{platform:'xiaohongshu',capturedAt:'2026-10-10T00:00:00Z',entry:'search',captureMethod:'initial_state',sourceUrl:'javascript:alert(1)'},
    notes:[{
      noteId:'n1',title:'unsafe links',author:{userId:'u1',nickname:'x',profileUrl:'data:text/html,bad'},
      stats:{likes:0,collects:0,comments:1,shares:0},sourceUrl:'javascript:alert(2)',captureMethod:'initial_state',confidence:.98,
    }],
    comments:[{id:'c1',noteId:'n1',content:'test',likes:0,user:'u',sourceUrl:'file:///tmp/a'}],
    authors:[],
    queries:[{keyword:'k',capturedAt:'2026-10-10T00:00:00Z',results:[{noteId:'n1',rankingPosition:1,sourceUrl:'data:text/plain,no'}]}],
    meta:{gaps:[],loginRequired:false,riskState:'NORMAL'},
  });
  assert.equal(normalized.source.sourceUrl,'');
  assert.equal(normalized.notes[0].sourceUrl,'');
  assert.equal(normalized.notes[0].author.profileUrl,'');
  assert.equal(normalized.comments[0].sourceUrl,'');
  assert.equal(normalized.queries[0].results[0].sourceUrl,'');
});

test('hard safety states survive normalization and block evidence-quality status', () => {
  for (const riskState of ['CAPTCHA','ACCESS_DENIED','BLOCKED']) {
    const normalized=normalizeHarvest({
      schemaVersion:'2.0',
      source:{platform:'xiaohongshu',capturedAt:'2026-10-10T00:00:00Z',entry:'search',captureMethod:'initial_state'},
      notes:[],comments:[],authors:[],queries:[],
      meta:{gaps:[`stopped: ${riskState}`],loginRequired:false,riskState},
    });
    assert.equal(normalized.meta.riskState,riskState);
    assert.equal(analyze(normalized).quality.status,'blocked');
  }
});

test('declared Harvest v2 cannot omit capture provenance', () => {
  const result=validateHarvestInput({
    schemaVersion:'2.0',
    source:{platform:'xiaohongshu',capturedAt:'2026-10-10T00:00:00Z',entry:'search'},
    notes:[{noteId:'n1',author:{},stats:{likes:0,collects:0,comments:0,shares:0}}],
    comments:[],authors:[],queries:[],meta:{gaps:[],loginRequired:false,riskState:'NORMAL'},
  });
  assert.equal(result.ok,false);
  assert.ok(result.errors.some(x=>x.path==='$.source.captureMethod'));
  assert.ok(result.errors.some(x=>x.path==='$.notes[0].captureMethod'));
  assert.ok(result.errors.some(x=>x.path==='$.notes[0].confidence'));
});
