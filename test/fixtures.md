# Live fixtures

On-chain state used to manually verify `checkMembership` against a real RPC,
outside of the mocked unit tests in `src/tools/checkMembership.test.ts`.

## Base: expired/valid boundary key

Network: `base`
Lock: `0x24fa20fd4c6c497c4b27d830a7343736df6b1d66`
Wallet: `0xDEAcDe6eC27Fd0cD972c1232C4f0d4171dda2357`
Token ID: `1`

The key expires at **2026-08-29T22:10:00Z**, with no re-mint on either side of
that boundary — same tokenId, same `totalKeys` count, before and after. That
makes this one fixture cover both statuses across the day boundary:

- Before 2026-08-29T22:10:00Z: `valid`
- At/after 2026-08-29T22:10:00Z: `expired`

This is also the regression fixture for the `balanceOf`-on-v10+ bug: on this
lock version, `balanceOf` drops to 0 once the key expires, which is exactly
what made an expired key indistinguishable from `no_key` before the fix (see
`resolveMembershipStatus` in `src/tools/checkMembership.ts`, and the
`totalKeys`-based regression tests in `src/tools/checkMembership.test.ts`).
Querying after the boundary should report `status: "expired"` with this same
tokenId, not `no_key`.
