import { normalizeBranding } from './branding.mjs';

const SAFE_HEX_RE=/^#[0-9a-f]{6}$/iu;

function text(value,max=500){return String(value??'').replace(/[\u0000-\u001f\u007f]/gu,' ').replace(/\s+/gu,' ').trim().slice(0,max)}
function csvCell(value){
  let s=String(value??'').replace(/\r\n?/gu,'\n');
  // Client CSVs are commonly opened in spreadsheets. Neutralize formula-like cells.
  if(/^[=+\-@]/u.test(s))s=`'${s}`;
  return /[",\n]/u.test(s)?`"${s.replace(/"/gu,'""')}"`:s;
}
function escapeHtml(value){return String(value??'').replace(/[&<>"']/gu,ch=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]))}
function captureTime(snapshot){return snapshot?.createdAt||snapshot?.harvest?.source?.capturedAt||''}
function safeProject(project={}){return{id:text(project.id,120),name:text(project.name,160),client:text(project.client,160),category:text(project.category,160),slug:text(project.slug,80)}}

export function buildClientDeliveryCsv({project={},snapshot={},branding={}}={}){
  const brand=normalizeBranding(branding),p=safeProject(project),capturedAt=captureTime(snapshot),notes=snapshot?.harvest?.notes||[];
  const header=['agencyName','reportTitle','projectName','client','category','snapshotId','capturedAt','noteId','title','author','likes','collects','comments','shares','captureMethod','confidence','sourceUrl'];
  const rows=[header];
  for(const note of notes){
    rows.push([
      brand.agencyName,brand.reportTitle||p.name,p.name,p.client,p.category,snapshot?.id||'',capturedAt,
      note?.noteId||'',note?.title||'',note?.author?.nickname||'',note?.stats?.likes??0,note?.stats?.collects??0,
      note?.stats?.comments??0,note?.stats?.shares??0,note?.captureMethod||'',note?.confidence??'',note?.sourceUrl||'',
    ]);
  }
  return rows.map(row=>row.map(csvCell).join(',')).join('\n')+'\n';
}

export function buildEvidenceDelivery({project={},snapshot={},branding={},evidencePack,verification={}}={}){
  if(!evidencePack||typeof evidencePack!=='object')throw new TypeError('A canonical Evidence Pack is required.');
  const brand=normalizeBranding(branding),p=safeProject(project);
  return {
    schemaVersion:'xhs-client-evidence-delivery/1.0',
    generatedAt:new Date().toISOString(),
    branding:brand,
    delivery:{
      reportTitle:brand.reportTitle||p.name||'Client Research Report',
      agencyName:brand.agencyName,
      footerText:brand.footerText,
      project:p,
      snapshot:{id:text(snapshot?.id,120),capturedAt:text(captureTime(snapshot),80)},
      canonicalEvidencePackUnmodified:true,
      envelopeAuthenticated:false,
      interpretationLimits:[
        'Evidence counts describe the captured dataset, not population prevalence.',
        'Observed search positions describe the captured query observations, not a universal platform ranking.',
        'Canonical evidence integrity is represented by the embedded Evidence Pack verification, not by this branding envelope.',
      ],
    },
    evidencePackVerification:{
      ok:verification?.ok===true,
      authenticated:verification?.authenticated===true,
      checksumOnly:verification?.checksumOnly===true,
    },
    evidencePack,
  };
}

export function buildClientDeliveryHtml({project={},snapshot={},branding={},markdown=''}={}){
  const brand=normalizeBranding(branding),p=safeProject(project),accent=SAFE_HEX_RE.test(brand.accentColor)?brand.accentColor:'#171717';
  const reportTitle=brand.reportTitle||p.name||'Client Research Report',capturedAt=text(captureTime(snapshot),80);
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(reportTitle)}</title><style>:root{--accent:${accent}}*{box-sizing:border-box}body{font:15px/1.55 system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;margin:0;background:#f5f5f2;color:#171717}main{max-width:980px;margin:auto;padding:36px 24px}header{border-top:5px solid var(--accent);padding-top:18px;margin-bottom:20px}header small{letter-spacing:.08em;text-transform:uppercase;color:#555}h1{color:var(--accent);margin:.25rem 0}.meta{color:#666;margin:.25rem 0}article{background:#fff;border:1px solid #ddd;border-radius:14px;padding:28px}pre{white-space:pre-wrap;word-break:break-word;font:inherit;margin:0}.limits{margin-top:18px;padding:14px 16px;border:1px solid #ddd;border-radius:10px;background:#fff}.limits b{color:var(--accent)}footer{margin-top:18px;color:#666;font-size:13px}@media print{body{background:#fff}main{max-width:none;padding:0}article,.limits{border-color:#bbb;break-inside:avoid}button{display:none}}</style></head><body><main><header>${brand.agencyName?`<small>${escapeHtml(brand.agencyName)}</small>`:''}<h1>${escapeHtml(reportTitle)}</h1><p class="meta">${escapeHtml(p.name)}${p.client?` · ${escapeHtml(p.client)}`:''}${capturedAt?` · captured ${escapeHtml(capturedAt)}`:''}</p></header><article><pre>${escapeHtml(markdown||'No report is available.')}</pre></article><section class="limits"><b>Interpretation limits</b><ul><li>Evidence counts describe the captured dataset, not population prevalence.</li><li>Observed search positions describe captured query observations, not a universal platform ranking.</li><li>Source URLs, capture method, confidence, and Evidence Pack integrity remain the canonical evidence trail.</li></ul></section>${brand.footerText?`<footer>${escapeHtml(brand.footerText)}</footer>`:''}</main></body></html>`;
}

export function clientDeliveryFilename(project={},suffix='delivery'){
  const base=text(project.slug||project.name||'xhs',80).toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff._-]+/gu,'-').replace(/^-+|-+$/gu,'')||'xhs';
  return `${base}-${suffix}`;
}
