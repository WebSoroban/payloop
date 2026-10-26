/**
 * @web-soroban/payloop: non-custodial USDC subscriptions on Stellar network.
 *                                                       
 * Build PayLoop contract calls for any Stellar wallet to sign, submit them,
 * and read policies and charges, on testnet or mainnet.                         
 */
import { createHash } from 'crypto';
import {
  Account,
  Address,
  Contract,
  Keypair,
  Networks,
  StrKey,
  TransactionBuilder,
  nativeToScVal,
  rpc,
  scValToNative,
  type xdr,
} from '@stellar/stellar-sdk';

export type PayLoopNetwork = 'testnet' | 'mainnet';
export type PolicyStatus = 'active' | 'paused' | 'revoked' | 'completed';

export const USDC_DECIMALS = 7;
const SCALE = 10n ** BigInt(USDC_DECIMALS);

export const NETWORKS: Record<PayLoopNetwork, { passphrase: string; rpcUrl: string; usdc: string; explorer: string }> = {
  testnet: {
    passphrase: Networks.TESTNET,
    rpcUrl: 'https://soroban-testnet.stellar.org',
    usdc: 'CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA',
    explorer: 'https://stellar.expert/explorer/testnet',
  },
  mainnet: {
    passphrase: Networks.PUBLIC,
    // SDF runs no public mainnet RPC; pass your provider's URL as `rpcUrl`.
    rpcUrl: 'https://mainnet.sorobanrpc.com',
    usdc: 'CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75',
    explorer: 'https://stellar.expert/explorer/public',
  },
};

export const DEFAULT_API_URL = 'https://backend-ide-production-003a.up.railway.app/api';
/** Allowances are granted for ~100 days; the contract requires at least one day. */
const ALLOWANCE_LEDGERS = 100 * 17_280;
const STATUS: PolicyStatus[] = ['active', 'paused', 'revoked', 'completed'];

const CONTRACT_ERRORS: Record<number, string> = {
  1: 'PolicyNotFound', 2: 'InvalidAmount', 3: 'InvalidInterval', 4: 'InvalidCap', 5: 'InvalidParty',
  6: 'NotActive', 7: 'NotPaused', 8: 'AlreadyFinal', 9: 'NotDue', 10: 'Overflow', 11: 'InvalidAllowanceExpiry',
};

export class PayLoopError extends Error {
  constructor(message: string, readonly code: string | null = null, readonly confirmedFailure = false) {
    super(message);
    this.name = 'PayLoopError';
  }
}

function contractErrorName(message: string): string | null {
  const match = message.match(/Error\(Contract, #(\d+)\)/);
  return match ? CONTRACT_ERRORS[Number(match[1])] || `Contract#${match[1]}` : null;
}

/** "1.5" USDC → 15_000_000n stroops. Exact; rejects more than 7 decimals. */
export function toStroops(usdc: string | number | bigint): bigint {
  if (typeof usdc === 'bigint') return usdc;
  const raw = String(usdc).trim();
  if (!/^\d+(\.\d{1,7})?$/.test(raw)) throw new PayLoopError('Use a USDC amount with up to 7 decimal places.');
  const [whole, fraction = ''] = raw.split('.');
  return BigInt(whole) * SCALE + BigInt(fraction.padEnd(USDC_DECIMALS, '0'));
}

export function formatUsdc(stroops: bigint | string): string {
  const value = BigInt(stroops);
  const fraction = (value % SCALE).toString().padStart(USDC_DECIMALS, '0').replace(/0+$/, '');
  return fraction ? `${value / SCALE}.${fraction}` : `${value / SCALE}`;
}

export interface Policy {
  policyId: string;
  subscriber: string;
  merchant: string;
  amount: string;
  intervalSeconds: number;
  cap: string;
  spent: string;
  charges: number;
  failedAttempts: number;
  nextChargeAt: string;
  createdAt: string;
  status: PolicyStatus;
}

export interface Charge {
  eventId: string;
  txHash: string;
  at: string;
  outcome: 'charged' | 'insufficient_balance' | 'insufficient_allowance' | string;
  amount: string;
  chargeNumber: number | null;
  dueAt: string;
  delaySeconds: number;
}

export interface PayLoopClientOptions {
  network: PayLoopNetwork;
  /** WebSoroban API (policy index). Defaults to the hosted API. */
  apiUrl?: string;
  /** PayLoop contract id. Read from the API's /payloop/config when omitted. */
  contractId?: string;
  /** Soroban RPC. Required in practice on mainnet (no public SDF endpoint). */
  rpcUrl?: string;
  /** Inclusion fee in stroops for built transactions (default 10000). */
  inclusionFee?: string;
}

export interface SubmitResult {
  hash: string;
  explorerUrl: string;
}

/**
 * A PayLoop client for one network. Write methods return unsigned, simulated
 * transactions (base64 XDR) for the account named in the call to sign with
 * any Stellar wallet; `submit` sends the signed result.
 */
export function createPayLoopClient(options: PayLoopClientOptions) {
  const network = NETWORKS[options.network];
  if (!network) throw new PayLoopError('network must be testnet or mainnet.');
  const apiUrl = (options.apiUrl || DEFAULT_API_URL).replace(/\/$/, '');
  const rpcUrl = options.rpcUrl || network.rpcUrl;
  const server = new rpc.Server(rpcUrl, { allowHttp: rpcUrl.startsWith('http://') });
  let contractId = options.contractId || '';

  async function api<T>(path: string): Promise<T> {
    const separator = path.includes('?') ? '&' : '?';
    const response = await fetch(`${apiUrl}${path}${separator}network=${options.network}`);
    const body = (await response.json().catch(() => ({}))) as { error?: string };
    if (!response.ok) throw new PayLoopError(body.error || `PayLoop API returned HTTP ${response.status}.`);
    return body as T;
  }

  async function contract(): Promise<Contract> {
    if (!contractId) {
      const config = await api<{ contractId: string | null }>('/payloop/config');
      if (!config.contractId) throw new PayLoopError(`PayLoop is not deployed on ${options.network}.`);
      contractId = config.contractId;
    }
    return new Contract(contractId);
  }

  async function build(source: string, method: string, args: xdr.ScVal[]): Promise<string> {
    const account = await server.getAccount(source);
    const transaction = new TransactionBuilder(account, { fee: options.inclusionFee || '10000', networkPassphrase: network.passphrase })
      .addOperation((await contract()).call(method, ...args))
      .setTimeout(120)
      .build();
    const simulation = await server.simulateTransaction(transaction);
    if (rpc.Api.isSimulationError(simulation)) {
      throw new PayLoopError(simulation.error, contractErrorName(simulation.error));
    }
    return rpc.assembleTransaction(transaction, simulation).build().toXDR();
  }

  async function read(method: string, args: xdr.ScVal[] = []): Promise<unknown> {
    const transaction = new TransactionBuilder(new Account(Keypair.random().publicKey(), '0'), { fee: '100', networkPassphrase: network.passphrase })
      .addOperation((await contract()).call(method, ...args))
      .setTimeout(30)
      .build();
    const simulation = await server.simulateTransaction(transaction);
    if (rpc.Api.isSimulationError(simulation)) throw new PayLoopError(simulation.error, contractErrorName(simulation.error));
    return simulation.result ? scValToNative(simulation.result.retval) : undefined;
  }

  async function rpcCall<T>(method: string, params: Record<string, unknown>): Promise<T> {
    const response = await fetch(rpcUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: Date.now(), method, params }),
    });
    const body = (await response.json()) as { result?: T; error?: { message?: string } };
    if (body.error) throw new PayLoopError(body.error.message || `${method} failed.`);
    return body.result as T;
  }

  const address = (value: string) => nativeToScVal(Address.fromString(value), { type: 'address' });
  const u64 = (value: bigint | string | number) => nativeToScVal(BigInt(value), { type: 'u64' });
  const liveUntil = async () => (await server.getLatestLedger()).sequence + ALLOWANCE_LEDGERS;

  return {
    network: options.network,

    /** Resolved contract id (fetched from the API on first use when not given). */
    async contractId(): Promise<string> {
      await contract();
      return contractId;
    },

    // --- write: unsigned transactions for the named account to sign ----------

    /** Create a policy; the first charge settles in the same transaction. Signed by the subscriber. */
    async buildCreatePolicy(input: { subscriber: string; merchant: string; amount: string | bigint; intervalSeconds: number; cap: string | bigint }) {
      return build(input.subscriber, 'create_policy', [
        address(input.subscriber),
        address(input.merchant),
        nativeToScVal(toStroops(input.amount), { type: 'i128' }),
        u64(input.intervalSeconds),
        nativeToScVal(toStroops(input.cap), { type: 'i128' }),
        nativeToScVal(await liveUntil(), { type: 'u32' }),
      ]);
    },
    /** Signed by the subscriber. */
    buildPause: (policyId: bigint | string, subscriber: string) => build(subscriber, 'pause', [u64(policyId)]),
    /** Signed by the subscriber. */
    buildResume: (policyId: bigint | string, subscriber: string) => build(subscriber, 'resume', [u64(policyId)]),
    /** Ends the policy for good. Signed by the subscriber. */
    buildRevoke: (policyId: bigint | string, subscriber: string) => build(subscriber, 'revoke', [u64(policyId)]),
    /** Ends the policy from the merchant side. Signed by the merchant. */
    buildCancel: (policyId: bigint | string, merchant: string) => build(merchant, 'cancel', [u64(policyId)]),
    /** Renew or trim the allowance to exactly what live policies may still charge. */
    async buildRefreshAllowance(subscriber: string) {
      return build(subscriber, 'refresh_allowance', [address(subscriber), nativeToScVal(await liveUntil(), { type: 'u32' })]);
    },
    /** Charge a due policy. Anyone may submit it; `source` pays the fee. */
    buildCharge: (policyId: bigint | string, source: string) => build(source, 'charge', [u64(policyId)]),

    /**
     * Submit a signed transaction and wait for the result. Throws a PayLoopError
     * with `confirmedFailure: true` only when the network confirmed the failure
     * (nothing was applied, so rebuilding and re-signing is safe).
     */
    async submit(signedXdr: string, timeoutMs = 60_000): Promise<SubmitResult> {
      const sent = await rpcCall<{ hash: string; status: string }>('sendTransaction', { transaction: signedXdr });
      if (sent.status === 'ERROR') throw new PayLoopError('The network rejected the transaction.', null, true);
      if (sent.status === 'TRY_AGAIN_LATER') throw new PayLoopError('The network is busy. Retry shortly.', null, true);
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const result = await rpcCall<{ status: string }>('getTransaction', { hash: sent.hash });
        if (result.status === 'SUCCESS') return { hash: sent.hash, explorerUrl: `${network.explorer}/tx/${sent.hash}` };
        if (result.status === 'FAILED') throw new PayLoopError(`Transaction ${sent.hash} failed on-chain.`, null, true);
        await new Promise((resolve) => setTimeout(resolve, 1_000));
      }
      throw new PayLoopError(`Transaction ${sent.hash} was not confirmed in time; check ${network.explorer}/tx/${sent.hash} before retrying.`);
    },

    /**
     * Build, sign, and submit, rebuilding when the network confirms a failure
     * (e.g. a concurrent create_policy took the policy id this was simulated
     * with). `sign` is called again for each attempt.
     */
    async send(buildTx: () => Promise<string>, sign: (xdr: string) => Promise<string>, retries = 2): Promise<SubmitResult> {
      for (let attempt = 0; ; attempt += 1) {
        try {
          return await this.submit(await sign(await buildTx()));
        } catch (error) {
          if (!(error instanceof PayLoopError) || !error.confirmedFailure || attempt >= retries) throw error;
        }
      }
    },

    // --- read ---------------------------------------------------------------

    /** Authoritative policy state from the contract. */
    async getPolicy(policyId: bigint | string): Promise<Policy> {
      const raw = (await read('get_policy', [u64(policyId)])) as Record<string, any>;
      return {
        policyId: String(raw.id),
        subscriber: String(raw.subscriber),
        merchant: String(raw.merchant),
        amount: BigInt(raw.amount).toString(),
        intervalSeconds: Number(raw.interval),
        cap: BigInt(raw.cap).toString(),
        spent: BigInt(raw.spent).toString(),
        charges: Number(raw.charges),
        failedAttempts: Number(raw.failed_attempts),
        nextChargeAt: new Date(Number(raw.next_charge_at) * 1000).toISOString(),
        createdAt: new Date(Number(raw.created_at) * 1000).toISOString(),
        status: STATUS[Number(raw.status)] || 'active',
      };
    },

    /** Indexed policies for a subscriber or merchant, newest first (up to 100). */
    async policies(filter: { subscriber?: string; merchant?: string; status?: PolicyStatus }): Promise<Policy[]> {
      const query = new URLSearchParams();
      if (filter.subscriber) query.set('subscriber', filter.subscriber);
      if (filter.merchant) query.set('merchant', filter.merchant);
      if (filter.status) query.set('status', filter.status);
      return (await api<{ policies: Policy[] }>(`/payloop/policies?${query}`)).policies;
    },

    /** One indexed policy with its latest charges. */
    async policyWithCharges(policyId: bigint | string): Promise<{ policy: Policy; charges: Charge[] }> {
      return api(`/payloop/policies/${policyId}`);
    },

    /**
     * The subscriber's active policy paying `merchant` exactly `amount` every
     * `intervalSeconds`, or null. Use it to gate access to a plan.
     */
    async activeSubscription(input: { subscriber: string; merchant: string; amount: string | bigint; intervalSeconds: number }): Promise<Policy | null> {
      const amount = toStroops(input.amount);
      const list = await this.policies({ subscriber: input.subscriber, status: 'active' });
      return list.find((policy) => policy.merchant === input.merchant && BigInt(policy.amount) === amount && policy.intervalSeconds === input.intervalSeconds) || null;
    },
  };
}

export type PayLoopClient = ReturnType<typeof createPayLoopClient>;

/**
 * Verify a SEP-53 signed message (Freighter `signMessage`), e.g. to prove a
 * customer controls the wallet whose subscription you are about to honour.
 */
export function verifyWalletSignature(wallet: string, message: string, signatureBase64: string): boolean {
  if (!StrKey.isValidEd25519PublicKey(wallet)) return false;
  const digest = createHash('sha256').update(Buffer.from(`Stellar Signed Message:\n${message}`, 'utf8')).digest();
  const signature = Buffer.from(signatureBase64, 'base64');
  return signature.length === 64 && Keypair.fromPublicKey(wallet).verify(digest, signature);
}
