'use strict';
/*
 * stillos-notary-mcp — pure logic, no stdio/process side effects.
 * Every call hits the real public notary over HTTPS (nolawealthfinancial.com) --
 * no local/internal-only code path, so this works identically wherever it runs.
 */
const https = require('https');
const http = require('http');
const { URL } = require('url');

const NOTARY = (process.env.STILLOS_NOTARY || 'https://nolawealthfinancial.com/notary').replace(/\/+$/, '');

function req(method, path, body) {
  return new Promise((resolve) => {
    let u; try { u = new URL(NOTARY + path); } catch { return resolve({ error: 'bad notary URL' }); }
    const lib = u.protocol === 'http:' ? http : https;
    const data = body ? JSON.stringify(body) : null;
    const headers = { accept: 'application/json' };
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
    description: 'OFAC SDN sanctions name screen: matches a legal name against the OFAC Specially Designated Nationals list, with a source_as_of freshness timestamp, Ed25519-signed. Paid: $0.001 USDC (Base) via x402 — no free tier. A call without an attached x402 payment returns the payment requirement, not a verdict.',
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
    description: 'Validated corporate distress-foresight score for a single equity ticker: Altman Z-score computed from live SEC XBRL filings, backtested 71% sensitivity / 100% specificity with a ~109-day median lead time, Ed25519-signed. Paid: $0.15 USDC (Base) via x402 — no free tier. A call without an attached x402 payment returns the payment requirement, not a verdict.',
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

async function callTool(name, args) {
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
    const r = await req('POST', '/dispute', { agent, receipt_hash });
    if (r.error) return { ok: false, error: r.error };
    if (r.status === 402) return { ok: false, payment_required: true, ...r.body };
    return { ok: true, status: r.status, ...r.body };
  }
  if (name === 'screen_entity') {
    const { agent, entity } = args;
    if (!agent || !entity) throw new Error('agent and entity are required');
    const r = await req('POST', '/screen-entity', { agent, entity });
    if (r.error) return { ok: false, error: r.error };
    if (r.status === 402) return { ok: false, payment_required: true, ...r.body };
    return { ok: true, status: r.status, ...r.body };
  }
  if (name === 'distress_score') {
    const { agent, ticker } = args;
    if (!agent || !ticker) throw new Error('agent and ticker are required');
    const r = await req('POST', '/distress-score', { agent, ticker });
    if (r.error) return { ok: false, error: r.error };
    if (r.status === 402) return { ok: false, payment_required: true, ...r.body };
    return { ok: true, status: r.status, ...r.body };
  }
  throw new Error(`unknown tool: ${name}`);
}

module.exports = { TOOLS, callTool };
