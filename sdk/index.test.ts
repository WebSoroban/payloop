import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { Keypair, TransactionBuilder } from '@stellar/stellar-sdk';
import { NETWORKS, PayLoopError, createPayLoopClient, formatUsdc, toStroops, verifyWalletSignature } from './index';
 
test('prices policies in Circle USDC', () => {
  assert.equal(NETWORKS.testnet.usdc, 'CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA');
  assert.equal(NETWORKS.mainnet.usdc, 'CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75');
});
 
test('converts USDC amounts exactly', () => {
  assert.equal(toStroops('1'), 10_000_000n);
  assert.equal(toStroops('0.0000001'), 1n);
  assert.equal(toStroops('12.5'), 125_000_000n);
  assert.equal(toStroops(3), 30_000_000n);
  assert.throws(() => toStroops('0.00000001'), PayLoopError);
  assert.throws(() => toStroops('-1'), PayLoopError);
  assert.equal(formatUsdc(125_000_000n), '12.5');
  assert.equal(formatUsdc('10000000'), '1');
});

test('rejects unknown networks', () => {
  assert.throws(() => createPayLoopClient({ network: 'futurenet' as never }), PayLoopError);
});

test('verifies SEP-53 wallet signatures', () => {
  const wallet = Keypair.random();
  const message = 'Sign in to Example';
  const digest = createHash('sha256').update(`Stellar Signed Message:\n${message}`).digest();
  const signature = wallet.sign(digest).toString('base64');
  assert.equal(verifyWalletSignature(wallet.publicKey(), message, signature), true);
  assert.equal(verifyWalletSignature(wallet.publicKey(), 'other', signature), false);
  assert.equal(verifyWalletSignature(Keypair.random().publicKey(), message, signature), false);
  assert.equal(verifyWalletSignature('not-a-key', message, signature), false);
});

test('reads policies from the API with the network parameter', async (t) => {
  const calls: string[] = [];
  t.mock.method(globalThis, 'fetch', async (url: string) => {
    calls.push(url);
    const policy = { policyId: '1', subscriber: 'GS', merchant: 'GM', amount: '10000000', intervalSeconds: 60, status: 'active' };
    return new Response(JSON.stringify({ policies: [policy, { ...policy, policyId: '2', amount: '20000000' }] }));
  });
  const client = createPayLoopClient({ network: 'mainnet', apiUrl: 'https://api.example.com/api/', contractId: 'C' });
  const found = await client.activeSubscription({ subscriber: 'GS', merchant: 'GM', amount: '2', intervalSeconds: 60 });
  assert.equal(found?.policyId, '2');
  assert.equal(calls[0], 'https://api.example.com/api/payloop/policies?subscriber=GS&status=active&network=mainnet');
  assert.equal(await client.activeSubscription({ subscriber: 'GS', merchant: 'GX', amount: '1', intervalSeconds: 60 }), null);
});

test('surfaces API errors', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({ error: 'PayLoop is not deployed on mainnet yet.' }), { status: 404 }));
  const client = createPayLoopClient({ network: 'mainnet', apiUrl: 'https://api.example.com/api' });
  await assert.rejects(client.contractId(), /not deployed on mainnet/);
});

test('retries only confirmed failures', async () => {
  const client = createPayLoopClient({ network: 'testnet', contractId: 'C' });
  let builds = 0;
  const confirmed = async () => { builds += 1; throw new PayLoopError('conflict', null, true); };
  await assert.rejects(client.send(confirmed, async (xdr) => xdr, 2), /conflict/);
  assert.equal(builds, 3);
  builds = 0;
  const unknown = async () => { builds += 1; throw new PayLoopError('not confirmed in time'); };
  await assert.rejects(client.send(unknown, async (xdr) => xdr, 2), /not confirmed/);
  assert.equal(builds, 1);
});

// Live: simulates against the deployed testnet contract (read-only, no funds).
test('builds and reads against the testnet contract', { skip: !process.env.PAYLOOP_LIVE_TEST }, async () => {
  const deployment = (await import('../contract/deployments/testnet.json', { with: { type: 'json' } })).default;
  const client = createPayLoopClient({ network: 'testnet', contractId: deployment.contractId });
  const policy = await client.getPolicy(1);
  assert.equal(policy.policyId, '1');
  assert.match(policy.status, /active|paused|revoked|completed/);
  const xdr = await client.buildRevoke(1, policy.subscriber).catch((error: PayLoopError) => error);
  if (typeof xdr === 'string') {
    assert.equal(TransactionBuilder.fromXDR(xdr, NETWORKS.testnet.passphrase).operations.length, 1);
  } else {
    assert.equal(xdr.code, 'AlreadyFinal');
  }
  await assert.rejects(client.getPolicy(999_999_999), (error: PayLoopError) => error.code === 'PolicyNotFound');
});
