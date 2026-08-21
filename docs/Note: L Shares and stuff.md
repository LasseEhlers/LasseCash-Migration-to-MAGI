Note: L Shares and stuff1. Top-10 Staker Consensus Group

- Spec: The 10 accounts holding the highest number of active L-Shares automatically form the consensus group for dynamic protocol parameters.
- On-Chain Status: Missing. The node does not yet dynamically compute or enforce a top-10 staker privilege list for governance.

### 2. Actual Yield Distribution Payouts (25% Inflation Pool Slice)

- Spec: End-of-stake payout formula: User Reward = Pool Rewards Accrued * (User's L-Shares / Total Network L-Shares).
- On-Chain Status: Partial / Lagging. We route penalties back into the reward pool, but the node doesn't yet calculate and distribute the accrued reward pool share to the user upon a mature unstake.

### 3. Automatic Annual Share Rate Ratchet (+7% Per Annum)

- Spec: The shareRate goes up forever by 7% per annum.
- On-Chain Status: Missing. The function applyAnnualRatchet() exists in the engine, but it is not hooked into the server's block tick loop to compound automatically over time.

### 4. Good Accounting Mode (Tax Deferral)

- Spec: Users can toggle "Good Accounting Mode" on individual stakes so that when they hit maturity, they stop earning yield but stay locked in an unclaimed state to delay tax realization.
- On-Chain Status: Missing. No toggle or state handler exists for this on-chain yet.

### 5. Post-Maturity Expiry & 4-Month Bleed Mechanic

- Spec:
  - Month 1: Grace period (safe, stops earning).
  - Months 2-3-4: Linear bleed phase where a microscopic fraction is shaved off every block.
  - Day 120: Total liquidation, 100% swept to the reward pool.
- On-Chain Status: Missing. Currently, matured stakes sit indefinitely without bleeding or liquidating.
