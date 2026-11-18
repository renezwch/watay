# 🌊 Watay Autonomous Showcase Ecosystem

> **Live Proof of the Autonomous Developer-Tool GTM Playbook (`watay.dev`)**  
> *Production-Grade OpenAPI 3.1 Specifications · Idiomatic TypeScript & Python SDKs · SpecDrift Gatekeeper Reports · 100% Client-Side*

---

## 🎯 Overview

This directory demonstrates **Watay's autonomous multi-language SDK and API gatekeeper pipeline** in action on three demanding, realistic real-world API ecosystems:

1. 🤖 **AI/LLM Gateway (`llm-gateway`)**: Modern OpenAI/Anthropic-style inference and embeddings router API with Bearer auth, streaming/usage schemas, model enums, and rate-limit headers.
2. 💳 **FinTech Ledger (`fintech-ledger`)**: High-throughput multi-currency double-entry ledger and payment API with idempotency keys, webhooks, cursor pagination, and API-key security.
3. ☁️ **Edge Cloud Deploy (`cloud-deploy`)**: Modern container and edge service deployment platform with complex nested configuration schemas, environment variables, and rollback endpoints.

All showcases prove the core thesis of **TestInc's Autonomous Developer-Tool GTM Playbook** (`knowhow/gtm-playbooks/autonomous-devtool-gtm.md`): software agents can autonomously parse complex specifications, generate idiomatic zero-dependency client libraries, write contract tests against local mock servers, and detect directional breaking API changes without human intervention.

---

## 📁 Directory Structure

```
products/watay/showcases/
├── README.md                          # This overview and execution guide
├── build-showcases.ts                 # Autonomous compilation and verification pipeline
├── run-demo.ts                        # One-command live interactive showcase runner
├── specs/                             # Real-world OpenAPI 3.1 specifications (v1 and v2)
│   ├── llm-gateway-v1.json            # AI Gateway initial release
│   ├── llm-gateway-v2.json            # AI Gateway v2 (Breaking model enum & new required params)
│   ├── fintech-ledger-v1.json         # Payment Ledger initial release
│   ├── fintech-ledger-v2.json         # Payment Ledger v2 (Breaking compliance fields & pagination)
│   ├── cloud-deploy-v1.json           # Cloud Deploy initial release
│   └── cloud-deploy-v2.json           # Cloud Deploy v2 (Breaking container config restructuring)
└── generated/                         # Autonomously compiled SDKs & SpecDrift reports
    ├── llm-gateway/
    │   ├── typescript/                # Zero-dep typed TypeScript SDK + node:test contract tests
    │   ├── python/                    # Python 3.10+ dataclass SDK + unittest contract tests
    │   └── SPECDRIFT_REPORT.md        # Semantic breaking-change analysis (v1 -> v2)
    ├── fintech-ledger/
    │   ├── typescript/
    │   ├── python/
    │   └── SPECDRIFT_REPORT.md
    └── cloud-deploy/
        ├── typescript/
        ├── python/
        └── SPECDRIFT_REPORT.md
```

---

## 🚀 Quickstart: Run the Showcases

### 1. Interactive One-Command Demo
To run the full demonstration across all three showcases with formatted terminal outputs, SpecDrift summaries, and live contract test execution:

```bash
node products/watay/showcases/run-demo.ts
```

### 2. Regenerate All Showcase SDKs & SpecDrift Reports
To re-run the autonomous generation and verification pipeline (`verifyOutput` / `selfHeal`):

```bash
node products/watay/showcases/build-showcases.ts
```

### 3. Run Contract Tests Directly in Target Repositories

Each generated SDK includes a standalone test suite with an embedded HTTP mock server synthesized directly from the OpenAPI specification:

#### TypeScript SDK Contract Tests:
```bash
# AI Gateway TypeScript SDK (8/8 PASS)
node --test products/watay/showcases/generated/llm-gateway/typescript/tests/

# FinTech Ledger TypeScript SDK (9/9 PASS)
node --test products/watay/showcases/generated/fintech-ledger/typescript/tests/

# Cloud Deploy TypeScript SDK (9/9 PASS)
node --test products/watay/showcases/generated/cloud-deploy/typescript/tests/
```

#### Python SDK Contract Tests:
```bash
# AI Gateway Python SDK (8/8 PASS)
python3 -W error::ResourceWarning -m unittest discover -s products/watay/showcases/generated/llm-gateway/python/tests

# FinTech Ledger Python SDK (9/9 PASS)
python3 -W error::ResourceWarning -m unittest discover -s products/watay/showcases/generated/fintech-ledger/python/tests

# Cloud Deploy Python SDK (9/9 PASS)
python3 -W error::ResourceWarning -m unittest discover -s products/watay/showcases/generated/cloud-deploy/python/tests
```

---

## 🔍 Showcase Highlights & SpecDrift Analysis

### 1. AI/LLM Gateway (`llm-gateway`)
- **Key Operations:** `createChatCompletion`, `createEmbeddings`, `listModels`, `getModel`, `moderateContent`.
- **Breaking Changes in v2 (7):**
  - `operation-removed`: `DELETE /v1/batches/{batchId}` (cancelBatch) was removed.
  - `required-param-added`: `POST /v1/chat/completions` parameter `header:X-Tenant-Id` added as required.
  - `request-enum-value-removed`: `ChatCompletionRequest.model` enum value `"gpt-3.5-turbo"` removed.
  - `request-maximum-tightened`: `ChatCompletionRequest.temperature` maximum tightened from 2 to 1.
  - `response-became-nullable`: `ChatCompletionResponse.choices[].message.content` became nullable.
  - `response-property-removed`: `ModelList.models[].max_output_tokens` removed.
  - `response-property-removed`: `ModelInfo.max_output_tokens` removed.
- **Suggested SemVer Bump:** `MAJOR`

### 2. FinTech Ledger (`fintech-ledger`)
- **Key Operations:** `createAccount`, `createReversal`, `listTransfers`, `createTransfer`, `getTransfer`, `registerWebhook`.
- **Breaking Changes in v2 (7):**
  - `request-type-changed`: `GET /v1/transfers` parameter `limit` type changed `integer -> string` (cursor pagination).
  - `response-type-changed`: `TransferPage.data[].amount_minor_units` type changed `integer -> string`.
  - `request-required-property-added`: `CreateTransferRequest.compliance_purpose` added as required field.
  - `success-response-removed`: `POST /v1/transfers` response `201` removed in favor of `200`.
  - `response-type-changed`: `Transfer.amount_minor_units` type changed `integer -> string`.
  - `response-property-removed`: `WebhookEndpoint.secret_hint` removed.
  - `security-requirement-added`: `POST /v1/webhooks` security requirement `apiKeyAuth` added.
- **Suggested SemVer Bump:** `MAJOR`

### 3. Cloud Deploy (`cloud-deploy`)
- **Key Operations:** `listApps`, `createDeployment`, `getDeployment`, `updateEnvVars`, `getAppMetrics`, `rollbackDeployment`.
- **Breaking Changes in v2 (8):**
  - `request-property-became-required`: `DeploymentRequest.strategy` became required.
  - `request-maximum-tightened`: `DeploymentRequest.config.replicas` maximum tightened from 100 to 50.
  - `response-became-nullable`: `Deployment.endpoint_url` became nullable.
  - `response-became-nullable`: `GET /v1/apps/{appId}/deployments/{deploymentId}` response `endpoint_url` became nullable.
  - `request-property-became-required`: `EnvPatchRequest.restart` became required.
  - `response-property-removed`: `EnvSnapshot.revision` removed.
  - `request-property-became-required`: `RollbackRequest.reason` became required.
  - `response-became-nullable`: `POST /v1/apps/{appId}/rollback` response `endpoint_url` became nullable.
- **Suggested SemVer Bump:** `MAJOR`

---

## 🌐 Interactive Web Explorer

Visit the official Watay landing page at **`products/watay/docs/index.html`** (or [watay.dev](https://watay.dev)) to interactively switch between these showcases, inspect generated code snippets, and review the live SpecDrift breaking-change diffs directly in your browser.
