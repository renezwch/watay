# aurelia-fin-tech-ledger-sdk

> ⚡ Generated autonomously by [Watay](https://watay.dev) — Zero runtime dependencies, SpecDrift-safe & contract-verified.

Typed Python client for **Aurelia FinTech Ledger** (API version `2.0.0`).
Built with stdlib `dataclasses` + `urllib`, runtime contract validation, idempotent retries and typed errors.

## Usage

```python
from aurelia_fin_tech_ledger_sdk import AureliaFinTechLedgerClient

client = AureliaFinTechLedgerClient(base_url="https://ledger.aurelia.dev/v2")
result = client.list_transfers()
```

## Operations

- `client.create_account()` — `POST /v1/accounts` — Open a multi-currency ledger account
- `client.create_reversal()` — `POST /v1/reversals` — Reverse a settled transfer
- `client.list_transfers()` — `GET /v1/transfers` — List paginated ledger transfers
- `client.create_transfer()` — `POST /v1/transfers` — Create an idempotent ledger transfer
- `client.get_transfer()` — `GET /v1/transfers/{transferId}` — Fetch a single transfer by ID
- `client.register_webhook()` — `POST /v1/webhooks` — Register a signed webhook endpoint

## Verification & Errors

- Run contract tests: `python3 -m unittest discover -s tests`
- `ApiError` — non-2xx response (`status`, `body`, `headers`).
- `ValidationError` — request or response violates the OpenAPI contract (`issues`).
- `NetworkError` — connection problems or timeouts.
