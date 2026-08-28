// Minimal PublicLock ABI — only the functions this milestone calls.
// Cross-checked against @unlock-protocol/contracts (V9 through V15): these functions
// and their signatures are stable across that range, with one exception handled
// explicitly in src/tools/checkMembership.ts — keyExpirationTimestampFor took a
// key owner address up through V9, and a tokenId from V10 onward. Both overloads
// are declared below.
export const publicLockAbi = [
  {
    type: "function",
    name: "publicLockVersion",
    stateMutability: "pure",
    inputs: [],
    outputs: [{ name: "", type: "uint16" }],
  },
  {
    type: "function",
    name: "name",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "string" }],
  },
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ name: "_keyOwner", type: "address" }],
    outputs: [{ name: "balance", type: "uint256" }],
  },
  {
    type: "function",
    name: "tokenOfOwnerByIndex",
    stateMutability: "view",
    inputs: [
      { name: "_keyOwner", type: "address" },
      { name: "_index", type: "uint256" },
    ],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "keyExpirationTimestampFor",
    stateMutability: "view",
    inputs: [{ name: "_tokenId", type: "uint256" }],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "keyExpirationTimestampFor",
    stateMutability: "view",
    inputs: [{ name: "_keyOwner", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
] as const;
