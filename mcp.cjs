'use strict';
/*
 * MCP stdio server for stillos-notary-mcp. Newline-delimited JSON-RPC 2.0.
 * Zero external deps. All stdio wiring lives here, not in index.cjs, so
 * requiring index.cjs (e.g. from bin.cjs's CLI mode) never has the side
 * effect of attaching stdin listeners.
 */
const { TOOLS, callTool } = require('./index.cjs');

const SERVER = { name: 'stillos-notary-mcp', version: '1.1.0' };
const PROTOCOL = '2024-11-05';

function write(obj) { process.stdout.write(JSON.stringify(obj) + '\n'); }
function reply(id, result) { write({ jsonrpc: '2.0', id, result }); }
function replyError(id, code, message) { write({ jsonrpc: '2.0', id, error: { code, message } }); }

async function handle(msg) {
  const { id, method, params } = msg;
  if (method === 'initialize') return reply(id, { protocolVersion: PROTOCOL, capabilities: { tools: {} }, serverInfo: SERVER });
  if (method === 'notifications/initialized' || method === 'initialized') return;
  if (method === 'tools/list') return reply(id, { tools: TOOLS });
  if (method === 'ping') return reply(id, {});
  if (method === 'tools/call') {
    try {
      const out = await callTool(params.name, params.arguments || {});
      return reply(id, { content: [{ type: 'text', text: JSON.stringify(out, null, 2) }] });
    } catch (e) { return replyError(id, -32000, e.message); }
  }
  if (id !== undefined) return replyError(id, -32601, `method not found: ${method}`);
}

let buf = '', inflight = 0, ended = false;
function track(p) { inflight++; Promise.resolve(p).finally(() => { inflight--; if (ended && inflight === 0) process.exit(0); }); }
process.stdin.on('data', (chunk) => {
  buf += chunk.toString();
  let nl;
  while ((nl = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
    if (line) { try { track(handle(JSON.parse(line))); } catch { /* ignore malformed */ } }
  }
});
process.stdin.on('end', () => { ended = true; if (inflight === 0) process.exit(0); });
