# XHS Research Studio — Research Methodology and Evidence Contract

## Purpose

XHS Research Studio is an evidence-management and analyst-triage system for public or user-authorized Xiaohongshu research. It is designed to make collection provenance, coverage limits, observed changes, and source evidence explicit.

It is **not** currently a statistically representative measurement system, a trained sentiment model, or a causal model of consumer behavior. Any downstream claim must stay within the evidence actually captured.

## 1. Evidence provenance

Every Harvest snapshot should preserve, where available:

- source URL;
- capture time;
- capture method (`initial_state`, rendered DOM, OCR, mixed, unknown);
- per-note confidence;
- explicit gaps and access/risk state;
- the search keyword and observed result position for rank observations.

This design is informed by general provenance principles: claims should be traceable to the entities and activities that produced them. W3C PROV is a useful conceptual reference, but Harvest v2 does **not** claim formal PROV-O conformance.

Reference: W3C, **PROV-O: The PROV Ontology**, W3C Recommendation. https://www.w3.org/TR/prov-o/

## 2. Progressive sampling and saturation

The Harvest skill starts with a bounded sample and expands only while materially new themes/questions continue to appear. This is an operational cost/coverage heuristic inspired by qualitative-research saturation concepts.

Important limitation: Xiaohongshu search/feed sampling is not equivalent to interview sampling, and the current product does not claim that a 20–50 or 100–200 note sample is statistically representative or that thematic saturation has been formally proven.

Relevant methodological references:

- Guest, G., Bunce, A., & Johnson, L. (2006). **How Many Interviews Are Enough? An Experiment with Data Saturation and Variability.** *Field Methods*, 18(1), 59–82. DOI: 10.1177/1525822X05279903.
- Hennink, M. M., Kaiser, B. N., & Marconi, V. C. (2017). **Code Saturation Versus Meaning Saturation: How Many Interviews Are Enough?** *Qualitative Health Research*, 27(4), 591–608. DOI: 10.1177/1049732316665344.

The distinction between discovering recurring codes and richly understanding their meaning is especially important here: recurring lexical themes can support triage, but should not be represented as full qualitative interpretation.

## 3. Chinese text segmentation

Current recurring-term extraction uses `Intl.Segmenter('zh-CN', { granularity: 'word' })` when available, which is backed by the runtime's internationalization/Unicode segmentation implementation. A Unicode-regex fallback is retained for runtimes without `Intl.Segmenter`.

Reference: Unicode Consortium, **Unicode Standard Annex #29 — Unicode Text Segmentation**. https://www.unicode.org/reports/tr29/

Term frequency is **comment document frequency**: a term repeated multiple times inside one comment counts once for that comment. This reduces the effect of repetitive wording inside a single comment.

## 4. Audience-signal classification

The current signal model is a transparent lexicon/rule system for four analyst queues:

- questions;
- complaints/risk;
- purchase intent;
- positive feedback.

Rules include local negation suppression, so phrases such as `不刺痛` should not be counted as a `刺痛` complaint and `不会回购` should not be counted as purchase intent or positive feedback.

This is **not** a trained sentiment classifier. It can still fail on sarcasm, long-distance negation, slang, context dependence, mixed sentiment, spelling variants, emoji-only meaning, and domain-specific terminology.

For every matched example, the system retains the matched term(s) and original comment so an analyst can audit the classification.

## 5. Evidence clusters

The feature historically called “Evidence Clusters” is implemented as **lexical recurring-term evidence grouping**:

1. segment comments into word-like terms;
2. count how many comments contain each term;
3. select recurring/high-frequency terms;
4. link matching comments back to source notes.

It is intentionally labeled `lexical-comment-frequency` in output. It must not be described as semantic embedding clustering, topic modeling, or an LLM-derived taxonomy unless such a model is added and separately validated.

## 6. Search visibility

`rankingPosition` means only the position observed in the captured result page for:

- the recorded keyword;
- the recorded capture time;
- the recorded accessible session/context.

It must not be generalized to a universal platform rank. Personalization, login state, geography, experiment buckets, result volatility, and platform changes can affect observed order.

Diffs therefore describe **observed rank change between snapshots**, not a guaranteed global SEO movement.

## 7. Note review score

The current note triage score is:

`likes × 1 + collects × 1.5 + comments × 2 + shares × 0.5`

This is a transparent review-priority heuristic. The weights are not presently calibrated against revenue, brand lift, conversion, or any causal business outcome. Reports call it a review score / weighted engagement score rather than a value score.

Any future weight change must be versioned and accompanied by either:

- a documented empirical calibration dataset; or
- a clear statement that the new weights remain heuristic.

## 8. Snapshot diffs

A note that appeared in snapshot A but not snapshot B is labeled **not observed in the current sample**, not “deleted”. Absence can be caused by sampling changes, rank movement, access state, or true unavailability.

Only a direct source check can support a stronger deletion/unavailability claim.

## 9. Evidence-quality score

The Studio exposes a bounded quality/coverage indicator derived from observable evidence hygiene, including:

- non-normal capture risk state;
- explicit collection gaps;
- missing source URLs;
- unknown capture methods;
- low confidence;
- missing first-class comments.

The quality score is a triage indicator, not a statistical confidence interval.

Hard access states such as CAPTCHA, ACCESS_DENIED, and BLOCKED must stop collection interpretation until the coverage state is resolved by permissible means.

## 10. Evidence integrity

Integrity metadata has two deliberately different meanings:

- **SHA-256 checksum:** detects accidental or uncoordinated changes to canonicalized evidence, but is not authentication because an actor who can rewrite both content and checksum can recompute it.
- **HMAC-SHA256 authentication:** when an external secret key is configured, evidence is authenticated against that key. The secret is never stored in the snapshot or Evidence Pack.

The system must not label a plain checksum as authenticated or cryptographically signed. A signed-pack workflow requires an authenticated source snapshot plus a separate external pack key.

HMAC protects integrity/authenticity relative to possession of the secret; it does not establish who originally collected the evidence, prove platform truth, or replace provenance fields and source review.

## 11. Safety boundary

The product must not implement or recommend:

- CAPTCHA bypass;
- account-pool rotation to evade controls;
- fingerprint spoofing;
- automated engagement;
- access-control bypass;
- automated continuation after platform safety systems explicitly block the session.

Public or user-authorized read-only collection is the product boundary.

## 12. Commercial release validation gate

A release should not be called scientifically validated solely because automated tests pass. Before claiming validated signal-classification quality, use a frozen, versioned, human-reviewed holdout spanning multiple materially different categories and difficult negatives.

The current machine-checkable minimums are intentionally high:

- at least **400 unique holdout comments**;
- at least **50 positive examples per signal class**;
- at least **3 materially different categories**;
- duplicate-content ratio no higher than **2%**;
- every holdout item independently reviewed by at least **2 reviewers**;
- all reviewer disagreements explicitly adjudicated before scoring;
- raw agreement at least **0.85** and Cohen's kappa at least **0.65** for every signal class;
- no final-holdout examples copied from hard-coded lexical rules merely to inflate scores;
- the final holdout must not be reused for rule tuning and then reported as untouched validation evidence.

Metric gates use the **lower bound of a two-sided 95% Wilson confidence interval**, not only point estimates:

| Signal | Precision lower bound | Recall lower bound |
| --- | ---: | ---: |
| Questions | 0.85 | 0.80 |
| Complaints / risk | 0.90 | 0.85 |
| Purchase intent | 0.90 | 0.85 |
| Positive feedback | 0.85 | 0.80 |

The evaluation report must preserve per-class confusion counts, error examples, inter-rater statistics, duplicate statistics, category coverage, and a dataset fingerprint.

Even when all machine gates pass, software does **not** self-approve a scientific validation claim. A human must verify reviewer independence, holdout governance, provenance, category relevance, and leakage controls. See `VALIDATION.md`.

Until that evidence exists, the UI and client reports must continue describing the signal layer as transparent rule-based triage.

## 13. Engineering release gate

A production-ready local/pilot release requires, at minimum:

- syntax checks for every executable/core module;
- unit/regression tests;
- API end-to-end tests;
- real headless-browser UI end-to-end checks;
- malformed/empty/duplicate input tests;
- snapshot-order/diff regression tests;
- safety-state tests;
- checksum/HMAC integrity tests including wrong/missing-key failures;
- CSV/Evidence Pack/report export checks;
- signed Evidence Pack end-to-end verification when authenticated integrity is enabled;
- Docker build, non-root execution, read-only root filesystem, and persistence/restart check;
- no known P0/P1 defects;
- documented remaining limitations.

Passing these gates establishes implementation evidence, not scientific truth. Claims about consumer behavior must remain proportional to the captured source evidence.
