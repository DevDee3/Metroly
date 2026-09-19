# Metroly — group spend & settlement on Monad

A shared ledger for groups: log expenses, and settle up with the fewest
possible onchain transfers — no IOUs, no seed phrase, no visible gas.

Built for **Monad Metropolis** (Consumer Products & Payments track).

## Structure

```
contracts/   Foundry project — GroupVault.sol + SettlementLib.sol + tests
frontend/    Next.js app — Privy passkey + wallet auth (WalletConnect for mobile), wagmi/viem, transit-map UI
```

## Contracts

- **`GroupVault.sol`** — one contract, many groups (mapping-keyed, not a
  factory-per-group) so creating a group is cheap. Members deposit MON into
  their own balance inside a group, expenses are logged as a running net
  ledger, and `settle()` computes + executes the minimal set of transfers to
  zero every balance out.
- **`SettlementLib.sol`** — the debt-simplification (min cash flow) algorithm,
  as a standalone pure library, unit- and fuzz-tested independently.

### Verified locally in this environment

```
forge build     # compiles clean, evm_version = "prague"
forge test       # 27/27 passing — unit, integration, and a reentrancy-attack test
```

The reentrancy test (`test/Reentrancy.t.sol`) actually deploys a malicious
contract that tries to re-enter `withdraw()` from its `receive()` and proves
the `ReentrancyGuard` blocks it — not just that the import is present.

### Deploying to Monad Testnet

```
cd contracts
cast wallet import deployer --interactive   # one-time: import your key into a keystore
forge script script/Deploy.s.sol --rpc-url monad_testnet --account deployer --broadcast
```

Copy the deployed address into `frontend/.env.local` as
`NEXT_PUBLIC_GROUP_VAULT_ADDRESS`. This step needs your own funded testnet
wallet — deliberately not done for you, since no sandbox should ever hold a
private key that can move real funds.

## Frontend

- Next.js 16 (App Router) + TypeScript + Tailwind v4
- **Privy** for auth — passkey + email login give a first-time user a wallet
  with no seed phrase; **"wallet"** login is also enabled with a mobile-safe
  WalletConnect config (`wallet_connect`, not the desktop-only
  `wallet_connect_qr`) so someone who already has a wallet on their phone can
  connect it directly, not just extension users (targets the Privy bounty)
- wagmi + viem wired to Monad Testnet (chain id `10143`) — wagmi is the hooks
  layer, not a competing wallet standard; WalletConnect plugs into it as one
  of several connectors, which is exactly what's configured here
- Transit-map design system (fits "Metropolis"): a night-map background,
  Space Grotesk for display type, JetBrains Mono for amounts/addresses, and
  each group member gets a stable "line color" the way a subway map assigns
  a color per route — the one deliberately bold visual element against an
  otherwise quiet dark UI. Balances still use directional color (red for what
  you owe, green for what you're owed) but on the dark palette instead of a
  paper-ledger look.

### Setup

```
cd frontend
cp .env.example .env.local
# fill in NEXT_PUBLIC_PRIVY_APP_ID (create an app at https://dashboard.privy.io)
# fill in NEXT_PUBLIC_GROUP_VAULT_ADDRESS after deploying the contract
npm install
npm run dev
```

Running `npm run dev` (or `npm run build`) before filling in
`NEXT_PUBLIC_PRIVY_APP_ID` no longer crashes — it shows a plain "Metroly
isn't configured yet" screen with setup instructions instead of a 500 error.
(It used to hard-crash here; `PrivyProvider` throws synchronously on an empty
app ID, so `Providers` now checks for that up front and only mounts
`PrivyProvider`/`WagmiProvider` once a real ID is present.)

### Verified locally in this environment

```
npm install      # 0 vulnerabilities on the base Next.js install
npm run lint     # 0 errors
npm run build    # production build succeeds — with NO Privy app ID set —
                  #   / prerenders static, /group/[id] is dynamic
npx tsc --noEmit # typechecks clean
npm run dev      # actually curled: confirms HTTP 200 + the fallback screen
                  #   (was HTTP 500 before the Providers fix above)
```

One caveat on the build step: this sandbox cannot reach
`fonts.googleapis.com`, so the production build here was verified once with a
temporary system-font stub swapped in for `next/font/google`, then the real
Space Grotesk / JetBrains Mono imports were restored afterward and
type-checked (but the font *fetch* itself couldn't be re-verified from this
environment). It should build normally in a normal network environment or on
Vercel; if it doesn't, it's almost certainly that font fetch and the fix is
switching to `next/font/local` with self-hosted font files.

## Known limitations / next steps

- **No indexer yet.** "Which groups am I in" is tracked client-side in
  `localStorage` (see `src/lib/useKnownGroups.ts`) rather than from an onchain
  event index. A group is only discoverable on a device that created it or
  was given its link. The planned upgrade is **Envio HyperIndex** (also a
  sponsor bounty) for a real "your groups" feed from onchain events.
- **Mera passkey integration not done.** Currently using Privy's embedded
  wallets (ERC-4337 + passkey signer) rather than Monad's native `mera`
  precompile-based passkey primitive. Worth adding later if time allows — it
  targets two additional Monad Foundation bounties.
- **No paymaster/gas sponsorship configured yet.** Privy supports it, but it
  needs a funded paymaster policy set up in the Privy dashboard — a
  post-deploy step, not a code change.
- **MAX_MEMBERS = 20** per group, to bound gas on the O(n²) validation loops
  and the settlement algorithm. Fine for the target use case (trips,
  apartments, friend groups); would need revisiting for larger groups.
