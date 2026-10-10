import test from 'node:test';
import assert from 'node:assert/strict';
import { buildClientDeliveryCsv, buildEvidenceDelivery, buildClientDeliveryHtml, clientDeliveryFilename } from '../lib/client-delivery.mjs';

const project={id:'prj_1',slug:'demo-brand',name:'Demo <Brand>',client:'Client Co',category:'Skincare'};
const snapshot={
  id:'snap_1',createdAt:'2026-10-10T01:02:03.000Z',
  harvest:{
    source:{capturedAt:'2026-10-10T01:02:03.000Z'},
    notes:[{
      noteId:'note_1',title:'=HYPERLINK("https://bad.example")',author:{nickname:'Alice'},
      stats:{likes:12,collects:3,comments:4,shares:1},captureMethod:'initial-state',confidence:0.96,sourceUrl:'https://www.xiaohongshu.com/explore/note_1',
    }],
  },
};
const branding={agencyName:'North <Star>',reportTitle:'Client Intelligence',accentColor:'#0055AA',footerText:'Confidential & client-only'};

test('client delivery CSV adds branding/project context without dropping evidence provenance and neutralizes spreadsheet formulas',()=>{
  const csv=buildClientDeliveryCsv({project,snapshot,branding});
  assert.match(csv,/agencyName,reportTitle,projectName,client,category,snapshotId,capturedAt,noteId/u);
  assert.match(csv,/North <Star>/u);
  assert.match(csv,/Demo <Brand>/u);
  assert.match(csv,/note_1/u);
  assert.match(csv,/initial-state/u);
  assert.match(csv,/0\.96/u);
  assert.match(csv,/https:\/\/www\.xiaohongshu\.com\/explore\/note_1/u);
  assert.match(csv,/"'=HYPERLINK\(""https:\/\/bad\.example""\)"/u);
});

test('evidence delivery wraps but does not mutate the canonical Evidence Pack or claim the branding envelope is authenticated',()=>{
  const evidencePack={schemaVersion:'xhs-evidence-pack/1.2',integrity:{algorithm:'hmac-sha256',digest:'abc'},sources:[{noteId:'note_1'}]};
  const before=JSON.stringify(evidencePack);
  const delivery=buildEvidenceDelivery({project,snapshot,branding,evidencePack,verification:{ok:true,authenticated:true,checksumOnly:false}});
  assert.equal(JSON.stringify(evidencePack),before);
  assert.equal(delivery.evidencePack,evidencePack);
  assert.equal(delivery.schemaVersion,'xhs-client-evidence-delivery/1.0');
  assert.equal(delivery.delivery.canonicalEvidencePackUnmodified,true);
  assert.equal(delivery.delivery.envelopeAuthenticated,false);
  assert.equal(delivery.evidencePackVerification.ok,true);
  assert.equal(delivery.evidencePackVerification.authenticated,true);
  assert.match(delivery.delivery.interpretationLimits.join(' '),/not population prevalence/u);
});

test('print delivery HTML applies bounded branding, escapes persisted text, and contains no external resource or script surface',()=>{
  const html=buildClientDeliveryHtml({project,snapshot,branding,markdown:'# Finding\n<script>alert(1)</script>\nsource: note_1'});
  assert.match(html,/--accent:#0055aa/u);
  assert.match(html,/North &lt;Star&gt;/u);
  assert.match(html,/Demo &lt;Brand&gt;/u);
  assert.match(html,/&lt;script&gt;alert\(1\)&lt;\/script&gt;/u);
  assert.match(html,/not population prevalence/u);
  assert.match(html,/canonical evidence trail/u);
  assert.doesNotMatch(html,/<script/u);
  assert.doesNotMatch(html,/<link|<img|https?:\/\//u);
});

test('client delivery filenames stay bounded and filesystem-friendly',()=>{
  assert.equal(clientDeliveryFilename({slug:'Demo Brand / Q4'},'client-evidence.csv'),'demo-brand-q4-client-evidence.csv');
  assert.ok(clientDeliveryFilename({name:'测试 项目'},'report.html').length<120);
});
