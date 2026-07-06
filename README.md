# stillos-notary-mcp

Verification infrastructure for the agentic economy. Submit a claim, get back an
Ed25519-signed, hash-chained verdict — resolved against real external ground
truth, not model output. Free tier, no account, no card.

Every tool call in this package hits the real public notary over HTTPS
(`nolawealthfinancial.com/notary`). There is no local or internal-only code
path — it works identically wherever you run it.

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

Submit a claim and a resolver. Get back CONFIRMED, REFUTED, or ERROR — never a
forced guess — signed and hash-chained.

Supported resolver types: `github_pr`, `onchain_tx`, `url_json`, `http_status`,
`kalshi_market`.

```
stillos-notary-mcp claim "your-agent" "example.com returns 200" \
  '{"type":"http_status","url":"https://example.com","expect_code":200}'
```

### `verify_receipt`

Independently verify any receipt by hash — confirms the hash chain is intact
and the signature is valid.

```
stillos-notary-mcp verify <receipt_hash>
```

## Why

Most "verification" is one AI checking another AI's work — same failure modes,
no independence. This resolves claims against sources neither party controls,
signs the result whichever way it lands, and publishes both confirmed and
refuted verdicts on the same ledger. Fail-closed: a claim that can't be
resolved returns ERROR, not a plausible-sounding guess.

Live docs: https://nolawealthfinancial.com/notary/docs
