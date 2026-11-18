# aurelia-fin-tech-ledger-sdk

> ⚡ Generated autonomously by [Watay](https://watay.dev) — Zero runtime dependencies, SpecDrift-safe & contract-verified.

Typed TypeScript client for **Aurelia FinTech Ledger** (API version `2.0.0`).
Built with native `fetch`, runtime request/response schema validation, idempotent retries and typed errors.

## Usage

```ts
import { AureliaFinTechLedgerClient } from 'aurelia-fin-tech-ledger-sdk';

const client = new AureliaFinTechLedgerClient({ baseUrl: "https://ledger.aurelia.dev/v2" });
const result = await client.listTransfers();
```

## Operations

- `client.createAccount()` — `POST /v1/accounts` — Open a multi-currency ledger account
- `client.createReversal()` — `POST /v1/reversals` — Reverse a settled transfer
- `client.listTransfers()` — `GET /v1/transfers` — List paginated ledger transfers
- `client.createTransfer()` — `POST /v1/transfers` — Create an idempotent ledger transfer
- `client.getTransfer()` — `GET /v1/transfers/{transferId}` — Fetch a single transfer by ID
- `client.registerWebhook()` — `POST /v1/webhooks` — Register a signed webhook endpoint

## Verification & Errors

- Run contract tests: `node --test tests/`
- `ApiError` — non-2xx response (`status`, `body`, `headers`).
- `ValidationError` — request or response violates the OpenAPI contract (`issues`).
- `NetworkError` — connection problems, timeouts, aborts.
