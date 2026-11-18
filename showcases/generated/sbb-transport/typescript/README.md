# sbb-swiss-public-transport-api-sdk

> ⚡ Generated autonomously by [Watay](https://watay.dev) — Zero runtime dependencies, Contract-safe & contract-verified.

Typed TypeScript client for **SBB Swiss Public Transport API** (API version `1.0.0`).
Built with native `fetch`, runtime request/response schema validation, idempotent retries and typed errors.

## Usage

```ts
import { SbbSwissPublicTransportApiClient } from 'sbb-swiss-public-transport-api-sdk';

const client = new SbbSwissPublicTransportApiClient({ baseUrl: "https://transport.opendata.ch" });
const result = await client.getConnections({ /* from, to */ });
```

## Operations

- `client.getConnections()` — `GET /v1/connections` — Find next public transport connections between two Swiss locations
- `client.searchLocations()` — `GET /v1/locations` — Search Swiss train stations, bus stops, POIs and addresses
- `client.getStationboard()` — `GET /v1/stationboard` — Live departure board (Abfahrtstafel) for a Swiss station

## Verification & Errors

- Run contract tests: `node --test tests/`
- `ApiError` — non-2xx response (`status`, `body`, `headers`).
- `ValidationError` — request or response violates the OpenAPI contract (`issues`).
- `NetworkError` — connection problems, timeouts, aborts.
