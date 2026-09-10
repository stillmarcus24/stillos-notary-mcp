'use strict';
/*
 * Regression: a caller that hits a 402 must be able to authorize a payment and retry
 * the identical operation, and must be refused everywhere that is not safe.
 *
 * Through 1.2.2 this package could only report the paywall. Every paid tool returned
 * `{ payment_required: true }` and the call ended there -- no X-PAYMENT construction,
 * no signer, no retry. bin.cjs told the caller to "attach payment and retry" using a
 * mechanism that did not exist in the package.
 *
 * Local mock servers only. No network, no wallet, no real settlement. The paying
 * transport here is a stub that sets a header; nothing is signed and nothing is spent.
 */
const http = require('http');
const assert = require('assert');

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); console.log('  PASS  ' + name); pass++; }
  catch (e) { console.log('  FAIL  ' + name + '\n        ' + e.message); fail++; }
}

const USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
const PAYTO = '0x6243E363a3047173346Fa49C947Db204D4445634';

// A server that demands payment, then honours a correct one.
function paywall({ price = 1000, network = 'base', scheme = 'exact', acceptHeader = 'good-payment', payTo = PAYTO } = {}) {
  const seen = [];
  const srv = http.createServer((req, res) => {
    let b = ''; req.on('data', c => b += c);
    req.on('end', () => {
      const hdr = req.headers['x-payment'];
      seen.push(hdr || null);
      if (!hdr) {
        res.writeHead(402, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({
          error: 'payment required',
          accepts: [{ scheme, network, maxAmountRequired: price, asset: USDC, payTo, extra: { name: 'USDC' }, maxTimeoutSeconds: 60 }],
        }));
      }
      if (hdr !== acceptHeader) {           // wrong/replayed/malformed payment
        res.writeHead(402, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ error: 'payment rejected', accepts: [{ scheme, network, maxAmountRequired: price, asset: USDC, payTo }] }));
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ match: false, entity: JSON.parse(b).entity, source_as_of: '2026-09-10', receipt_hash: 'sha256:deadbeef', signature: 'sig', tier: 'paid' }));
    });
  });
  srv.seen = seen;
  return srv;
}

function load(port) {
  process.env.STILLOS_NOTARY = `http://127.0.0.1:${port}`;
  const p = require.resolve('../index.cjs');
  delete require.cache[p];
  return require(p);
}
const listen = srv => new Promise(r => srv.listen(0, '127.0.0.1', () => r(srv.address().port)));
const payWith = token => (url, init) => fetch(url, { ...init, headers: { ...init.headers, 'X-PAYMENT': token } });

(async () => {
  console.log('notary-mcp — 402 must be crossable, and unsafe payment must be refused\n');
  const servers = [];

  // --- the happy path: 402 -> authorized payment -> retry -> paid result
  {
    const srv = paywall(); const port = await listen(srv); servers.push(srv);
    const { callTool, CODES } = load(port);

    const unpaid = await callTool('screen_entity', { agent: 'test', entity: 'Acme Corp' });
    t('no credential -> not fulfilled, machine-readable code', () => {
      assert.strictEqual(unpaid.ok, false);
      assert.strictEqual(unpaid.paid, false);
      assert.strictEqual(unpaid.code, CODES.PAYMENT_REQUIRED);
    });
    t('no credential -> price, payTo and network are exposed to the caller', () => {
      assert.strictEqual(unpaid.payment.amount_usd, 0.001);
      assert.strictEqual(unpaid.payment.pay_to, PAYTO);
      assert.strictEqual(unpaid.payment.network, 'base');
    });
    t('no credential -> remediation names a real mechanism', () => {
      assert.match(unpaid.remediation, /STILLOS_NOTARY_WALLET_KEY|opts\.account|opts\.fetch/);
    });

    const paid = await callTool('screen_entity', { agent: 'test', entity: 'Acme Corp' }, { fetch: payWith('good-payment') });
    t('authorized payment -> identical operation retried and fulfilled', () => {
      assert.strictEqual(paid.ok, true);
      assert.strictEqual(paid.paid, true);
      assert.strictEqual(paid.tier, 'paid');
      assert.strictEqual(paid.entity, 'Acme Corp');   // the SAME operation, not a different one
    });
    t('authorized payment -> amount attributed for the ledger', () => {
      assert.strictEqual(paid.amount_usd, 0.001);
    });
    t('authorized payment -> server actually received X-PAYMENT', () => {
      assert.ok(srv.seen.includes('good-payment'));
    });
    t('retry is bounded: one 402, one payment, one retry — no loop', () => {
      assert.ok(srv.seen.length <= 3, 'saw ' + srv.seen.length + ' requests');
    });
  }

  // --- negative: server refuses the payment we sent
  {
    const srv = paywall({ acceptHeader: 'only-this-one' }); const port = await listen(srv); servers.push(srv);
    const { callTool, CODES } = load(port);
    const r = await callTool('screen_entity', { agent: 'test', entity: 'Acme' }, { fetch: payWith('wrong-payment') });
    t('rejected payment -> PAYMENT_REJECTED, no fulfillment', () => {
      assert.strictEqual(r.ok, false);
      assert.strictEqual(r.paid, false);
      assert.strictEqual(r.code, CODES.PAYMENT_REJECTED);
    });
    t('rejected payment -> not retried into a loop', () => {
      assert.ok(srv.seen.length <= 3, 'saw ' + srv.seen.length + ' requests');
    });
  }

  // --- negative: unsupported network. must refuse BEFORE handing anything to the signer.
  {
    const srv = paywall({ network: 'ethereum-mainnet' }); const port = await listen(srv); servers.push(srv);
    const { callTool, CODES } = load(port);
    let handed = false;
    const r = await callTool('screen_entity', { agent: 'test', entity: 'Acme' }, { fetch: (u, i) => { handed = true; return payWith('good-payment')(u, i); } });
    t('unsupported network -> refused, and the transport was never invoked', () => {
      assert.strictEqual(r.code, CODES.PAYMENT_UNSUPPORTED);
      assert.strictEqual(handed, false, 'payment transport should not be reached');
    });
  }

  // --- negative: unsupported scheme
  {
    const srv = paywall({ scheme: 'upto' }); const port = await listen(srv); servers.push(srv);
    const { callTool, CODES } = load(port);
    const r = await callTool('screen_entity', { agent: 'test', entity: 'Acme' }, { fetch: payWith('good-payment') });
    t('unsupported scheme -> refused', () => assert.strictEqual(r.code, CODES.PAYMENT_UNSUPPORTED));
  }

  // --- negative: price above the caller's ceiling
  {
    const srv = paywall({ price: 50000000 }); const port = await listen(srv); servers.push(srv);
    const { callTool, CODES } = load(port);
    const r = await callTool('screen_entity', { agent: 'test', entity: 'Acme' }, { fetch: payWith('good-payment') });
    t('$50 against a $1.50 ceiling -> refused, not signed', () => {
      assert.strictEqual(r.code, CODES.PAYMENT_UNSUPPORTED);
      assert.match(r.error, /ceiling/);
    });
    const ok = await callTool('screen_entity', { agent: 'test', entity: 'Acme' }, { fetch: payWith('good-payment'), maxUsd: 100 });
    t('same call with an explicitly raised ceiling -> allowed', () => assert.strictEqual(ok.ok, true));
  }

  // --- negative: malformed 402 body (no payTo / no amount)
  {
    const srv = http.createServer((req, res) => {
      res.writeHead(402, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'payment required', accepts: [{ scheme: 'exact', network: 'base' }] }));
    });
    const port = await listen(srv); servers.push(srv);
    const { callTool, CODES } = load(port);
    const r = await callTool('screen_entity', { agent: 'test', entity: 'Acme' }, { fetch: payWith('good-payment') });
    t('malformed 402 (no payTo/amount) -> BAD_402, nothing constructed', () => assert.strictEqual(r.code, CODES.BAD_402));
  }

  // --- the caller declines: supplying no credential must never auto-spend
  {
    const srv = paywall(); const port = await listen(srv); servers.push(srv);
    const { callTool } = load(port);
    const r = await callTool('screen_entity', { agent: 'test', entity: 'Acme' });
    t('caller supplies nothing -> package never spends on its own', () => {
      assert.strictEqual(r.paid, false);
      assert.deepStrictEqual(srv.seen, [null], 'exactly one unpaid request, no payment attempt');
    });
  }

  // --- free routes must not be dragged through the payment path
  {
    const srv = http.createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ verdict: 'CONFIRMED', receipt_hash: 'sha256:abc' }));
    });
    const port = await listen(srv); servers.push(srv);
    const { callTool } = load(port);
    const r = await callTool('claim_verdict', { agent: 'test', claim: 'x', resolver: { type: 'http_status' } });
    t('free route still works and is unchanged', () => {
      assert.strictEqual(r.ok, true);
      assert.strictEqual(r.verdict, 'CONFIRMED');
    });
  }

  // --- no secret may ever reach an error string
  {
    const srv = paywall({ acceptHeader: 'nope' }); const port = await listen(srv); servers.push(srv);
    const { callTool } = load(port);
    const SECRET = '0x' + 'a'.repeat(64);
    const r = await callTool('screen_entity', { agent: 'test', entity: 'Acme' }, { fetch: payWith(SECRET) });
    t('no credential material leaks into the error payload', () => {
      assert.ok(!JSON.stringify(r).includes(SECRET), 'secret found in response');
    });
  }

  for (const s of servers) s.close();
  console.log(`\n  ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
