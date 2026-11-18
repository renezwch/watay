/**
 * Watay – Client-Side Serverless License Validation (owner: dev-action).
 * 
 * Verifies license keys client-side inside developer machines and CI runners
 * without requiring any proprietary intermediate backend (Zero-Data-Retention).
 * Supports:
 * - Free Tier (default when no key is provided)
 * - Offline / Demo / Test keys (for air-gapped CI, integration tests, and sandbox runs)
 * - Polar.sh MoR License API (POST /v1/customer-portal/license-keys/validate)
 * - LemonSqueezy MoR License API (POST /v1/licenses/validate)
 * 
 * Runtime: Node.js >= 22 (erasable syntax, pure TS, zero external deps).
 */

import type { LicenseStatus, LicenseTier } from '../types.ts';

export type Tier = LicenseTier;
export type Feature =
  | 'diff'
  | 'generate'
  | 'generate:typescript'
  | 'generate:python'
  | 'verify'
  | 'cli'
  | 'contract-tests'
  | 'pr-comment'
  | 'self-heal'
  | 'contract-guard'
  | 'fail-on-breaking'
  | 'auto-pr'
  | 'auto-publish'
  | 'custom-templates'
  | 'multi-tenant'
  | 'audit-log';

const FREE_FEATURES: readonly string[] = [
  'diff',
  'generate',
  'generate:typescript',
  'generate:python',
  'verify',
  'cli',
  'contract-tests',
];

const PRO_FEATURES: readonly string[] = [
  ...FREE_FEATURES,
  'pr-comment',
  'self-heal',
  'contract-guard',
  'fail-on-breaking',
  'auto-pr',
];

const SCALE_FEATURES: readonly string[] = [
  ...PRO_FEATURES,
  'auto-publish',
  'custom-templates',
  'multi-tenant',
  'audit-log',
];

/**
 * Checks whether a tier allows a specific feature.
 */
export function tierAllows(tier: Tier | string, feature: Feature | string): boolean {
  const t = tier.toLowerCase();
  if (t === 'scale') {
    return true;
  }
  if (t === 'pro') {
    return PRO_FEATURES.includes(feature) || FREE_FEATURES.includes(feature);
  }
  return FREE_FEATURES.includes(feature);
}

/**
 * Checks license key provided as parameter or from environment variables.
 * Never throws — always returns a valid LicenseStatus object with free fallback.
 */
export async function checkLicense(
  providedKey?: string,
  envOverride?: Record<string, string | undefined>
): Promise<LicenseStatus> {
  const env = envOverride ?? process.env;
  const rawKey = (
    providedKey ??
    env.WATAY_LICENSE_KEY ??
    env.POLAR_LICENSE_KEY ??
    env.LEMONSQUEEZY_LICENSE_KEY ??
    ''
  ).trim();

  // 1. Free Tier (no key configured)
  if (!rawKey) {
    return {
      tier: 'free',
      valid: true,
      source: 'none',
      features: [...FREE_FEATURES],
      reason: 'Community edition (free tier)',
    };
  }

  // 2. Offline / Demo / Test key evaluation (strict prefix matching)
  const offlineResult = evaluateOfflineKey(rawKey);
  if (offlineResult) {
    return offlineResult;
  }

  // 3. Online verification via Polar.sh or LemonSqueezy
  if (isPolarKey(rawKey, env)) {
    const polarRes = await validatePolarKey(rawKey, env);
    if (polarRes.valid) return polarRes;
  } else if (isLemonSqueezyKey(rawKey)) {
    const lsRes = await validateLemonSqueezyKey(rawKey, env);
    if (lsRes.valid) return lsRes;
  } else {
    // Attempt Polar first, then LemonSqueezy
    const polarResult = await validatePolarKey(rawKey, env);
    if (polarResult.valid) return polarResult;

    const lsResult = await validateLemonSqueezyKey(rawKey, env);
    if (lsResult.valid) return lsResult;
  }

  // 4. Fallback on network unreachable / air-gapped CI runner:
  // Strictly fall back to Free tier per ARCHITECTURE.md §4.5 (no fake pro/scale bypasses)
  return {
    tier: 'free',
    valid: true,
    source: 'none',
    reason: `Network unreachable or key unverified: graceful fallback to free tier for ${maskKey(rawKey)}`,
    features: [...FREE_FEATURES],
  };
}

/**
 * Checks whether an offline demo/test key was supplied.
 * Strictly limited to official demo/test prefixes to prevent arbitrary string bypasses.
 */
function evaluateOfflineKey(key: string): LicenseStatus | null {
  const upper = key.toUpperCase();

  // Explicit revocation/failure patterns for testing
  if (upper.startsWith('INVALID') || upper.startsWith('REVOKED') || upper.startsWith('EXPIRED')) {
    return {
      tier: 'free',
      valid: false,
      source: 'offline-demo',
      reason: 'License key is marked as invalid, revoked, or expired',
      features: [...FREE_FEATURES],
    };
  }

  // Scale tier offline keys (strict prefix check)
  if (
    upper === 'WATAY-DEMO-SCALE' ||
    upper.startsWith('WATAY-DEMO-SCALE') ||
    upper.startsWith('WATAY-SCALE-DEMO') ||
    upper.startsWith('DEMO-SCALE') ||
    upper.startsWith('TEST-SCALE') ||
    upper === 'WATAY-SCALE-KEY'
  ) {
    return {
      tier: 'scale',
      valid: true,
      source: 'offline-demo',
      reason: 'Offline Scale Tier Demo/Test License',
      features: [...SCALE_FEATURES],
    };
  }

  // Pro tier offline keys (including official WATAY-DEMO-PRO from ARCHITECTURE.md)
  if (
    upper === 'WATAY-DEMO-PRO' ||
    upper.startsWith('WATAY-DEMO-PRO') ||
    upper.startsWith('WATAY-PRO-DEMO') ||
    upper.startsWith('DEMO-PRO') ||
    upper.startsWith('TEST-PRO') ||
    upper === 'WATAY-PRO-KEY'
  ) {
    return {
      tier: 'pro',
      valid: true,
      source: 'offline-demo',
      reason: 'Offline Pro Tier Demo/Test License',
      features: [...PRO_FEATURES],
    };
  }

  return null;
}

function isPolarKey(key: string, env: Record<string, string | undefined>): boolean {
  return key.startsWith('polar_') || key.startsWith('polar_lkey_') || Boolean(env.POLAR_ORGANIZATION_ID);
}

function isLemonSqueezyKey(key: string): boolean {
  return (
    key.startsWith('ls_') ||
    key.startsWith('lemonsqueezy_') ||
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(key)
  );
}

/**
 * Validates against Polar.sh customer-portal license-keys API.
 */
async function validatePolarKey(
  key: string,
  env: Record<string, string | undefined>
): Promise<LicenseStatus> {
  const endpoint = env.POLAR_API_URL || 'https://api.polar.sh/v1/customer-portal/license-keys/validate';
  const orgId = env.POLAR_ORGANIZATION_ID;

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3500);

    const body: Record<string, string> = { key };
    if (orgId) {
      body.organization_id = orgId;
    }

    const res = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'Watay-CLI/0.1.0 (Zero-Data-Retention)',
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    clearTimeout(timeout);

    if (!res.ok) {
      return {
        tier: 'free',
        valid: false,
        source: 'polar',
        reason: `Polar API returned HTTP ${res.status}`,
        features: [...FREE_FEATURES],
      };
    }

    const data = (await res.json()) as {
      status?: string;
      expires_at?: string;
      limit_usage?: number;
      usage?: number;
      benefit?: { description?: string; properties?: { tier?: string } };
    };

    const isActive = data.status === 'granted' || data.status === 'active';
    if (!isActive) {
      return {
        tier: 'free',
        valid: false,
        source: 'polar',
        reason: `Polar license status: ${data.status ?? 'unknown'}`,
        features: [...FREE_FEATURES],
      };
    }

    const tierHint = data.benefit?.properties?.tier?.toLowerCase() ?? '';
    const tier: LicenseTier = tierHint.includes('scale') ? 'scale' : 'pro';

    return {
      tier,
      valid: true,
      source: 'polar',
      expiresAt: data.expires_at,
      features: tier === 'scale' ? [...SCALE_FEATURES] : [...PRO_FEATURES],
      reason: `Valid ${tier.toUpperCase()} license via Polar.sh`,
    };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      tier: 'free',
      valid: false,
      source: 'polar',
      reason: `Polar verification error: ${message}`,
      features: [...FREE_FEATURES],
    };
  }
}

/**
 * Validates against LemonSqueezy licenses validate API.
 */
async function validateLemonSqueezyKey(
  key: string,
  env: Record<string, string | undefined>
): Promise<LicenseStatus> {
  const endpoint = env.LEMONSQUEEZY_API_URL || 'https://api.lemonsqueezy.com/v1/licenses/validate';

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3500);

    const res = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Accept': 'application/json',
        'User-Agent': 'Watay-CLI/0.1.0 (Zero-Data-Retention)',
      },
      body: new URLSearchParams({ license_key: key }).toString(),
      signal: controller.signal,
    });
    clearTimeout(timeout);

    if (!res.ok) {
      return {
        tier: 'free',
        valid: false,
        source: 'lemonsqueezy',
        reason: `LemonSqueezy API returned HTTP ${res.status}`,
        features: [...FREE_FEATURES],
      };
    }

    const data = (await res.json()) as {
      valid?: boolean;
      license_key?: {
        status?: string;
        expires_at?: string;
      };
      meta?: {
        variant_name?: string;
      };
    };

    const isValid = Boolean(data.valid && data.license_key?.status === 'active');
    if (!isValid) {
      return {
        tier: 'free',
        valid: false,
        source: 'lemonsqueezy',
        reason: 'LemonSqueezy reported invalid or inactive license',
        features: [...FREE_FEATURES],
      };
    }

    const variant = data.meta?.variant_name?.toLowerCase() ?? '';
    const tier: LicenseTier = variant.includes('scale') ? 'scale' : 'pro';

    return {
      tier,
      valid: true,
      source: 'lemonsqueezy',
      expiresAt: data.license_key?.expires_at,
      features: tier === 'scale' ? [...SCALE_FEATURES] : [...PRO_FEATURES],
      reason: `Valid ${tier.toUpperCase()} license via LemonSqueezy`,
    };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      tier: 'free',
      valid: false,
      source: 'lemonsqueezy',
      reason: `LemonSqueezy verification error: ${message}`,
      features: [...FREE_FEATURES],
    };
  }
}

/**
 * Checks whether a given feature is authorized under the active license.
 */
export function hasFeature(status: LicenseStatus, feature: string): boolean {
  if (!status.valid) return false;
  return status.features ? status.features.includes(feature) : tierAllows(status.tier, feature);
}

/**
 * Masks license key for secure logging (Zero-Data-Retention compliance).
 * Example: "WATAY-DEMO-PRO" -> "WATAY-****-PRO" or "WATAY-****"
 */
export function maskKey(key: string): string {
  if (!key) return '';
  const t = key.trim();
  if (t.length <= 8) return '****';
  return `${t.slice(0, 4)}-****-${t.slice(-4)}`;
}

/**
 * Formats a terminal/CI banner describing the active license status.
 */
export function formatLicenseBanner(status: LicenseStatus): string {
  const badge = status.tier.toUpperCase();
  const sourceInfo = status.source !== 'none' ? ` (${status.source})` : '';
  const expiry = status.expiresAt ? ` | Expires: ${status.expiresAt}` : '';
  const featCount = status.features ? status.features.length : 0;
  return `[Watay License] Tier: ${badge}${sourceInfo}${expiry} | Features: ${featCount} active`;
}
