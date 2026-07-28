#!/usr/bin/env node
'use strict';
/*
 * stillos-notary-mcp CLI / MCP entry.
 *   stillos-notary-mcp mcp                      -> run as an MCP stdio server (for agents/clients)
 *   stillos-notary-mcp verify <hash>            -> verify a receipt hash
 *   stillos-notary-mcp claim <agent> <claim> <resolver-json>  -> submit a claim-verdict
 *   stillos-notary-mcp dispute <agent> <receipt-hash>         -> file a bonded dispute ($1.00 x402, no free tier)
 */
const { callTool } = require('./index.cjs');

const args = process.argv.slice(2);

if (args[0] === 'mcp') { require('./mcp.cjs'); return; }

function print(out) { console.log(JSON.stringify(out, null, 2)); }

if (args[0] === 'verify' && args[1]) {
  callTool('verify_receipt', { hash: args[1] }).then(print).catch(e => { console.error(e.message); process.exit(1); });
} else if (args[0] === 'claim' && args[1] && args[2] && args[3]) {
  let resolver; try { resolver = JSON.parse(args[3]); } catch { console.error('resolver must be JSON, e.g. \'{"type":"http_status","url":"...","expect_code":200}\''); process.exit(1); }
  callTool('claim_verdict', { agent: args[1], claim: args[2], resolver }).then(print).catch(e => { console.error(e.message); process.exit(1); });
} else if (args[0] === 'dispute' && args[1] && args[2]) {
  callTool('file_dispute', { agent: args[1], receipt_hash: args[2] }).then((out) => {
    print(out);
    if (out.payment_required) console.log('\nPaid endpoint ($1.00 USDC, Base, x402) — attach payment and retry. No free tier.');
  }).catch(e => { console.error(e.message); process.exit(1); });
} else {
  console.log('stillos-notary-mcp — verification infrastructure for the agentic economy.\n');
  console.log('  stillos-notary-mcp mcp                                        run as MCP server');
  console.log('  stillos-notary-mcp verify <hash>                              verify a receipt');
  console.log('  stillos-notary-mcp claim <agent> <claim> <resolver-json>      submit a claim-verdict');
  console.log('  stillos-notary-mcp dispute <agent> <receipt-hash>             file a bonded dispute ($1.00 x402, no free tier)\n');
  console.log('example resolver: {"type":"http_status","url":"https://example.com","expect_code":200}');
  process.exit(2);
}
