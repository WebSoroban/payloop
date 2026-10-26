import express from 'express';
import { config } from './config.js';
import { activeSubscription, merchantPolicies } from './payloop.js';
import { challengeFor, verifyWalletSignature } from './wallet-auth.js';

const app = express();
app.use(express.json());

app.get('/health', (_request, response) => {
  response.json({ ok: true, network: config.network, merchant: config.merchant });
});

// 1. The customer asks for a message to sign with their wallet. 
app.get('/api/challenge', (request, response) => {
  const wallet = String(request.query.wallet || '');
  response.json({ message: challengeFor(wallet) });
});

// 2. They send it back signed; access depends on an active PayLoop policy. 
app.post('/api/premium', async (request, response) => {
  const { wallet, message, signature } = request.body as { wallet?: string; message?: string; signature?: string };
  const problem = verifyWalletSignature(String(wallet || ''), String(message || ''), String(signature || ''));
  if (problem) return response.status(401).json({ error: 'wallet_not_verified', message: problem });

  try {
    const policy = await activeSubscription(String(wallet));
    if (!policy) {
      return response.status(402).json({
        error: 'subscription_required',
        message: `Subscribe for ${config.planAmountUsdc} USDC every ${config.planIntervalSeconds}s to unlock this content.`,
        subscribe: config.subscribeUrl,
        merchant: config.merchant,
      });
    }
    response.json({
      content: 'Premium content for active subscribers.',
      subscription: { policyId: policy.policyId, nextChargeAt: policy.nextChargeAt, charges: policy.charges },
    });
  } catch (error) {
    response.status(503).json({ error: 'payloop_unavailable', message: error instanceof Error ? error.message : 'PayLoop API unavailable.' });
  }
});

// Merchant dashboard data: every active subscription paying this address. 
app.get('/api/subscribers', async (_request, response) => {
  try {
    const policies = await merchantPolicies('active');
    response.json({ count: policies.length, policies });
  } catch (error) {
    response.status(503).json({ error: error instanceof Error ? error.message : 'PayLoop API unavailable.' });
  }
});

app.listen(config.port, () => {
  console.log(`PayLoop merchant listening on http://localhost:${config.port}`);
  console.log(`Plan: ${config.planAmountUsdc} USDC every ${config.planIntervalSeconds}s to ${config.merchant}`);
});
