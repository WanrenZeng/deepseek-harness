/**
 * pi-ai OAuth credential storage backed by the Harness credential seam.
 *
 * pi-ai owns token refresh semantics through `CredentialStore.modify()`. This
 * adapter supplies that store over Harness credential references so OAuth
 * access and refresh tokens stay out of settings, UI state, model config, logs,
 * and browser responses.
 *
 * @module dsh-llm-pi-ai/oauth-store
 */

import { credentialRef } from '@deepseek-ai/dsh-credentials'
import type { CredentialProvider, CredentialRef } from '@deepseek-ai/dsh-credentials'
import type { Credential, CredentialInfo, CredentialStore } from '@earendil-works/pi-ai'

/** Prefix for Harness credential references that hold pi-ai OAuth credentials. */
const REF_PREFIX = 'DSH_PI_AI_OAUTH_'

/** Convert a provider route into its host-owned OAuth credential reference. */
export function oauthCredentialRef(provider: string): CredentialRef {
  return credentialRef(`${REF_PREFIX}${provider.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}`)
}

/** Runtime validation for credentials read back from the secret store. */
function parseCredential(provider: string, value: string): Credential | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(value)
  } catch (error) {
    throw new Error(`llm-pi-ai: stored OAuth credential for "${provider}" is not valid JSON`, { cause: error })
  }
  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error(`llm-pi-ai: stored OAuth credential for "${provider}" must be an object`)
  }
  const type = (parsed as { type?: unknown }).type
  if (type !== 'oauth' && type !== 'api_key') {
    throw new Error(`llm-pi-ai: stored OAuth credential for "${provider}" has an unsupported type`)
  }
  return parsed as Credential
}

/** Serialize a pi-ai credential without logging or exposing its fields. */
function serializeCredential(credential: Credential): string {
  return JSON.stringify(credential)
}

/**
 * CredentialStore implementation over the Harness credentials capability.
 * Writes are serialized per provider in this process; the backing provider owns
 * durable file safety and secret redaction.
 */
export class HarnessPiAiCredentialStore implements CredentialStore {
  private readonly chains = new Map<string, Promise<void>>()

  /**
   * @param credentials - host-owned secret store.
   * @param serviceableProviders - OAuth-capable providers this runtime exposes.
   */
  constructor(
    private readonly credentials: CredentialProvider,
    private readonly serviceableProviders: () => readonly string[],
  ) {}

  private enqueue<T>(provider: string, task: () => Promise<T>): Promise<T> {
    const previous = this.chains.get(provider) ?? Promise.resolve()
    const next = (async () => {
      await previous.catch(() => undefined)
      return task()
    })()
    this.chains.set(provider, next.then(() => undefined, () => undefined))
    return next
  }

  async read(providerId: string): Promise<Credential | undefined> {
    const hit = await this.credentials.resolve(oauthCredentialRef(providerId))
    return hit === undefined ? undefined : parseCredential(providerId, hit.value)
  }

  async list(): Promise<readonly CredentialInfo[]> {
    const entries = await Promise.all(this.serviceableProviders().map(async (providerId) => {
      const credential = await this.read(providerId)
      return credential === undefined ? undefined : { providerId, type: credential.type }
    }))
    return entries.filter((entry): entry is CredentialInfo => entry !== undefined)
  }

  modify(providerId: string, fn: (current: Credential | undefined) => Promise<Credential | undefined>): Promise<Credential | undefined> {
    return this.enqueue(providerId, async () => {
      const current = await this.read(providerId)
      const next = await fn(current)
      if (next === undefined) return current
      await this.credentials.set(oauthCredentialRef(providerId), serializeCredential(next))
      return next
    })
  }

  delete(providerId: string): Promise<void> {
    return this.enqueue(providerId, async () => {
      await this.credentials.unset(oauthCredentialRef(providerId))
    })
  }
}
