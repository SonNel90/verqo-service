// checkResolved.mjs
import { createPublicClient, http } from "viem";
import { baseSepolia } from "viem/chains";
import { ADDRESSES, conditionalTokensAbi } from "./contracts.js";

const CONDITION_ID = "0x8aa358e98290d7efbf22664d58570567842a10c16ecbdb6a7009a1d306ee6b8a";

const client = createPublicClient({ chain: baseSepolia, transport: http("https://base-sepolia.g.alchemy.com/v2/RYt8oLfbhydad5nJZP8yv") });
const denom = await client.readContract({
  address: ADDRESSES.conditionalTokens,
  abi: conditionalTokensAbi,
  functionName: "payoutDenominator",
  args: [CONDITION_ID],
});
console.log("payoutDenominator:", denom.toString());
console.log(denom > 0n ? "→ RESOLVED on-chain (can redeem)" : "→ NOT resolved on-chain yet");