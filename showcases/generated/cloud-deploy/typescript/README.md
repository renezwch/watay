# stratos-cloud-deploy-sdk

> ⚡ Generated autonomously by [Watay](https://watay.dev) — Zero runtime dependencies, SpecDrift-safe & contract-verified.

Typed TypeScript client for **Stratos Cloud Deploy** (API version `2.0.0`).
Built with native `fetch`, runtime request/response schema validation, idempotent retries and typed errors.

## Usage

```ts
import { StratosCloudDeployClient } from 'stratos-cloud-deploy-sdk';

const client = new StratosCloudDeployClient({ baseUrl: "https://control.stratos.dev/v2" });
const result = await client.listApps();
```

## Operations

- `client.listApps()` — `GET /v1/apps` — List deployed edge applications
- `client.createDeployment()` — `POST /v1/apps/{appId}/deployments` — Trigger a container deployment
- `client.getDeployment()` — `GET /v1/apps/{appId}/deployments/{deploymentId}` — Inspect deployment status
- `client.updateEnvVars()` — `PUT /v1/apps/{appId}/env` — Replace runtime environment variables
- `client.getAppMetrics()` — `GET /v1/apps/{appId}/metrics` — Read edge request and latency metrics
- `client.rollbackDeployment()` — `POST /v1/apps/{appId}/rollback` — Roll back an application to a previous deployment

## Verification & Errors

- Run contract tests: `node --test tests/`
- `ApiError` — non-2xx response (`status`, `body`, `headers`).
- `ValidationError` — request or response violates the OpenAPI contract (`issues`).
- `NetworkError` — connection problems, timeouts, aborts.
