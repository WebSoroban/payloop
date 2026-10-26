# PayLoop
 
Non-custodial USDC subscriptions on Stellar. A subscriber signs one policy
(merchant, amount, interval, and a cap on the total) from their own wallet. The
first charge settles in the same transaction; a relayer submits each later
charge when it is due. Funds stay in the subscriber's wallet until then, and
the subscriber can pause, resume, or revoke at any time.
  
| Path | What it is |
| --- | --- |
| [`contract/`](contract) | The Soroban contract (Rust, soroban-sdk 29), its tests, deployment manifests, and security review |
| [`sdk/`](sdk) | [`@web-soroban/payloop`](https://www.npmjs.com/package/@web-soroban/payloop): build, sign, and track policies from any wallet |
| [`examples/merchant/`](examples/merchant) | An Express server that unlocks content for active subscribers |

## Deployments
 
| Network | Contract | Token |
| --- | --- | --- |
| Testnet | [`CCNMZWP2NQMTJF2J42W4DNYNOAQQYWOCJ2IQROXWYSJVOI3DKSH7YRIH`](https://stellar.expert/explorer/testnet/contract/CCNMZWP2NQMTJF2J42W4DNYNOAQQYWOCJ2IQROXWYSJVOI3DKSH7YRIH) | Circle test USDC |
| Mainnet | [`CDQ6I65CP3JHLNGMEHWE4BP2OMLWOUMZ77U53JPAURFZPZBVH6PYEXPN`](https://stellar.expert/explorer/public/contract/CDQ6I65CP3JHLNGMEHWE4BP2OMLWOUMZ77U53JPAURFZPZBVH6PYEXPN) | Circle USDC |

Both run the same build (wasm `d42be154c35ac597792f41d83ccf1d70abd29edebdec135a44ce31fd78a19318`).

> **Mainnet status:** the contract has had an internal security review, and
> every finding is fixed or documented in [`contract/AUDIT.md`](contract/AUDIT.md).
> It has **not** been independently audited. Start with small amounts.
 
## How it works
 
| Call | Signer | Effect |
| --- | --- | --- |
| `create_policy` | subscriber | Grants the USDC allowance and takes the first charge. Any failure reverts everything. |
| `charge` | anyone | Takes a charge once it is due. Recipient, amount, schedule, and cap are fixed by the policy. |
| `pause` / `resume` | subscriber | Stops and restarts charges. Missed periods are never back-billed. |
| `revoke` | subscriber | Ends the policy. Final. |
| `cancel` | merchant | Ends the policy from the merchant side. Final. |
| `refresh_allowance` | subscriber | Renews or trims the allowance to what live policies may still charge. |

The contract never holds funds, has no admin, and cannot be upgraded.
WebSoroban runs the relayer and an indexer, so a merchant runs no chain
infrastructure.

## Use it

Subscribe from a browser wallet:

```bash
npm install @web-soroban/payloop @stellar/stellar-sdk
```

```ts
import { createPayLoopClient } from '@web-soroban/payloop'

const payloop = createPayLoopClient({ network: 'mainnet', rpcUrl: 'https://your-mainnet-rpc' })

await payloop.send(
  () => payloop.buildCreatePolicy({
    subscriber, merchant, amount: '9.99', intervalSeconds: 30 * 86_400, cap: '119.88',
  }),
  (xdr) => signWithWallet(xdr),
)
```

Gate access on a server:

```ts
const plan = await payloop.activeSubscription({
  subscriber, merchant, amount: '9.99', intervalSeconds: 30 * 86_400,
})
```

Or try it without code at [payloop.websoroban.in](https://payloop.websoroban.in).

## Develop

```bash
cd contract && cargo test && stellar contract build   # stellar-cli 25.2+
cd sdk && npm install && npm test
```

To check a deployment, run `shasum -a 256 target/wasm32v1-none/release/payloop.wasm`
in `contract/` and compare the result with `deployments/<network>.json`.

## Learn more

- [PayLoop guide](https://websoroban.in/docs/payloop)
- One-off paid requests: [WebSoroban/x402-kit](https://github.com/WebSoroban/x402-kit)

## License

MIT
