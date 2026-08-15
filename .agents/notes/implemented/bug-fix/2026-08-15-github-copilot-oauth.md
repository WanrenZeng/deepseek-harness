# Agent Note: GitHub Copilot OAuth login in pi-ai adapter and Models UI

Status: implemented

English | [中文](2026-08-15-github-copilot-oauth.zh.md)

## Problem

PR #1 merged a partial OAuth implementation and left compile breaks, missing client exports, incomplete fixture support, and unvalidated login/session behavior.

The Models UI could not compile (`signInOAuth`/`signOutOAuth` scope), prompt polling could answer the same prompt repeatedly, and no cancel action existed during pending login.

The adapter and proxy layers also needed explicit handling for durable credential storage semantics, structured provider-auth errors, and privileged RPC coverage.

## Decision

Wire provider-auth end to end for the existing `github-copilot` scope only.

The browser/client export chain now publishes provider-auth public types, the fixture implements provider-auth methods and dispatch entries, and `ProviderEditor` handles OAuth sign-in/sign-out/cancel plus safe URL rendering and prompt answer de-duplication.

The pi-ai credential store now validates stored OAuth/API-key payload shape before use and keeps modify semantics aligned with pi-ai (`modify` callback returning `undefined` means "no change").

Adapter login sessions now settle and prune completed/cancelled/failed entries, and prompt waits are rejected on settle to avoid indefinite retention.

## Alternatives considered

Keep the previous API-key-only posture and continue withholding all OAuth support; this was rejected because `github-copilot` needed a working first-party login flow in the Models surface.

Make every OAuth-capable provider serviceable; this was rejected because only `github-copilot` has the implemented storage/login handling in this build, while `openai-codex` still lacks a serviceable interactive flow.

## Security boundary

OAuth snapshots and status remain redacted: no token fields are exposed through UI state, host RPC payloads, fixture data, or error mapping.

Provider-auth endpoints stay loopback-privileged, and proxy error mapping now returns stable structured provider-auth codes (`provider-auth-unsupported`, `provider-auth-login-unknown`, `provider-auth-prompt-unknown`, `provider-auth-cancelled`, `provider-auth-expired`, `provider-auth-provider-failed`).

The serviceable OAuth directory posture remains explicit: only `github-copilot` is serviceable for OAuth in this build, and OAuth-only `openai-codex` remains withheld from add-provider surfaces.

## Consequences

GitHub Copilot now supports interactive OAuth login/logout in the Models page while keeping API-key configuration available.

Prompt events are answered at most once per prompt id, optional GitHub default prompts can be auto-answered with blank input, and required prompts are answered through explicit UI input.

Stored tokens refresh durably through the harness credential seam and remain reusable across recreated immutable model snapshots.

## Testing

Added and updated targeted tests across store, adapter, proxy, fixture, and UI layers: `packages/llm/llm-pi-ai/tests/oauth-store.spec.ts`, `packages/llm/llm-pi-ai/tests/catalog.spec.ts`, `packages/host/apiproxy/tests/api-proxy-models.spec.ts`, `packages/client/connection/tests/fixture.client.spec.ts`, `packages/client/connection/tests/node-half.host.spec.ts`, and `packages/client/ui-settings-models/tests/provider-form.client.spec.tsx`.

Validation also included repository typecheck and lint.
