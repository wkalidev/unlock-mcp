# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
