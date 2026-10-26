# PayLoop merchant

Gate content behind a non-custodial USDC subscription. Customers subscribe with
PayLoop: one signed policy pays you a fixed USDC amount on a fixed interval
from their own wallet. This server checks for an active policy before it
serves premium content. You run no chain infrastructure: WebSoroban's relayer
submits the charges and its indexer serves the policies.

## 1. Configure

```bash
cp .env.example .env
```
 
- `PAYLOOP_NETWORK`: `testnet` (test USDC, the default) or `mainnet` (real Circle USDC).
- `MERCHANT_ADDRESS`: the Stellar address you get paid at. It needs a USDC trustline on that network.
- `PLAN_AMOUNT_USDC` and `PLAN_INTERVAL_SECONDS`: the plan a customer must hold.
  `0.1` every `60` seconds is a good testnet demo; production plans are usually
  monthly (`2592000`).

```bash
pnpm install
pnpm dev
```

## 2. Subscribe as a customer

Open the WebSoroban **PayLoop** page on testnet, connect a wallet, fund it with
test USDC, and sign a policy to your `MERCHANT_ADDRESS` with the plan amount
and interval. The first charge settles immediately.

## Go live on mainnet

1. Set `PAYLOOP_NETWORK=mainnet` and `SUBSCRIBE_URL=https://payloop.websoroban.in/?network=mainnet`.
2. Use a mainnet `MERCHANT_ADDRESS` with a trustline to Circle USDC
   (issuer `GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN`).
3. Set a real plan, for example `9.99` every `2592000` seconds.
4. Subscribe once yourself from a second mainnet wallet and confirm `/api/premium`
   returns `200`, then revoke.

Testnet and mainnet policies are separate; a testnet subscription never unlocks
mainnet access.

## 3. Unlock premium content

The customer proves wallet ownership by signing a short message (SEP-53
`signMessage`, supported by Freighter):

```bash
curl "http://localhost:8788/api/challenge?wallet=G…CUSTOMER"
# sign the returned message in the wallet, then:
curl -X POST http://localhost:8788/api/premium \
  -H 'Content-Type: application/json' \
  -d '{"wallet":"G…CUSTOMER","message":"…","signature":"<base64>"}'
```

- `200`: the wallet holds an active policy for your plan.
- `402 subscription_required`: no matching active policy. The response links to the subscribe page.
- `401 wallet_not_verified`: the signature is missing, wrong, reused, or older than five minutes.

## 4. Watch payments arrive

```bash
pnpm watch-charges
```

This prints each charge as the relayer settles it, new subscribers, and any
charge a subscriber could not cover. The relayer retries those automatically
with backoff. `GET /api/subscribers` lists every active subscription paying you.

## How access stays correct

- A policy counts only if it pays **your** address the **plan amount** on the
  **plan interval**. Amounts are compared in stroops, never floats.
- Customers can pause or revoke at any time from their wallet. A paused or
  revoked policy stops granting access on the next request.
- The contract enforces the amount, schedule, and safety cap on-chain. Nobody,
  including WebSoroban, can charge a customer more than they signed for.
