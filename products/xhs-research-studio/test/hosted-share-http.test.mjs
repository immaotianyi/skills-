import test from 'node:test';
import assert from 'node:assert/strict';
import { handlePublicShare } from '../lib/hosted-http.mjs';

const token='share_token_1234567890abcdef';
const store={resolveShare:value=>value===token?{id:'shr_1',expiresAt:'2030-01-01T00:00:00.000Z'}:null};
const shared={project:{name:'<script>"client"</script>'},markdown:'Evidence <b>must</b> stay "escaped".'};

async function invoke(path){
  let sent=null;
  const handled=await handlePublicShare({
    req:{method:'GET'},
    res:{},
    url:new URL(`https://studio.example.test${path}`),
    store,
    loadSharedReport:async()=>shared,
    send(_res,status,body,type,headers={}){sent={status,body,type,headers}},
  });
  assert.equal(handled,true);
  assert.ok(sent);
  return sent;
}

test('public HTML share is non-cacheable, non-indexable, framed-off, and HTML-escaped',async()=>{
  const sent=await invoke(`/share/${token}`);
  assert.equal(sent.status,200);
  assert.equal(sent.type,'text/html; charset=utf-8');
  assert.match(sent.headers['cache-control'],/no-store/u);
  assert.equal(sent.headers.pragma,'no-cache');
  assert.equal(sent.headers['x-content-type-options'],'nosniff');
  assert.equal(sent.headers['x-robots-tag'],'noindex, nofollow');
  assert.match(sent.headers['content-security-policy'],/frame-ancestors 'none'/u);
  assert.doesNotMatch(sent.body,/<script>/u);
  assert.match(sent.body,/&lt;script&gt;&quot;client&quot;&lt;\/script&gt;/u);
  assert.match(sent.body,/&lt;b&gt;must&lt;\/b&gt; stay &quot;escaped&quot;/u);
});

test('public shared-report JSON API is explicitly non-cacheable',async()=>{
  const sent=await invoke(`/api/shared/${token}`);
  assert.equal(sent.status,200);
  assert.equal(sent.type,'application/json; charset=utf-8');
  assert.match(sent.headers['cache-control'],/no-store/u);
  assert.equal(sent.headers.pragma,'no-cache');
  assert.equal(sent.headers['x-content-type-options'],'nosniff');
  assert.equal(sent.body.share.id,'shr_1');
  assert.deepEqual(sent.body.project,shared.project);
});
