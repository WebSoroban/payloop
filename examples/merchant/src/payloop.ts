import { config } from './config.js';

export interface Policy {
  policyId: string;
  subscriber: string;
  merchant: string;
  amount: string;
  amountUsdc: string;
  intervalSeconds: number;
  spentUsdc: string;
  capUsdc: string;
  charges: number;
  failedAttempts: number;
  nextChargeAt: string;
  status: 'active' | 'paused' | 'revoked' | 'completed';
}

/** USDC has 7 decimals on Stellar; compare plan amounts in stroops, never floats.   */
export function toStroops(usdc: string): bigint {
  const [whole, fraction = ''] = usdc.trim().split('.');
  return BigInt(whole) * 10_000_000n + BigInt(fraction.padEnd(7, '0').slice(0, 7));
}

async function get<T>(path: string): Promise<T> {
  const separator = path.includes('?') ? '&' : '?';
  const response = await fetch(`${config.apiUrl}${path}${separator}network=${config.network}`, { signal: AbortSignal.timeout(10_000) });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error((body as { error?: string }).error || `PayLoop API returned HTTP ${response.status}.`);
  return body as T;
}

export async function merchantPolicies(status?: Policy['status']): Promise<Policy[]> {
  const query = new URLSearchParams({ merchant: config.merchant, ...(status ? { status } : {}) });
  return (await get<{ policies: Policy[] }>(`/payloop/policies?${query}`)).policies;
}

/**
 * The subscriber's active policy for this merchant's plan, or null.
 * A policy counts only if it pays this merchant the plan amount on the plan interval.
 */
export async function activeSubscription(subscriber: string): Promise<Policy | null> {
  const query = new URLSearchParams({ subscriber, status: 'active' });
  const { policies } = await get<{ policies: Policy[] }>(`/payloop/policies?${query}`);
  const amount = toStroops(config.planAmountUsdc);
  return policies.find((policy) =>
    policy.merchant === config.merchant &&
    BigInt(policy.amount) === amount &&
    policy.intervalSeconds === config.planIntervalSeconds,
  ) || null;
}
