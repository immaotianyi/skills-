import { classifyComment } from './analysis.mjs';
import { makeIntegrity } from './integrity.mjs';

export const SIGNAL_CLASSES = Object.freeze(['questions','complaints','purchaseIntent','positive']);
export const VALIDATION_GATE = Object.freeze({
  minimumHoldout:400,
  minimumPositivePerClass:50,
  minimumCategories:3,
  maximumDuplicateRatio:0.02,
  minimumAgreement:0.85,
  minimumKappa:0.65,
  targets:Object.freeze({
    questions:Object.freeze({precision:0.85,recall:0.80}),
    complaints:Object.freeze({precision:0.90,recall:0.85}),
    purchaseIntent:Object.freeze({precision:0.90,recall:0.85}),
    positive:Object.freeze({precision:0.85,recall:0.80}),
  }),
});

function safe(v='') { return String(v ?? '').trim(); }
function normalizeLabels(labels={}) {
  return Object.fromEntries(SIGNAL_CLASSES.map(k => [k, labels?.[k] === true]));
}
function sameLabels(a,b){ return SIGNAL_CLASSES.every(k=>a[k]===b[k]); }

function normalizeReview(review,index){
  if(!review||typeof review!=='object'||Array.isArray(review)) throw new TypeError(`review ${index} must be an object`);
  const reviewer=safe(review.reviewer);
  if(!reviewer) throw new TypeError(`review ${index} reviewer is required`);
  if(!review.labels||typeof review.labels!=='object'||Array.isArray(review.labels)) throw new TypeError(`review ${index} labels object is required`);
  return {reviewer,labels:normalizeLabels(review.labels)};
}

export function normalizeEvaluationRecord(record, index=0) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) throw new TypeError(`record ${index} must be an object`);
  const content = safe(record.content);
  if (!content) throw new TypeError(`record ${index} content is required`);
  const reviews=Array.isArray(record.reviews)?record.reviews.map((r,i)=>normalizeReview(r,`${index}.${i}`)):[];
  const hasExplicitLabels=Boolean(record.labels&&typeof record.labels==='object'&&!Array.isArray(record.labels));
  const explicitLabels=hasExplicitLabels?normalizeLabels(record.labels):normalizeLabels({});
  if(!hasExplicitLabels&&!reviews.length) throw new TypeError(`record ${index} requires labels or reviews`);
  const adjudicatedLabels=record.adjudicatedLabels&&typeof record.adjudicatedLabels==='object'&&!Array.isArray(record.adjudicatedLabels)
    ? normalizeLabels(record.adjudicatedLabels)
    : null;
  const finalLabels={...explicitLabels};
  const unresolvedDisagreements=[];
  if(reviews.length>=2){
    for(const k of SIGNAL_CLASSES){
      const first=reviews[0].labels[k];
      const agrees=reviews.every(r=>r.labels[k]===first);
      if(agrees) finalLabels[k]=first;
      else if(adjudicatedLabels) finalLabels[k]=adjudicatedLabels[k];
      else {
        if(!hasExplicitLabels) finalLabels[k]=first;
        unresolvedDisagreements.push(k);
      }
    }
  } else if(reviews.length===1 && !hasExplicitLabels) {
    Object.assign(finalLabels,reviews[0].labels);
  }
  const legacyReviewer=safe(record.reviewer);
  const reviewerIds=[...new Set([...reviews.map(r=>r.reviewer),legacyReviewer].filter(Boolean))];
  return {
    id: safe(record.id) || `row-${index+1}`,
    content,
    labels:finalLabels,
    reviews,
    reviewerIds,
    adjudicatedLabels,
    adjudicatedBy:safe(record.adjudicatedBy),
    unresolvedDisagreements,
    category: safe(record.category),
    sourceRef: safe(record.sourceRef),
  };
}

function safeDiv(a,b) { return b ? a / b : 0; }
function wilson(successes,trials,z=1.959963984540054){
  if(!trials) return {low:0,high:0};
  const p=successes/trials;
  const z2=z*z;
  const denominator=1+z2/trials;
  const center=(p+z2/(2*trials))/denominator;
  const margin=(z*Math.sqrt((p*(1-p)+z2/(4*trials))/trials))/denominator;
  return {low:Math.max(0,center-margin),high:Math.min(1,center+margin)};
}
function metric(tp,fp,fn,tn) {
  const precision=safeDiv(tp,tp+fp);
  const recall=safeDiv(tp,tp+fn);
  const accuracy=safeDiv(tp+tn,tp+tn+fp+fn);
  return {
    tp,fp,fn,tn,
    support:tp+fn,
    predictedPositive:tp+fp,
    precision,
    precision95:wilson(tp,tp+fp),
    recall,
    recall95:wilson(tp,tp+fn),
    f1:precision+recall ? (2*precision*recall)/(precision+recall) : 0,
    accuracy,
    accuracy95:wilson(tp+tn,tp+tn+fp+fn),
  };
}

function interRaterAgreement(records){
  const eligible=records.filter(r=>r.reviews.length>=2);
  const out={};
  for(const k of SIGNAL_CLASSES){
    let agree=0,r1Positive=0,r2Positive=0;
    for(const r of eligible){
      const a=r.reviews[0].labels[k],b=r.reviews[1].labels[k];
      if(a===b) agree++;
      if(a) r1Positive++;
      if(b) r2Positive++;
    }
    const n=eligible.length;
    const observed=safeDiv(agree,n);
    const p1=safeDiv(r1Positive,n),p2=safeDiv(r2Positive,n);
    const expected=p1*p2+(1-p1)*(1-p2);
    const kappa=n ? (expected===1 ? (observed===1?1:0) : (observed-expected)/(1-expected)) : 0;
    out[k]={n,agreement:observed,kappa};
  }
  return out;
}

export function auditEvaluationDataset(records) {
  const normalized = records.map(normalizeEvaluationRecord);
  const counts = Object.fromEntries(SIGNAL_CLASSES.map(k=>[k,normalized.filter(r=>r.labels[k]).length]));
  const reviewers=[...new Set(normalized.flatMap(r=>[...r.reviewerIds,r.adjudicatedBy]).filter(Boolean))];
  const categories=[...new Set(normalized.map(r=>r.category).filter(Boolean))];
  const byContent=new Map();
  for (const r of normalized) byContent.set(r.content,(byContent.get(r.content)||0)+1);
  const duplicateRows=[...byContent.entries()].filter(([,n])=>n>1).reduce((a,[,n])=>a+n-1,0);
  const duplicateRatio=normalized.length ? duplicateRows/normalized.length : 0;
  const doubleReviewedRows=normalized.filter(r=>r.reviews.length>=2).length;
  const unresolvedDisagreementRows=normalized.filter(r=>r.unresolvedDisagreements.length>0).length;
  const adjudicatedRows=normalized.filter(r=>r.adjudicatedLabels&&r.adjudicatedBy).length;
  const interRater=interRaterAgreement(normalized);
  const warnings=[];
  if(normalized.length<VALIDATION_GATE.minimumHoldout) warnings.push(`holdout size ${normalized.length} is below the ${VALIDATION_GATE.minimumHoldout}-comment validation target`);
  for(const k of SIGNAL_CLASSES) if(counts[k]<VALIDATION_GATE.minimumPositivePerClass) warnings.push(`${k} has only ${counts[k]} positive labels; target is at least ${VALIDATION_GATE.minimumPositivePerClass}`);
  if(categories.length<VALIDATION_GATE.minimumCategories) warnings.push(`only ${categories.length} categories represented; target is at least ${VALIDATION_GATE.minimumCategories}`);
  if(doubleReviewedRows!==normalized.length) warnings.push(`${normalized.length-doubleReviewedRows} record(s) lack two independent review records`);
  if(unresolvedDisagreementRows) warnings.push(`${unresolvedDisagreementRows} record(s) contain unresolved reviewer disagreement`);
  if(duplicateRatio>VALIDATION_GATE.maximumDuplicateRatio) warnings.push(`duplicate-content ratio ${(duplicateRatio*100).toFixed(1)}% exceeds ${(VALIDATION_GATE.maximumDuplicateRatio*100).toFixed(0)}%`);
  const interRaterTargetsMet=SIGNAL_CLASSES.every(k=>interRater[k].agreement>=VALIDATION_GATE.minimumAgreement&&interRater[k].kappa>=VALIDATION_GATE.minimumKappa);
  if(!interRaterTargetsMet) warnings.push('inter-rater agreement/kappa gate is not met for every signal class');
  const machineCheckablePreconditions = normalized.length>=VALIDATION_GATE.minimumHoldout
    && SIGNAL_CLASSES.every(k=>counts[k]>=VALIDATION_GATE.minimumPositivePerClass)
    && categories.length>=VALIDATION_GATE.minimumCategories
    && doubleReviewedRows===normalized.length
    && unresolvedDisagreementRows===0
    && duplicateRatio<=VALIDATION_GATE.maximumDuplicateRatio
    && interRaterTargetsMet;
  return {
    sampleSize:normalized.length,
    positiveLabels:counts,
    reviewerCount:reviewers.length,
    reviewers,
    categoryCount:categories.length,
    categories,
    doubleReviewedRows,
    unresolvedDisagreementRows,
    adjudicatedRows,
    duplicateRows,
    duplicateRatio,
    interRater,
    interRaterTargetsMet,
    machineCheckablePreconditions,
    humanValidationStillRequired:true,
    gate:VALIDATION_GATE,
    warnings,
    datasetIntegrity:makeIntegrity(normalized,'xhs-signal-evaluation-dataset-v2'),
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
  const errors=rows.filter(r=>!r.exactMatch).map(r=>({id:r.id,content:r.content,labels:r.labels,predicted:r.predicted,matchedTerms:r.matchedTerms,reviewerIds:r.reviewerIds,category:r.category,sourceRef:r.sourceRef}));
  const metricTargetsMet=SIGNAL_CLASSES.every(k=>{
    const target=VALIDATION_GATE.targets[k];
    return perClass[k].precision95.low>=target.precision&&perClass[k].recall95.low>=target.recall;
  });
  const machineEligibleForClaim=audit.machineCheckablePreconditions&&metricTargetsMet;
  return {
    schemaVersion:'xhs-signal-evaluation/2.0',
    generatedAt:new Date().toISOString(),
    audit:{...audit,normalized:undefined},
    perClass,
    micro:metric(microTotals.tp,microTotals.fp,microTotals.fn,microTotals.tn),
    macro,
    exactMatchRate:safeDiv(exactMatches,rows.length),
    errors,
    claimGate:{
      thresholds:VALIDATION_GATE.targets,
      uses95PercentLowerBounds:true,
      machineCheckableDatasetPreconditions:audit.machineCheckablePreconditions,
      metricTargetsMet,
      machineEligibleForClaim,
      eligibleForValidatedClassifierClaim:false,
      reason:'Even a machine-eligible report still requires documented human-review independence, holdout governance, and provenance review before a scientific validation claim is approved.',
    },
  };
}
