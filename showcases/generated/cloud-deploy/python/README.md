# stratos-cloud-deploy-sdk

> ⚡ Generated autonomously by [Watay](https://watay.dev) — Zero runtime dependencies, Contract-safe & contract-verified.

Typed Python client for **Stratos Cloud Deploy** (API version `2.0.0`).
Built with stdlib `dataclasses` + `urllib`, runtime contract validation, idempotent retries and typed errors.

## Usage

```python
from stratos_cloud_deploy_sdk import StratosCloudDeployClient

client = StratosCloudDeployClient(base_url="https://control.stratos.dev/v2")
result = client.list_apps()
```

## Operations

- `client.list_apps()` — `GET /v1/apps` — List deployed edge applications
- `client.create_deployment()` — `POST /v1/apps/{appId}/deployments` — Trigger a container deployment
- `client.get_deployment()` — `GET /v1/apps/{appId}/deployments/{deploymentId}` — Inspect deployment status
- `client.update_env_vars()` — `PUT /v1/apps/{appId}/env` — Replace runtime environment variables
- `client.get_app_metrics()` — `GET /v1/apps/{appId}/metrics` — Read edge request and latency metrics
- `client.rollback_deployment()` — `POST /v1/apps/{appId}/rollback` — Roll back an application to a previous deployment

## Verification & Errors

- Run contract tests: `python3 -m unittest discover -s tests`
- `ApiError` — non-2xx response (`status`, `body`, `headers`).
- `ValidationError` — request or response violates the OpenAPI contract (`issues`).
- `NetworkError` — connection problems or timeouts.
