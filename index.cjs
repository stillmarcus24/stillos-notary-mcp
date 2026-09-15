'use strict';
/*
 * stillos-notary-mcp — pure logic, no stdio/process side effects.
 * Every call hits the real public notary over HTTPS (stillosdigitalholdings.com) --
 * no local/internal-only code path, so this works identically wherever it runs.
 */
const https = require('https');
const http = require('http');
const { URL } = require('url');

const NOTARY = (process.env.STILLOS_NOTARY || 'https://stillosdigitalholdings.com/notary').replace(/\/+$/, '');
const { version: PKG_VERSION } = require('./package.json');
const UA = `stillos-notary-mcp/${PKG_VERSION} (+https://www.npmjs.com/package/stillos-notary-mcp)`;

/* ---------------------------------------------------------------------------
 * x402 payment continuation (2026-09-10).
 *
 * Three of the five tools below are paid, and until now this package could only
 * report that fact: every 402 returned `{ payment_required: true }` and the call
 * ended there. There was no way, anywhere in this package, to attach a payment and
 * retry -- no X-PAYMENT construction, no signer, no wallet adapter. `bin.cjs` told
 * the caller to "attach payment and retry" using a mechanism that did not exist.
 *
 * That is a closed door at the exact moment a buyer has agreed to pay. Measured
 * cost: three separate integrators running our published packages made 117 / 73 / 2
 * calls to a paid route across four days and converted zero times, and
 * state/payments/external-revenue.jsonl has 0 rows lifetime.
 *
 * This is a port, not a new design. stillos-kya has shipped a working, audited
 * version of this since 0.4.0; the shape below (capability detection -> descriptor
 * -> refuse-unknown-rails -> pay -> retry ONCE) is deliberately identical so there
 * is one payment behavior to reason about across StillOS packages rather than two.
 * StillOS never receives, logs or persists the caller's key, and no secret is ever
 * placed in an error message.
 * ------------------------------------------------------------------------- */

// Machine-readable error codes. An autonomous caller should branch on `code`, never
// on message text.
const CODES = {
  PAYMENT_REQUIRED: 'PAYMENT_REQUIRED',                       // 402, and this client cannot pay
  PAYMENT_CAPABILITY_MISSING: 'PAYMENT_CAPABILITY_MISSING',   // 402, payment libs unavailable here
  PAYMENT_CONSTRUCTION_FAILED: 'PAYMENT_CONSTRUCTION_FAILED', // signer rejected or could not sign
  PAYMENT_REJECTED: 'PAYMENT_REJECTED',                       // we paid, server still refused
  PAYMENT_UNSUPPORTED: 'PAYMENT_UNSUPPORTED',                 // 402 asks for a rail we will not pay
  BAD_402: 'BAD_402',                                         // 402 body malformed / unusable
};

// Only these are auto-payable. Signing for an unexpected chain or token on the
// caller's behalf is exactly what an autonomous client must never do.
const SUPPORTED_NETWORKS = new Set(['base', 'eip155:8453']);
const SUPPORTED_SCHEMES = new Set(['exact']);

// Ceiling per call, in USD. The dearest route here is $1.00 (file_dispute); the
// default leaves headroom for a price change without silently authorizing more.
const DEFAULT_MAX_USD = Number(process.env.STILLOS_NOTARY_MAX_USD || 1.50);

function paymentCapability() {
  const deps = {};
  try { require.resolve('x402-fetch'); deps['x402-fetch'] = true; } catch { deps['x402-fetch'] = false; }
  try { require.resolve('viem/accounts'); deps.viem = true; } catch { deps.viem = false; }
  const available = deps['x402-fetch'] && deps.viem;
  return {
    available,
    deps,
    reason: available ? null
      : 'x402-fetch and/or viem could not be resolved in this runtime. They ship as optionalDependencies of stillos-notary-mcp; a normal `npm install` installs them. If missing, the install likely ran with --no-optional or --omit=optional.',
  };
}

// Flatten the server's x402 `accepts[0]` into a stable descriptor an agent can act on
// without knowing that maxAmountRequired is USDC base units.
function paymentDescriptor(body) {
  const a = body && Array.isArray(body.accepts) && body.accepts[0] ? body.accepts[0] : null;
  if (!a) return null;
  const amt = Number(a.maxAmountRequired);
  return {
    mechanism: 'x402',
    scheme: a.scheme || null,
    network: a.network || null,
    asset: a.asset || null,
    asset_name: (a.extra && a.extra.name) || null,
    pay_to: a.payTo || null,
    amount_usd: Number.isFinite(amt) ? amt / 1e6 : null,
    amount_base_units: Number.isFinite(amt) ? String(amt) : null,
    resource: a.resource || null,
    max_timeout_seconds: a.maxTimeoutSeconds || null,
  };
}

function payErr(code, message, extra) {
  const e = new Error(message);
  e.code = code;
  if (extra) Object.assign(e, extra);
  return e;
}

// A 402 is untrusted input. Refuse anything we did not expect rather than signing it.
function assertPayable(desc) {
  if (!desc || !desc.pay_to || !desc.amount_base_units) {
    throw payErr(CODES.BAD_402, 'payment requirement was missing payTo or amount — refusing to construct a payment');
  }
  if (!SUPPORTED_NETWORKS.has(String(desc.network))) {
    throw payErr(CODES.PAYMENT_UNSUPPORTED, `refusing to auto-pay on unsupported network: ${desc.network}`, { payment: desc });
  }
  if (!SUPPORTED_SCHEMES.has(String(desc.scheme))) {
    throw payErr(CODES.PAYMENT_UNSUPPORTED, `refusing to auto-pay unsupported scheme: ${desc.scheme}`, { payment: desc });
  }
  const cap = Number(opts_maxUsd());
  if (Number.isFinite(desc.amount_usd) && Number.isFinite(cap) && desc.amount_usd > cap) {
    throw payErr(CODES.PAYMENT_UNSUPPORTED, `price $${desc.amount_usd} exceeds this client's per-call ceiling $${cap} (set STILLOS_NOTARY_MAX_USD to raise it)`, { payment: desc });
  }
}

let _maxUsdOverride = null;
function opts_maxUsd() { return _maxUsdOverride != null ? _maxUsdOverride : DEFAULT_MAX_USD; }

/**
 * Build a payment-capable fetch from whatever the caller supplied, in order of how
 * much we'd rather they used it:
 *   1. opts.fetch    — an already payment-capable fetch. StillOS never sees a key.
 *   2. opts.account  — a viem account / signer object.
 *   3. STILLOS_NOTARY_WALLET_KEY — a raw hex key. Documented fallback, not the headline.
 * Returns null when the caller supplied no credential at all (the ordinary case).
 */
function resolvePayingFetch(opts) {
  if (typeof opts.fetch === 'function') return opts.fetch;
  const signer = opts.account || opts.signer || opts.wallet || process.env.STILLOS_NOTARY_WALLET_KEY || null;
  if (!signer) return null;

  const cap = paymentCapability();
  if (!cap.available) throw payErr(CODES.PAYMENT_CAPABILITY_MISSING, cap.reason, { deps: cap.deps });

  const { wrapFetchWithPayment } = require('x402-fetch');
  const { privateKeyToAccount } = require('viem/accounts');
  let account;
  try {
    account = typeof signer === 'string' ? privateKeyToAccount(signer) : signer;
  } catch {
    // Deliberately omits the underlying error: viem echoes the offending key material
    // into its own message on a malformed key, and that must never surface.
    throw payErr(CODES.PAYMENT_CONSTRUCTION_FAILED, 'could not construct a signing account from the supplied credential (value withheld)');
  }
  const maxValue = BigInt(Math.round(opts_maxUsd() * 1e6)); // USDC has 6 decimals
  return wrapFetchWithPayment(fetch, account, maxValue);
}

// Pay and retry ONCE. x402 is a single challenge/response: one 402, one payment, one
// retry. A second 402 means the payment was rejected -- retrying would re-sign and
// risk paying twice for nothing, so it is a hard stop, not a backoff loop.
async function payAndRetry(path, body, payingFetch) {
  let res;
  try {
    res = await payingFetch(NOTARY + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': UA },
      body: JSON.stringify(body),
    });
  } catch (err) {
    throw payErr(CODES.PAYMENT_CONSTRUCTION_FAILED, `payment could not be constructed or sent: ${String(err && err.message).slice(0, 200)}`);
  }
  const text = await res.text();
  let json;
  try { json = text ? JSON.parse(text) : {}; } catch {
    throw payErr(CODES.PAYMENT_REJECTED, 'unparseable response after payment: ' + text.slice(0, 120));
  }
  if (res.status === 402) throw payErr(CODES.PAYMENT_REJECTED, 'payment was sent and the server still returned 402', { body: json });
  if (res.status >= 400) throw payErr(CODES.PAYMENT_REJECTED, `HTTP ${res.status} after payment`, { body: json });
  return json;
}

/**
 * Wrap a paid route: call it free-first, and on a 402 either pay-and-retry (when the
 * caller gave us a credential) or return a machine-actionable payment requirement.
 * The unpaid return is deliberately richer than the old `{payment_required:true}`:
 * an agent can read `payment` and `remediation` and act without reverse-engineering
 * our response shape.
 */
async function paidCall(path, body, opts = {}) {
  if (opts.maxUsd != null) _maxUsdOverride = Number(opts.maxUsd);
  try {
    const r = await req('POST', path, body);
    if (r.error) return { ok: false, error: r.error };
    if (r.status !== 402) return { ok: true, status: r.status, ...r.body };

    const desc = paymentDescriptor(r.body);
    let payingFetch = null;
    try {
      payingFetch = resolvePayingFetch(opts);
    } catch (e) {
      return { ok: false, payment_required: true, paid: false, code: e.code, error: e.message, payment: desc, ...(e.deps ? { deps: e.deps } : {}) };
    }

    if (!payingFetch) {
      return {
        ok: false,
        payment_required: true,
        paid: false,
        code: CODES.PAYMENT_REQUIRED,
        error: desc && desc.amount_usd != null
          ? `payment required ($${desc.amount_usd} ${desc.asset_name || 'USDC'} on ${desc.network})`
          : 'payment required',
        payment: desc,
        remediation: 'Pass a payment-capable fetch as opts.fetch, a viem account as opts.account, or set STILLOS_NOTARY_WALLET_KEY, then call again — this package will attach the x402 payment and retry automatically.',
        ...r.body,
      };
    }

    try {
      assertPayable(desc);
      const paidBody = await payAndRetry(path, body, payingFetch);
      return { ok: true, paid: true, amount_usd: desc.amount_usd, ...paidBody };
    } catch (e) {
      return { ok: false, payment_required: true, paid: false, code: e.code || CODES.PAYMENT_REJECTED, error: e.message, payment: desc };
    }
  } finally {
    _maxUsdOverride = null;
  }
}

function req(method, path, body) {
  return new Promise((resolve) => {
    let u; try { u = new URL(NOTARY + path); } catch { return resolve({ error: 'bad notary URL' }); }
    const lib = u.protocol === 'http:' ? http : https;
    const data = body ? JSON.stringify(body) : null;
    const headers = { accept: 'application/json', 'user-agent': UA };
    if (data) { headers['content-type'] = 'application/json'; headers['content-length'] = Buffer.byteLength(data); }
    const r = lib.request(u, { method, headers }, (res) => {
      let b = ''; res.on('data', c => b += c);
      res.on('end', () => { try { resolve({ status: res.statusCode, body: JSON.parse(b) }); } catch { resolve({ status: res.statusCode, body: b }); } });
    });
    r.on('error', (e) => resolve({ error: e.message }));
    r.setTimeout(15000, () => { r.destroy(); resolve({ error: 'timeout' }); });
    if (data) r.write(data);
    r.end();
  });
}

const TOOLS = [
  {
    name: 'claim_verdict',
    description: 'Submits a claim and returns a signed verdict: settled against real external ground truth (GitHub PR, on-chain tx, HTTP status, JSON field, Kalshi market, or multi-exchange price consensus), Ed25519-signed, hash-chained. Free tier — no account, no card. Returns CONFIRMED, REFUTED, or ERROR — never a forced guess.',
    inputSchema: {
      type: 'object',
      properties: {
        agent: { type: 'string', description: 'who is asking (shown on the public reputation ledger)' },
        claim: { type: 'string', description: 'the claim in plain language, e.g. "PR #42 on owner/repo is merged"' },
        resolver: {
          type: 'object',
          description: 'which external source resolves this claim',
          properties: {
            type: { type: 'string', enum: ['github_pr', 'onchain_tx', 'url_json', 'http_status', 'kalshi_market'] },
          },
          required: ['type'],
        },
      },
      required: ['agent', 'claim', 'resolver'],
    },
  },
  {
    name: 'verify_receipt',
    description: 'Independently verifies any StillOS notary receipt by its hash: confirms the hash chain is intact and the Ed25519 signature is valid. Read-only, free, no auth.',
    inputSchema: {
      type: 'object',
      properties: { hash: { type: 'string', description: 'the receipt_hash returned by claim_verdict or commit' } },
      required: ['hash'],
    },
  },
  {
    name: 'file_dispute',
    description: 'Files a bonded dispute against a verdict receipt: the disputed verdict is re-resolved immediately against the identical resolver specification that produced it — independent re-run, not a re-vote. An upheld dispute overturns the verdict and queues a slashable payout against the notary\'s on-chain correctness bond. Paid: $1.00 USDC (Base) via x402 — no free tier. A call without an attached x402 payment returns the payment requirement (price, payTo, asset), not a verdict.',
    inputSchema: {
      type: 'object',
      properties: {
        agent: { type: 'string', description: 'who is filing the dispute (shown on the public reputation ledger)' },
        receipt_hash: { type: 'string', description: 'the receipt_hash of the verdict being disputed — must be under 48 hours old' },
      },
      required: ['agent', 'receipt_hash'],
    },
  },
  {
    name: 'screen_entity',
    description: 'OFAC SDN sanctions name screen: matches a legal name against the OFAC Specially Designated Nationals list, with a source_as_of freshness timestamp, Ed25519-signed. Free up to 5/agent/day, then $0.001 USDC (Base) via x402. Once the free tier is used up, a call without an attached x402 payment returns the payment requirement, not a verdict.',
    inputSchema: {
      type: 'object',
      properties: {
        agent: { type: 'string', description: 'who is asking (shown on the public reputation ledger)' },
        entity: { type: 'string', description: 'legal name to screen against the OFAC SDN list' },
      },
      required: ['agent', 'entity'],
    },
  },
  {
    name: 'distress_score',
    description: 'Balance-sheet corporate distress ranker for a single equity ticker: Altman Z-score computed from live SEC XBRL filings, held-out AUC 0.769 (178 real Chapter 11 filings vs 71 date-matched controls), Ed25519-signed. Free up to 3/agent/day, then $0.15 USDC (Base) via x402. Once the free tier is used up, a call without an attached x402 payment returns the payment requirement, not a verdict.',
    inputSchema: {
      type: 'object',
      properties: {
        agent: { type: 'string', description: 'who is asking (shown on the public reputation ledger)' },
        ticker: { type: 'string', description: 'equity ticker to score, e.g. "AAPL"' },
      },
      required: ['agent', 'ticker'],
    },
  },
];

async function callTool(name, args, opts = {}) {
  if (name === 'claim_verdict') {
    const { agent, claim, resolver } = args;
    if (!agent || !claim || !resolver || !resolver.type) throw new Error('agent, claim, and resolver.type are required');
    const r = await req('POST', '/claim-verdict', { agent, claim, resolver });
    if (r.error) return { ok: false, error: r.error };
    return { ok: true, status: r.status, ...r.body };
  }
  if (name === 'verify_receipt') {
    const { hash } = args;
    if (!hash) throw new Error('hash is required');
    const r = await req('GET', `/verify?hash=${encodeURIComponent(hash)}`);
    if (r.error) return { ok: false, error: r.error };
    return { ok: true, status: r.status, ...r.body };
  }
  if (name === 'file_dispute') {
    const { agent, receipt_hash } = args;
    if (!agent || !receipt_hash) throw new Error('agent and receipt_hash are required');
    return paidCall('/dispute', { agent, receipt_hash }, opts);
  }
  if (name === 'screen_entity') {
    const { agent, entity } = args;
    if (!agent || !entity) throw new Error('agent and entity are required');
    return paidCall('/screen-entity', { agent, entity }, opts);
  }
  if (name === 'distress_score') {
    const { agent, ticker } = args;
    if (!agent || !ticker) throw new Error('agent and ticker are required');
    return paidCall('/distress-score', { agent, ticker }, opts);
  }
  throw new Error(`unknown tool: ${name}`);
}

module.exports = { TOOLS, callTool, paidCall, paymentCapability, CODES };
