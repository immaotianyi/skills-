# XHS Research Studio — Signal Validation Protocol

This document defines the evidence required before the rule-based comment signal layer may be described as **validated** rather than merely **transparent analyst triage**.

## Current status

The repository intentionally ships **no fabricated human-labeled validation corpus** and therefore makes no validated-classifier accuracy claim.

Automated tests prove software behavior. They do not prove real-world semantic accuracy.

## Holdout gate

The validation holdout should satisfy all of the following machine-checkable minimums:

- at least **400 unique comments**;
- at least **50 positive examples per signal class** (`questions`, `complaints`, `purchaseIntent`, `positive`);
- at least **3 materially different product/category domains**;
- duplicate-content ratio no higher than **2%**;
- every holdout item reviewed independently by at least **2 reviewers**;
- all reviewer disagreements resolved through explicit adjudication before scoring;
- first-two-reviewer raw agreement at least **0.85** and Cohen's kappa at least **0.65** for every signal class.

These are minimum release gates, not evidence that the sample is representative of all Xiaohongshu language.

## Metric gate

The evaluator uses the **lower bound of a two-sided 95% Wilson confidence interval**, not only the point estimate.

Required lower bounds:

| Signal | Precision | Recall |
| --- | ---: | ---: |
| Questions | 0.85 | 0.80 |
| Complaints / risk | 0.90 | 0.85 |
| Purchase intent | 0.90 | 0.85 |
| Positive feedback | 0.85 | 0.80 |

A point estimate of 0.95 with a wide interval whose lower bound misses the target does **not** pass.

## Review record format

Preferred JSON/JSONL record:

```json
{
  "id": "holdout-001",
  "content": "这个会辣眼吗？",
  "category": "防晒",
  "sourceRef": "internal-evidence-reference",
  "reviews": [
    {"reviewer": "reviewer-a", "labels": {"questions": true, "complaints": false, "purchaseIntent": false, "positive": false}},
    {"reviewer": "reviewer-b", "labels": {"questions": true, "complaints": false, "purchaseIntent": false, "positive": false}}
  ]
}
```

When reviewers disagree, include `adjudicatedLabels` and `adjudicatedBy`. Do not silently overwrite the original reviews.

## Independence and leakage controls

1. Freeze the classifier/rule version before scoring the final holdout.
2. Keep development/tuning comments separate from final holdout comments.
3. Do not copy hard-coded lexical examples into the holdout solely to inflate scores.
4. Do not tune rules against the final holdout and then report the same holdout as untouched evidence.
5. Deduplicate near-identical campaign/copied comments before sampling.
6. Preserve category/source references sufficient for audit while avoiding unnecessary personal data.
7. Record reviewer identifiers or pseudonymous reviewer IDs so review provenance is inspectable.

## Recommended review workflow

1. Draw a bounded, documented sample from public or user-authorized evidence already collected through the Harvest safety boundary.
2. Remove obvious duplicates and assign stable evaluation IDs.
3. Randomize review order and hide classifier predictions from reviewers.
4. Collect at least two independent label sets per item.
5. Adjudicate disagreements without showing reviewers a desired target metric.
6. Freeze the resolved holdout.
7. Run:

```bash
node products/xhs-research-studio/evaluate-signals.mjs labels.jsonl --out evaluation-report.json
```

8. Inspect per-class errors, precision/recall/F1, confidence intervals, inter-rater agreement, duplicate ratio, and dataset fingerprint.
9. Preserve the evaluation report and corpus fingerprint with the release evidence.

## Claim boundary

Even when every machine gate passes, `evaluate-signals.mjs` deliberately leaves `eligibleForValidatedClassifierClaim` as `false` until a human reviewer confirms:

- the corpus provenance is legitimate;
- reviews were genuinely independent;
- holdout governance was followed;
- categories are relevant to the claimed use case;
- no material leakage or cherry-picking occurred.

This prevents software from self-certifying scientific validity that it cannot observe.
