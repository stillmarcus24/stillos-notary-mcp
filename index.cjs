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
    description: 'Submit a claim and get a signed verdict: resolved against real external ground truth (GitHub PR, on-chain tx, HTTP status, JSON field, Kalshi market, or multi-exchange price consensus), Ed25519-signed, hash-chained. Free tier — no account, no card. Returns CONFIRMED, REFUTED, or ERROR (never a forced guess).',
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
    description: 'Independently verify any StillOS notary receipt by its hash: confirms the hash chain is intact and the Ed25519 signature is valid. Read-only, free, no auth.',
    inputSchema: {
      type: 'object',
      properties: { hash: { type: 'string', description: 'the receipt_hash returned by claim_verdict or commit' } },
      required: ['hash'],
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
  throw new Error(`unknown tool: ${name}`);
}

module.exports = { TOOLS, callTool };
