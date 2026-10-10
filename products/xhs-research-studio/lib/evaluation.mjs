import { classifyComment } from './analysis.mjs';
import { makeIntegrity } from './integrity.mjs';

export const SIGNAL_CLASSES = Object.freeze(['questions','complaints','purchaseIntent','positive']);

function bool(v) { return v === true; }
function safe(v='') { return String(v ?? '').trim(); }

export function normalizeEvaluationRecord(record, index=0) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) throw new TypeError(`record ${index} must be an object`);
  const content = safe(record.content);
  if (!content) throw new TypeError(`record ${index} content is required`);
  const labels = record.labels;
  if (!labels || typeof labels !== 'object' || Array.isArray(labels)) throw new TypeError(`record ${index} labels object is required`);
  return {
    id: safe(record.id) || `row-${index+1}`,
    content,
    labels: Object.fromEntries(SIGNAL_CLASSES.map(k => [k, bool(labels[k])])),
    reviewer: safe(record.reviewer),
    category: safe(record.category),
    sourceRef: safe(record.sourceRef),
  };
}

function safeDiv(a,b) { return b ? a / b : 0; }
function metric(tp,fp,fn,tn) {
  const precision=safeDiv(tp,tp+fp);
  const recall=safeDiv(tp,tp+fn);
  return {
    tp,fp,fn,tn,
    support:tp+fn,
    predictedPositive:tp+fp,
    precision,
    recall,
    f1:precision+recall ? (2*precision*recall)/(precision+recall) : 0,
    accuracy:safeDiv(tp+tn,tp+tn+fp+fn),
  };
}

export function auditEvaluationDataset(records) {
  const normalized = records.map(normalizeEvaluationRecord);
  const counts = Object.fromEntries(SIGNAL_CLASSES.map(k=>[k,normalized.filter(r=>r.labels[k]).length]));
  const reviewers=[...new Set(normalized.map(r=>r.reviewer).filter(Boolean))];
  const categories=[...new Set(normalized.map(r=>r.category).filter(Boolean))];
  const byContent=new Map();
  for (const r of normalized) byContent.set(r.content,(byContent.get(r.content)||0)+1);
  const duplicateRows=[...byContent.entries()].filter(([,n])=>n>1).reduce((a,[,n])=>a+n-1,0);
  const duplicateRatio=normalized.length ? duplicateRows/normalized.length : 0;
  const missingReviewer=normalized.filter(r=>!r.reviewer).length;
  const warnings=[];
  if(normalized.length<200) warnings.push(`sample size ${normalized.length} is below the 200-comment validation target`);
  for(const k of SIGNAL_CLASSES) if(counts[k]<20) warnings.push(`${k} has only ${counts[k]} positive labels; class support is too small for a strong claim`);
  if(reviewers.length<2) warnings.push('fewer than two reviewer identifiers are present; independent-review provenance is not demonstrated');
  if(missingReviewer) warnings.push(`${missingReviewer} record(s) have no reviewer identifier`);
  if(duplicateRatio>0.05) warnings.push(`duplicate-content ratio ${(duplicateRatio*100).toFixed(1)}% exceeds 5%`);
  const machineCheckablePreconditions = normalized.length>=200
    && SIGNAL_CLASSES.every(k=>counts[k]>=20)
    && reviewers.length>=2
    && missingReviewer===0
    && duplicateRatio<=0.05;
  return {
    sampleSize:normalized.length,
    positiveLabels:counts,
    reviewerCount:reviewers.length,
    reviewers,
    categoryCount:categories.length,
    categories,
    duplicateRows,
    duplicateRatio,
    missingReviewer,
    machineCheckablePreconditions,
    humanValidationStillRequired:true,
    warnings,
    datasetIntegrity:makeIntegrity(normalized,'xhs-signal-evaluation-dataset-v1'),
    normalized,
  };
}

export function evaluateSignalClassifier(records) {
  const audit=auditEvaluationDataset(records);
  const rows=[];
  const totals=Object.fromEntries(SIGNAL_CLASSES.map(k=>[k,{tp:0,fp:0,fn:0,tn:0}]));
  let exactMatches=0;
  for(const record of audit.normalized){
    const predicted=classifyComment({content:record.content});
    let exact=true;
    const binaryPrediction={};
    for(const k of SIGNAL_CLASSES){
      const pred=(predicted[k]||[]).length>0;
      const truth=record.labels[k];
      binaryPrediction[k]=pred;
      if(pred!==truth) exact=false;
      if(pred&&truth) totals[k].tp++;
      else if(pred&&!truth) totals[k].fp++;
      else if(!pred&&truth) totals[k].fn++;
      else totals[k].tn++;
    }
    if(exact) exactMatches++;
    rows.push({...record,predicted:binaryPrediction,matchedTerms:predicted,exactMatch:exact});
  }
  const perClass=Object.fromEntries(SIGNAL_CLASSES.map(k=>[k,metric(totals[k].tp,totals[k].fp,totals[k].fn,totals[k].tn)]));
  const microTotals=SIGNAL_CLASSES.reduce((a,k)=>({tp:a.tp+totals[k].tp,fp:a.fp+totals[k].fp,fn:a.fn+totals[k].fn,tn:a.tn+totals[k].tn}),{tp:0,fp:0,fn:0,tn:0});
  const macro={
    precision:SIGNAL_CLASSES.reduce((s,k)=>s+perClass[k].precision,0)/SIGNAL_CLASSES.length,
    recall:SIGNAL_CLASSES.reduce((s,k)=>s+perClass[k].recall,0)/SIGNAL_CLASSES.length,
    f1:SIGNAL_CLASSES.reduce((s,k)=>s+perClass[k].f1,0)/SIGNAL_CLASSES.length,
  };
  const errors=rows.filter(r=>!r.exactMatch).map(r=>({id:r.id,content:r.content,labels:r.labels,predicted:r.predicted,matchedTerms:r.matchedTerms,reviewer:r.reviewer,category:r.category,sourceRef:r.sourceRef}));
  const claimTargets={
    complaints:{precision:0.90,recall:0.80},
    purchaseIntent:{precision:0.90,recall:0.80},
  };
  const metricTargetsMet=Object.entries(claimTargets).every(([k,t])=>perClass[k].precision>=t.precision&&perClass[k].recall>=t.recall);
  return {
    schemaVersion:'xhs-signal-evaluation/1.0',
    generatedAt:new Date().toISOString(),
    audit:{...audit,normalized:undefined},
    perClass,
    micro:metric(microTotals.tp,microTotals.fp,microTotals.fn,microTotals.tn),
    macro,
    exactMatchRate:safeDiv(exactMatches,rows.length),
    errors,
    claimGate:{
      machineCheckableDatasetPreconditions:audit.machineCheckablePreconditions,
      metricTargetsMet,
      eligibleForValidatedClassifierClaim:false,
      reason:'A validated claim additionally requires documented human review quality and independence; software metrics alone cannot prove that provenance.',
    },
  };
}
