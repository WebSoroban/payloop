// Print every new PayLoop charge to this merchant as the relayer settles it. 
import { merchantPolicies, type Policy } from '../src/payloop.js';

const seen = new Map<string, number>();
const POLL_MS = 15_000;

async function poll(first: boolean) {
  const policies: Policy[] = await merchantPolicies();
  for (const policy of policies) {
    const previous = seen.get(policy.policyId);
    if (!first && previous !== undefined && policy.charges > previous) {
      console.log(`${new Date().toISOString()} policy #${policy.policyId} paid ${policy.amountUsdc} USDC (charge ${policy.charges}, total ${policy.spentUsdc}/${policy.capUsdc})`);
    } else if (!first && previous === undefined) {
      console.log(`${new Date().toISOString()} new subscriber ${policy.subscriber} on policy #${policy.policyId} (${policy.status})`);
    }
    if (!first && policy.failedAttempts > 0 && previous === policy.charges) {
      console.log(`${new Date().toISOString()} policy #${policy.policyId} could not be charged (${policy.failedAttempts} attempts); the relayer retries`);
    }
    seen.set(policy.policyId, policy.charges);
  }
  if (first) console.log(`Watching ${policies.length} policies…`);
}

await poll(true);
setInterval(() => poll(false).catch((error) => console.error(error instanceof Error ? error.message : error)), POLL_MS);
