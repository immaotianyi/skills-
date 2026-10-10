import { analyze } from './analysis.mjs';
import { makeIntegrity, verifyIntegrity } from './integrity.mjs';

const PACK_SCOPE='xhs-evidence-pack-content-v1';

export function buildEvidencePack(project, snapshot, integrityOptions = {}) {
  const analysis=snapshot.analysis||analyze(snapshot.harvest);
  const h=snapshot.harvest;
  const pack={
    schemaVersion:'xhs-evidence-pack/1.2',
    generatedAt:new Date().toISOString(),
    project,
    snapshot:{
      id:snapshot.id,
      capturedAt:snapshot.createdAt,
      integrity:snapshot.integrity||null,
      integrityStatus:snapshot.integrityStatus||null,
    },
    coverage:analysis.coverage,
    quality:analysis.quality,
    methodology:analysis.methodology,
    signals:analysis.signals,
    topNotes:analysis.topNotes.slice(0,20),
    rankings:analysis.rankings,
    evidenceClusters:analysis.evidenceClusters,
    gaps:analysis.coverage.gaps,
    sources:(h.notes||[]).map(n=>({noteId:n.noteId,title:n.title,sourceUrl:n.sourceUrl,captureMethod:n.captureMethod,confidence:n.confidence})),
  };
  return {...pack,integrity:makeIntegrity(pack,PACK_SCOPE,integrityOptions)};
}

export function verifyEvidencePack(pack, integrityOptions = {}) {
  if(!pack||typeof pack!=='object'||Array.isArray(pack)) return {ok:false,authenticated:false,checksumOnly:false,errors:[{path:'$',message:'Evidence Pack must be an object.'}]};
  const integrity=pack.integrity;
  const content={...pack};
  delete content.integrity;
  const result=verifyIntegrity(content,integrity,PACK_SCOPE,integrityOptions);
  const errors=[...result.errors];
  if(pack.schemaVersion!=='xhs-evidence-pack/1.2') errors.push({path:'$.schemaVersion',message:'Expected xhs-evidence-pack/1.2.'});
  if(!pack.snapshot?.integrity) errors.push({path:'$.snapshot.integrity',message:'Snapshot integrity metadata is required.'});
  return {
    ok:errors.length===0,
    authenticated:errors.length===0&&result.authenticated,
    checksumOnly:errors.length===0&&result.checksumOnly,
    errors,
    actualDigest:result.actualDigest,
    snapshotIntegrity:pack.snapshot?.integrity||null,
  };
}

export const evidencePackIntegrity=Object.freeze({packScope:PACK_SCOPE});
