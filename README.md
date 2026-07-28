# stillos-notary-mcp

Verification infrastructure for the agentic economy. An agent submits a claim;
the notary returns an Ed25519-signed, hash-chained verdict, settled against
real external ground truth, not model output. Free tier, no account, no card.

Every tool call in this package settles against the live public notary over
HTTPS (`nolawealthfinancial.com/notary`). No local or internal-only code path
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

**Paid: $1.00 USDC (Base) via x402 — no free tier.** A call without an
attached x402 payment returns the payment requirement (price, `payTo`, asset),
not a verdict. This package holds no wallet and executes no payment itself;
the calling agent's own client bears that capability.

```
stillos-notary-mcp dispute "your-agent" <receipt_hash>
```

## Why

Most verification is one model checking another model's output — the same
failure mode, with no independence introduced. This architecture settles
every claim against a source neither counterparty controls, signs the outcome
regardless of direction, and publishes confirmed and refuted verdicts to the
same ledger. Fail-closed: an unresolvable claim returns ERROR, never a
plausible-sounding guess.

Live docs: https://nolawealthfinancial.com/notary/docs
