# 🪢 Watay (`watay.dev`)

> **Autonomous Multi-Language SDK Generation, Contract Guard Semantic Gatekeeper & Contract Testing.**  
> *100% Client-Side Execution. Zero-Data-Retention. Zero External Runtime Dependencies.*

[![CI & Contract Verification](https://github.com/renezwch/watay/actions/workflows/ci.yml/badge.svg)](https://github.com/renezwch/watay/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Runtime: Node >= 22](https://img.shields.io/badge/Node-%3E%3D22-brightgreen.svg)](https://nodejs.org/)
[![Python: 3.10+](https://img.shields.io/badge/Python-3.10%2B-blue.svg)](https://python.org)
[![Zero-Data-Retention](https://img.shields.io/badge/Security-Zero--Data--Retention-blueviolet.svg)](#zero-data-retention-architecture)
[![Watay Pricing](https://img.shields.io/badge/Pricing-Free%20%7C%20%2449%20%7C%20%24199-orange.svg)](#pricing--editions)

---

## ⚡ What is Watay?

**Watay** (*Quechua for "to bind / connect firmly"*) is an autonomous developer toolchain designed to eliminate the friction between API backend changes and client-side SDK consumption.

Instead of paying enterprise SaaS platforms tens of thousands of dollars to route your proprietary schemas through their servers, Watay runs **100% client-side** inside your own terminal or your own GitHub Action runner. 

```
                                      ┌────────────────────────────────────────────────┐
                                      │       Your CI / GitHub Actions Runner          │
                                      │  (100% Client-Side · Zero Data Retention)      │
                                      │                                                │
[OpenAPI 3.0 / 3.1] ───> [Watay CLI] ─┼─► Contract Differ ──► Gatekeeper (Block PR)   │
 (JSON or YAML)                       │  ├─► TS Generator   ──► Idiomatic TS Client    │
                                      │  ├─► PY Generator   ──► Pure Python Stdlib SDK │
                                      │  └─► Healer Engine  ──► Contract Tests (Mock)  │
                                      └────────────────────────────────────────────────┘
```

---

## 🚀 Key Highlights

- 🛡️ **Zero-Data-Retention (ZDR):** Your OpenAPI specifications, API keys, source code, and schemas never leave your infrastructure. The only external request Watay can make is an optional, lightweight license-key status ping directly to Merchant-of-Record endpoints (Polar.sh / LemonSqueezy).
- 🧬 **Contract Guard Semantic Differ:** Direction-aware OpenAPI diffing. Unlike naive textual diffs, Contract Guard understands contravariance and covariance: adding an optional field to a request is non-breaking, but removing a response field or adding a required request parameter is immediately flagged as a breaking change.
- 📦 **Multi-Language Idiomatic Codegen:**
  - **TypeScript:** Fully typed, zero-dependency client with modern `fetch`, typed error classes, and runtime payload validation.
  - **Python:** Python 3.10+ standard library client using `dataclasses` and `urllib.request` (zero third-party dependencies required).
- 🔄 **Deterministic Output:** Byte-identical file generation on every run. No random timestamps, no unordered maps. Perfect for Git diffs and reproducible builds.
- 🩹 **Self-Healing Loop:** Built-in syntax stripping and mock-server validation verify generated SDKs against your specification. Optional Bring-Your-Own-Key (BYOK) repair hook for automated issue healing.
- ⚡ **Zero Node Dependencies:** Engineered to run natively on Node.js >= 22 using built-in erasable TypeScript execution and Node stdlib. No heavy `node_modules` installations required.

---

## 💻 Quickstart (CLI)

You can run Watay directly without installing anything via `npx`:

### 1. Semantic Breaking-Change Detection (`Contract Guard`)
Compare your current OpenAPI specification against a baseline:

```bash
# Compare specs (Markdown report output)
npx watay diff openapi-v1.json openapi-v2.json

# Fail CI immediately if breaking changes are detected
npx watay diff openapi-v1.json openapi-v2.json --fail-on-breaking

# Output as JSON
npx watay diff openapi-v1.json openapi-v2.json --json
```

### 2. Multi-Language SDK Generation
Generate client SDKs for TypeScript and Python:

```bash
# Generate both TypeScript and Python SDKs (with built-in contract tests)
npx watay generate openapi.json --lang ts,python --out ./generated-sdks

# Generate with self-healing verification loop
npx watay generate openapi.json --lang ts,python --out ./generated-sdks --heal
```

### 3. Verify SDK Integrity & Run Mock Contract Tests
Verify that generated SDKs compile and respond correctly against synthesized specification mocks:

```bash
npx watay verify openapi.json --lang ts,python
```

---

## 🤖 GitHub Action Integration

Add Watay as a gatekeeper in your Pull Request workflow:

Create `.github/workflows/watay-contract-guard.yml`:

```yaml
name: Watay Contract Guard & SDK Build

on:
  pull_request:
    paths:
      - 'openapi.json'
      - 'openapi.yaml'
      - 'specs/**'

permissions:
  contents: read
  pull-requests: write # Required for automated PR comments

jobs:
  contract-guard:
    runs-on: ubuntu-latest
    steps:
      - name: Checkout Code
        uses: actions/checkout@v4
        with:
          fetch-depth: 0 # Needed to diff against origin/main

      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: 22

      - name: Run Watay Action
        uses: testinc/watay@v1
        with:
          spec-path: 'openapi.json'
          base-ref: 'main'
          fail-on-breaking: 'true'
          post-comment: 'true'
          languages: 'typescript,python'
          output-dir: './generated-sdks'
          license-key: ${{ secrets.WATAY_LICENSE_KEY }} # Optional (defaults to Free Community Tier)
```

### Automated PR Comment Example
When a Pull Request introduces API changes, Watay automatically publishes an idempotent Markdown report:

> ## 🪢 Watay Contract Guard & SDK Report
> > 🛡️ **Zero-Data-Retention:** 100% client-side runner execution. No specifications or secrets were transferred to external servers.
> 
> **API:** `PetStore API` v`2.1.0` | **License Tier:** `PRO`
> 
> ### 🚨 Semantic Breaking-Change Analysis
> - **Suggested SemVer Bump:** `MAJOR`
> - **Breaking Changes:** `1`
> - **Non-Breaking Changes:** `2`
> 
> #### 🚨 Breaking Changes
> | Code | Location | Description |
> | :--- | :--- | :--- |
> | `required-param-added` | `POST /pets` | New required query parameter `tenant_id` breaks existing clients |
> 
> #### ✨ Non-Breaking Additions
> | Code | Location | Description |
> | :--- | :--- | :--- |
> | `operation-added` | `GET /pets/{petId}/vaccinations` | New operation endpoint added |
> 
> > ❌ **Gatekeeper:** Pull request blocked by Watay because breaking API changes were detected without approval. *(Override with `watay-allow-breaking` label).*

---

## 🛠️ CLI Command Reference

### `watay diff <old-spec> <new-spec>`
Analyzes two OpenAPI specifications and prints semantic differences:
- `--old <path>`: Old/base OpenAPI spec path (alternative to positional `<old-spec>`).
- `--new <path>`: New/head OpenAPI spec path (alternative to positional `<new-spec>`).
- `--fail-on-breaking`: Exit with code `1` if any breaking changes are detected.
- `--json`: Output `DiffResult` as machine-readable JSON instead of Markdown.

### `watay generate <spec>`
Generates typed client SDKs and mock contract test suites:
- `-i, --input <path>`: Path to OpenAPI specification file (alternative to positional `<spec>`).
- `--lang <list>`: Comma-separated target languages: `ts,python` (default: `ts`).
- `--out <dir>`: Target directory for generated output (default: `./watay-sdk`).
- `--package-name <name>`: Override generated package name.
- `--no-tests`: Skip generating mock contract tests (tests are generated by default).
- `--verify`: Verify generated SDKs after writing.
- `--heal`: Run self-healing verification loop on generated SDKs.
- `--license-key <key>`: Optional Watay license key (or `WATAY_LICENSE_KEY` env).
- `--json`: Output generation summary as JSON.

### `watay verify <spec>`
Validates specification syntax and runs smoke verification on generated SDKs:
- `-i, --input <path>`: Path to OpenAPI specification file (alternative to positional `<spec>`).
- `--lang <list>`: Comma-separated target languages: `ts,python` (default: `ts,python`).
- `--json`: Output verification report as JSON.

### `watay license`
Checks active license status:
- `--key <license-key>`: License key to evaluate (masked in text output).
- `--json`: Output `LicenseStatus` as JSON.

---

## 💎 Pricing & Editions

Watay is built on an open-core model. All core CLI generation and diffing capabilities are open source.

| Feature | Community ($0) | Pro ($49/repo/mo) | Scale ($199/org/mo) |
| :--- | :---: | :---: | :---: |
| **Execution Architecture** | 100% Client-Side | 100% Client-Side | 100% Client-Side |
| **Zero Data Retention** | ✅ Yes | ✅ Yes | ✅ Yes |
| **Multi-Language Codegen (TS & Python)**| ✅ Unlimited | ✅ Unlimited | ✅ Unlimited |
| **Contract Guard Semantic Differ** | ✅ CLI | ✅ CLI + CI Gate | ✅ CLI + CI Gate |
| **Automated PR Markdown Comments** | ❌ | ✅ Yes | ✅ Yes |
| **Mock Contract Test Generation** | Basic | ✅ Automated | ✅ Automated |
| **Self-Healing Build Verification** | ❌ | ✅ Included | ✅ Priority Loop |
| **Automated Package Publishing (npm/PyPI)** | ❌ | ❌ | ✅ Automated |
| **Custom CodeGen Templates** | ❌ | ❌ | ✅ Full Access |
| **Offline Air-Gapped Keys** | ❌ | ✅ Available | ✅ Dedicated |

Purchase license keys instantly via self-serve at [watay.dev/pricing](https://watay.dev#pricing).

---

## 🛡️ Zero-Data-Retention Architecture

Enterprise teams trust Watay because it does not operate a multi-tenant cloud SaaS proxy:
1. **Runner Isolation:** Watay runs as a standalone Node.js process inside your machine or GitHub runner.
2. **No Spec Ingestion:** Specs are read from disk or local git commits. They are never transmitted over the network.
3. **Serverless License Validation:** License keys are checked directly against Merchant-of-Record billing endpoints (Polar.sh / LemonSqueezy). No proprietary telemetry, tracking, or payloads are attached.
4. **Air-Gapped Friendly:** In restricted environments without internet access, offline demo and enterprise keys are fully supported without outbound connectivity.

---

## 📄 License

Watay core is distributed under the [MIT License](LICENSE).  
Copyright © 2026 TestInc. All rights reserved.
