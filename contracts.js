// Verqo contract addresses — Base Sepolia
export const ADDRESSES = {
  conditionalTokens: "0x5C2D0D3c00D7B7aBe6c7A49eCD591A90267Df873",
  mockUsdc:          "0x11823625872d0bc121e59A820be7A84858c9539c",
  lmsrFactory:       "0xd92FCCB9C31AbE35020420f5A2F85B98DEaB3Ba4",
};

export const CHAIN_ID = 84532;

// LMSRMarketMakerFactory ABI — only what we need
export const factoryAbi = [
  {
    name: "createLMSRMarketMaker",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "pmSystem",       type: "address" },
      { name: "collateralToken",type: "address" },
      { name: "conditionIds",   type: "bytes32[]" },
      { name: "fee",            type: "uint64" },
      { name: "whitelist",      type: "address" },
      { name: "funding",        type: "uint256" },
    ],
    outputs: [{ name: "", type: "address" }],
  },
];

export const conditionalTokensAbi = [
  {
    name: "prepareCondition",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "oracle",           type: "address" },
      { name: "questionId",       type: "bytes32" },
      { name: "outcomeSlotCount", type: "uint256" },
    ],
    outputs: [],
  },
  {
    name: "getConditionId",
    type: "function",
    stateMutability: "pure",
    inputs: [
      { name: "oracle",           type: "address" },
      { name: "questionId",       type: "bytes32" },
      { name: "outcomeSlotCount", type: "uint256" },
    ],
    outputs: [{ type: "bytes32" }],
  },
  {
    name: "reportPayouts",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "questionId", type: "bytes32" },
      { name: "payouts",    type: "uint256[]" },
    ],
    outputs: [],
  },
  {
    name: "payoutDenominator",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "conditionId", type: "bytes32" }],
    outputs: [{ type: "uint256" }],
  },
];

export const mockUsdcAbi = [
  {
    name: "mint",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "to",     type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [],
  },
  {
    name: "approve",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "spender", type: "address" },
      { name: "amount",  type: "uint256" },
    ],
    outputs: [{ type: "bool" }],
  },
  {
    name: "allowance",
    type: "function",
    stateMutability: "view",
    inputs: [
      { name: "owner",   type: "address" },
      { name: "spender", type: "address" },
    ],
    outputs: [{ type: "uint256" }],
  },
];

// 2% fee in uint64 (fee / 2^64 = percentage). 2% = 0.02 * 2^64
export const FEE_2PCT = 369462483793n; // ~2% in LMSR fee units

// Initial funding per market in USDC base units (6 decimals)
// 100 USDC = 100_000_000
export const INITIAL_FUNDING = 100_000_000n;