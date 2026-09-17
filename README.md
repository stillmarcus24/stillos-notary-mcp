# stillos-notary-mcp

Verification infrastructure for the agentic economy. An agent submits a claim;
the notary returns an Ed25519-signed, hash-chained verdict, settled against
real external ground truth, not model output. Free tier, no account, no card.

Every tool call in this package settles against the live public notary over
HTTPS (`stillosdigitalholdings.com/notary`). No local or internal-only code path
exists — behavior is identical regardless of runtime.

## Install

```
npx stillos-notary-mcp mcp
```

Or add to an MCP client config:

```json
{
  "mcpServers": {
    "stillos-notary": { "command": "npx", "args": ["-y", "stillos-notary-mcp", "mcp"] }
  }
}
```

## Tools

### `claim_verdict`

Submits a claim and a resolver specification. Returns CONFIRMED, REFUTED, or
ERROR — never a forced guess — signed and hash-chained.

Supported resolver types: `github_pr`, `onchain_tx`, `url_json`, `http_status`,
`kalshi_market`.

```
stillos-notary-mcp claim "your-agent" "example.com returns 200" \
  '{"type":"http_status","url":"https://example.com","expect_code":200}'
```

### `verify_receipt`

Independently verifies any receipt by hash: confirms the hash chain is intact
and the signature is valid.

```
stillos-notary-mcp verify <receipt_hash>
```

### `file_dispute`

Files a bonded dispute against a verdict receipt. The disputed verdict is
re-resolved immediately, against the identical resolver specification that
produced it — independent re-run, not a re-vote, not a human appeal queue. An
upheld dispute overturns the verdict and queues a slashable payout against the
notary's on-chain correctness bond ($10 USDC, Base). Dispute window: 48 hours
from the original receipt's timestamp.

## Paying for a paid tool (1.3.0)

Through 1.2.2 this package could only *report* the paywall: every paid tool returned
`{ payment_required: true }` and the call ended there. There was no way, anywhere in the
package, to attach a payment and retry — the CLI told you to "attach payment and retry"
using a mechanism that did not exist. 1.3.0 implements it.

Supply a credential and the 402 is crossed automatically — one 402, one payment, one
retry, then the paid result:

```js
const { callTool } = require('stillos-notary-mcp');

// 1. Preferred: your own payment-capable fetch. We never see a key.
const r = await callTool('screen_entity', { agent: 'me', entity: 'Acme Corp' },
                         { fetch: myX402Fetch });

// 2. Or a viem account / signer object.
await callTool('screen_entity', args, { account: myViemAccount });

// 3. Or, as a documented fallback, a raw key in the environment.
//    export STILLOS_NOTARY_WALLET_KEY=0x...
await callTool('screen_entity', args);
```

With no credential you get an actionable requirement rather than a dead end:

```json
{
  "ok": false, "paid": false, "code": "PAYMENT_REQUIRED",
  "payment": { "amount_usd": 0.001, "network": "base", "pay_to": "0x…", "scheme": "exact" },
  "remediation": "Pass a payment-capable fetch as opts.fetch, a viem account as opts.account, or set STILLOS_NOTARY_WALLET_KEY, then call again."
}
```

**What it refuses to pay.** A 402 is untrusted input. The client will not sign for a
network or scheme it does not expect (`base` / `exact` only), will not pay a malformed
requirement missing `payTo` or an amount, and will not exceed a per-call ceiling
(`$1.50` default, `STILLOS_NOTARY_MAX_USD` or `opts.maxUsd` to change). It never retries
more than once — a second 402 is a hard stop, not a backoff loop, so a rejected payment
can never be re-signed into a double spend. Supplying no credential never spends
anything. No key is received, logged, persisted, or placed in an error message.

Covered by `test/payment-continuation.test.cjs` (17 cases, local mocks, no real
settlement).

**Paid: $1.00 USDC (Base) via x402 — no free tier.** A call without an
attached x402 payment returns the payment requirement (price, `payTo`, asset),
not a verdict. This package holds no wallet and executes no payment itself;
the calling agent's own client bears that capability.

```
stillos-notary-mcp dispute "your-agent" <receipt_hash>
```

### `screen_entity`

OFAC SDN sanctions name screen, with a `source_as_of` freshness timestamp,
Ed25519-signed.

**Free up to 5/agent/day, then $0.001 USDC (Base) via x402.**

```
stillos-notary-mcp screen "your-agent" "Acme Corp"
```

### `distress_score`

Balance-sheet corporate distress ranker for a single equity ticker:
Altman Z-score from live SEC XBRL filings, held-out AUC 0.769 on 178 real Chapter 11 filings vs 71
date-matched controls. ~3% precision at a 2% base rate: a ranking input for
ordering a review queue, NOT an alarm on a single name. The prior
"71% sensitivity / 100% specificity" claim (n=14) is withdrawn. Ed25519-signed.

**Free up to 3/agent/day, then $0.15 USDC (Base) via x402.**

```
stillos-notary-mcp distress "your-agent" AAPL
```

## Why

Most verification is one model checking another model's output — the same
failure mode, with no independence introduced. This architecture settles
every claim against a source neither counterparty controls, signs the outcome
regardless of direction, and publishes confirmed and refuted verdicts to the
same ledger. Fail-closed: an unresolvable claim returns ERROR, never a
plausible-sounding guess.

Live docs: https://stillosdigitalholdings.com/notary/docs
