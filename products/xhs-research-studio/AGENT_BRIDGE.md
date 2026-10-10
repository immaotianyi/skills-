# XHS Research Studio — Authorized Harvest Agent Bridge

`harvest-agent-adapter.mjs` is the first-party bridge between Research Studio's persisted run system and an operator-controlled browser/agent runtime.

It does **not** scrape Xiaohongshu itself, create accounts, bypass login/CAPTCHA/access controls, rotate accounts/IPs, or manufacture an authenticated browser session. The external Agent Gateway must run inside a data/account boundary the operator is authorized to use.

## Why this bridge exists

Research Studio already has a fixed-command executor protocol:

```text
project + keywords + competitors + budget
        ↓
xhs-harvest-run-plan/1.0
        ↓
configured executor (shell:false)
        ↓
completed + Harvest v2
or manual_action_required
        ↓
server-side validation + snapshot ingest
```

The bundled Xiaohongshu Harvest skill is a `type: prompt` skill. skill-central MCP exposes prompt skills to an IDE/agent, but does not itself launch a browser. The Agent Bridge closes the repository-side gap by converting the Studio executor plan plus the versioned Harvest prompt into a fixed HTTP job contract for an authorized browser agent.

## Production configuration

Configure the Studio executor to run the first-party adapter:

```text
XHS_STUDIO_HARVEST_EXECUTOR=node
XHS_STUDIO_HARVEST_EXECUTOR_ARGS=["harvest-agent-adapter.mjs"]

XHS_EXECUTOR_AGENT_GATEWAY=https://agent-gateway.example.com/xhs/jobs

# Configure at least one for a remote gateway.
XHS_EXECUTOR_AGENT_TOKEN=...
# and/or
XHS_EXECUTOR_AGENT_HMAC_SECRET=...   # >= 32 UTF-8 bytes

# Optional, defaults to 300000 and is bounded to 1s..30m.
XHS_EXECUTOR_AGENT_TIMEOUT_MS=300000
```

For local development/CI only, an `http://127.0.0.1/...`, `http://localhost/...`, or loopback IPv6 gateway is allowed. Non-loopback gateways must use HTTPS. Redirects are rejected.

`XHS_EXECUTOR_*` variables are intentionally compatible with the existing executor environment allowlist. Arbitrary parent-process secrets are not forwarded to child executors.

## Job request

The adapter sends one `POST` request with JSON:

```json
{
  "schemaVersion": "xhs-authorized-browser-agent-job/1.0",
  "requestedAt": "...",
  "skill": {
    "id": "xiaohongshu-harvest",
    "type": "prompt",
    "sha256": "...",
    "promptSha256": "...",
    "prompt": "# Xiaohongshu Harvest v2 ..."
  },
  "plan": {
    "schemaVersion": "xhs-harvest-run-plan/1.0",
    "runId": "run_...",
    "project": {
      "id": "prj_...",
      "name": "...",
      "client": "...",
      "category": "...",
      "keywords": ["..."],
      "competitors": ["..."]
    },
    "budget": {
      "maxNotes": 80,
      "maxComments": 2000,
      "maxSeconds": 300
    },
    "safety": {
      "publicOrAuthorizedReadOnlyOnly": true,
      "bypassCaptcha": false,
      "bypassLogin": false,
      "bypassAccessControls": false,
      "bypassRateLimits": false,
      "onBlockedState": "manual_action_required"
    }
  },
  "contract": {
    "authorizedPublicReadOnlyOnly": true,
    "hardStops": ["CAPTCHA", "LOGIN_REQUIRED", "ACCESS_DENIED", "BLOCKED", "THROTTLED"],
    "onHardStop": "manual_action_required",
    "requiredResult": "completed+Harvest v2 OR manual_action_required"
  }
}
```

The adapter validates that the incoming Studio plan has not weakened any safety bit before making a network request.

The copy of `xiaohongshu-harvest.yaml` under `agent/` exists so the product-only Docker build context can execute the bridge. A test requires it to remain byte-identical to the root `.skills/03-domains/xiaohongshu-harvest.yaml` source; drift fails CI.

## Authentication

For a remote gateway, configure at least one of:

- Bearer token: `Authorization: Bearer <XHS_EXECUTOR_AGENT_TOKEN>`
- HMAC: `X-XHS-Timestamp` plus `X-XHS-Signature: v1=<HMAC-SHA256(timestamp + "." + raw-body)>`

If both are configured, both are sent. HMAC secrets shorter than 32 UTF-8 bytes are rejected.

The gateway endpoint is fixed by deployment configuration, never by project/user input. The adapter rejects URL credentials, fragments, insecure remote HTTP, and HTTP redirects.

## Gateway responses

Successful collection:

```json
{
  "status": "completed",
  "harvest": {
    "schemaVersion": "2.0",
    "source": {},
    "notes": [],
    "comments": [],
    "authors": [],
    "queries": [],
    "meta": {}
  }
}
```

Manual handoff:

```json
{
  "status": "manual_action_required",
  "reason": "Complete login in the authorized browser session.",
  "riskState": "LOGIN_REQUIRED",
  "gaps": ["Search results require login."]
}
```

Research Studio still performs its own strict Harvest v2 validation and server-side note/comment budget checks before snapshot commit. The gateway cannot make an invalid payload valid simply by returning `status: completed`.

## Browser-runtime expectations

A production Agent Gateway should:

- use only public or explicitly authorized browser sessions;
- execute the supplied Harvest prompt/method against the supplied project plan;
- prefer `window.__INITIAL_STATE__`, then rendered DOM, and OCR only as a media-text fallback;
- preserve source URLs, capture methods, confidence and observed ranking positions;
- stop on login/CAPTCHA/access/rate-limit states and return `manual_action_required`;
- never automatically switch accounts/IPs/fingerprints to evade a hard stop;
- enforce its own execution timeout and resource limits in addition to Studio's limits;
- keep browser/session credentials inside the gateway boundary rather than returning them to Research Studio.

## CI coverage vs. real release proof

CI now exercises:

```text
Studio run
  → fixed-command executor
  → harvest-agent-adapter.mjs
  → loopback mock Agent Gateway
  → Harvest v2
  → Studio validation
  → persisted snapshot
```

This proves the repository-side integration contract and container packaging. It does **not** prove that a production Xiaohongshu account/session is available or authorized.

Before calling a paid deployment live, run at least one controlled end-to-end acceptance test through the actual Agent Gateway/browser session:

1. create a real authorized project with bounded keywords;
2. launch the run from Studio (no JSON copy/paste);
3. verify either a valid Harvest v2 snapshot or an explicit manual login/CAPTCHA handoff;
4. after any authorized manual handoff, resume the same run without consuming a second run unit;
5. inspect source URLs/provenance in the resulting snapshot;
6. run a second collection and verify diff/attention output.

Until that external test is performed, the code path is integration-ready but the real browser runtime prerequisite remains open.
