# Verqo Oracle Service

Deploys on-chain markets for new battles and auto-resolves them when they end.

## Setup

### 1. Add columns to Supabase

Go to Supabase → SQL Editor → run this:

```sql
ALTER TABLE battles ADD COLUMN IF NOT EXISTS market_address text;
ALTER TABLE battles ADD COLUMN IF NOT EXISTS condition_id text;
```

### 2. Install dependencies

```bash
cd verqo-oracle
npm install
```

### 3. Create your .env file

Copy `.env.example` to `.env` and fill in:

```bash
cp .env.example .env
```

Then edit `.env`:
- `DEPLOYER_PRIVATE_KEY` — your deployer wallet private key (from verqo-contracts/.env)
- `SUPABASE_URL` — your Supabase project URL
- `SUPABASE_SERVICE_KEY` — your Supabase service_role key (regenerate if exposed)

### 4. Deploy markets for existing battles

```bash
node deployMarkets.js
```

This finds all LIVE/UPCOMING battles with no market_address and deploys one each.

### 5. Resolve ended battles

```bash
node resolveMarkets.js
```

This finds all battles where ends_at has passed and calls reportPayouts on-chain.

### 6. Run both continuously (watch mode)

Open two terminal tabs:

```bash
node deployMarkets.js --watch
node resolveMarkets.js --watch
```

Each polls every 60 seconds. New battle created in Supabase → gets a market within 60s.
Battle ends → gets resolved within 60s.

## How it works

### Deploy flow
1. Reads battles from Supabase where market_address IS NULL
2. For each: prepareCondition → mint USDC → approve → createLMSRMarketMaker
3. Writes market_address + condition_id back to Supabase

### Resolve flow
1. Reads battles where ends_at < now AND winner IS NULL
2. Compares score_a vs score_b to determine winner
3. Calls reportPayouts([1,0] or [0,1]) on ConditionalTokens
4. Updates Supabase: winner, status=SETTLED, resolution_tx, settled_at

## Cost per market (testnet)
- 3 transactions: prepareCondition + approve + createLMSRMarketMaker
- ~100 USDC funding (minted free on testnet)
- ~$0.01 in Base Sepolia ETH for gas