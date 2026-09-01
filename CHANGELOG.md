# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.4.0] - 2026-09-01

### Added

- `unlock_check_membership` results now include `verdictSource: "local_clock"` when the
  verdict fell back to comparing `keyExpirationTimestampFor` to the local clock (a lock
  that predates `getHasValidKey`, reached via either a revert or a zero-data return).
  Absent, not `false`, when the contract's own `getHasValidKey` produced the verdict, so
  existing consumers see no change. (#5)
- A new `requireContractVerdict` input, default off, fails `unlock_check_membership`
  with a clear error instead of accepting that local-clock fallback, for callers that
  would rather get no answer than one the lock itself didn't attest to. The fallback
  remains a supported answer by default. (#5)

## [0.3.1] - 2026-08-31

### Fixed

- `classifyError` only distinguished a revert from everything else, so a contract with
  a non-reverting fallback — which answers `0x` rather than reverting — was classified
  as a transport failure. `classifyLock` reported an RPC outage for an address that had
  simply answered, and any address with code and a fallback produced this. Zero data is
  now its own error class, mapped to `not_a_lock`. (#3)
- The `getHasValidKey` fallback added in 0.3.0 was unreachable for locks whose absent
  function returns zero data rather than reverting, for the same reason. (#4)

Both issues reported by revettr_x402.

## [0.3.0] - 2026-08-31

### Fixed

- Membership verdicts now come from the lock's own `getHasValidKey` rather than
  comparing `keyExpirationTimestampFor` to the host's system clock. Two agents on
  different machines could previously return different answers for the same key, and
  neither matched what the lock enforces. (#1)
- The `totalKeys` walk is kept to explain why — `tokenId`, `expiresAt`,
  `expiresRelative` — but no longer decides the verdict. When the contract and the
  local comparison disagree, the divergence is surfaced as `verdictDisagreement` rather
  than silently dropped; absent, not false, when they agree. Falls back to the local
  comparison on locks predating `getHasValidKey`. (#1)
- `resolveBestKey` no longer issues n identical reads on pre-v10 locks, which expose no
  per-tokenId expiration accessor. (#2)

Both issues reported by revettr_x402.

## [0.2.0] - 2026-08-29

Initial three-tool release: `unlock_check_membership`, `unlock_get_lock`, and
`unlock_list_keys`.
