// Minimal PublicLock ABI — only the functions the read tools call.
// Cross-checked against @unlock-protocol/contracts (V9 through V15): these functions
// and their signatures are stable across that range, with one exception handled
// explicitly in src/tools/checkMembership.ts — keyExpirationTimestampFor took a
// key owner address up through V9, and a tokenId from V10 onward. Both overloads
// are declared below.
//
// totalKeys(address), not balanceOf(address), is used to size key enumeration: on
// v10+ locks balanceOf counts only currently-valid keys, making an expired key
// indistinguishable from no key at all. totalKeys counts every key ever minted to
// the owner, and tokenOfOwnerByIndex is bounded by totalKeys rather than balanceOf,
// so it still enumerates expired keys.
//
// symbol/keyPrice/tokenAddress/expirationDuration/maxNumberOfKeys/totalSupply are
// used by unlock_get_lock; also verified stable V9-V15 against the same source.
// totalSupply() returns the contract's `_totalKeysCreated` counter (its output name
// per the ABI), a running total that never decrements — i.e. total keys sold, not
// current valid supply.
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
    name: "totalKeys",
    stateMutability: "view",
    inputs: [{ name: "_keyOwner", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
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
  {
    // The contract's own valid/expired verdict for a wallet — used instead of comparing
    // keyExpirationTimestampFor to the local clock. Not present on very old locks;
    // callers must handle the revert and fall back to the local comparison.
    type: "function",
    name: "getHasValidKey",
    stateMutability: "view",
    inputs: [{ name: "_keyOwner", type: "address" }],
    outputs: [{ name: "", type: "bool" }],
  },
  {
    type: "function",
    name: "isValidKey",
    stateMutability: "view",
    inputs: [{ name: "_tokenId", type: "uint256" }],
    outputs: [{ name: "", type: "bool" }],
  },
  {
    type: "function",
    name: "symbol",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "string" }],
  },
  {
    type: "function",
    name: "keyPrice",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "tokenAddress",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "address" }],
  },
  {
    type: "function",
    name: "expirationDuration",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "maxNumberOfKeys",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "totalSupply",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "_totalKeysCreated", type: "uint256" }],
  },
] as const;
