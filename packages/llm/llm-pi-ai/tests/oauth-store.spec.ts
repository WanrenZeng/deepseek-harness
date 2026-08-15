import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { credentialRef, CredentialProvider } from '@deepseek-ai/dsh-credentials'
import type { CredentialInfo, CredentialRef, ResolvedCredential } from '@deepseek-ai/dsh-credentials'
import { HarnessPiAiCredentialStore, oauthCredentialRef } from '../src/oauth-store.ts'

class MemoryCredentials extends CredentialProvider {
  private readonly values = new Map<string, string>()

  resolve(ref: CredentialRef): Promise<ResolvedCredential | undefined> {
    const value = this.values.get(ref)
    return Promise.resolve(value === undefined ? undefined : { value, source: 'file' })
  }

  describe(ref: CredentialRef): Promise<CredentialInfo> {
    const configured = this.values.has(ref)
    return Promise.resolve({ configured, ...configured ? { source: 'file' } : {}, writable: true })
  }

  set(ref: CredentialRef, value: string): Promise<void> {
    this.values.set(ref, value)
    return Promise.resolve()
  }

  unset(ref: CredentialRef): Promise<void> {
    this.values.delete(ref)
    return Promise.resolve()
  }
}

function buildStore(providers: readonly string[] = ['github-copilot']): {
  credentials: MemoryCredentials
  store: HarnessPiAiCredentialStore
} {
  const ctx = new Context()
  const credentials = new MemoryCredentials(ctx)
  return {
    credentials,
    store: new HarnessPiAiCredentialStore(credentials, () => providers),
  }
}

describe('HarnessPiAiCredentialStore', () => {
  it('reads, lists, modifies, and deletes credentials', async () => {
    const { store } = buildStore()
    expect(await store.read('github-copilot')).toBeUndefined()
    expect(await store.list()).toEqual([])

    const created = await store.modify('github-copilot', async () => ({
      type: 'oauth',
      access: 'access-token',
      refresh: 'refresh-token',
      expires: Date.now() + 60_000,
    }))
    expect(created?.type).toBe('oauth')
    expect(await store.list()).toEqual([{ providerId: 'github-copilot', type: 'oauth' }])

    const refreshed = await store.modify('github-copilot', async current => ({
      ...current as { type: 'oauth'; refresh: string; expires: number },
      type: 'oauth',
      access: 'new-access-token',
    }))
    expect(refreshed).toMatchObject({ type: 'oauth', access: 'new-access-token', refresh: 'refresh-token' })

    await store.delete('github-copilot')
    expect(await store.read('github-copilot')).toBeUndefined()
  })

  it('keeps the current value when modify callback returns undefined', async () => {
    const { store } = buildStore()
    await store.modify('github-copilot', async () => ({
      type: 'oauth',
      access: 'access-token',
      refresh: 'refresh-token',
      expires: Date.now() + 60_000,
    }))
    const unchanged = await store.modify('github-copilot', async () => undefined)
    expect(unchanged).toMatchObject({ type: 'oauth', access: 'access-token' })
  })

  it('serializes concurrent modify calls per provider', async () => {
    const { store } = buildStore()
    const sequence: string[] = []
    let releaseFirst: (() => void) | undefined
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve })
    const first = store.modify('github-copilot', async () => {
      sequence.push('first-start')
      await firstGate
      sequence.push('first-end')
      return { type: 'oauth', access: 'a1', refresh: 'r1', expires: Date.now() + 10_000 }
    })
    const second = store.modify('github-copilot', async (current) => {
      sequence.push(`second-start:${current?.type ?? 'none'}`)
      sequence.push('second-end')
      return { type: 'oauth', access: 'a2', refresh: 'r2', expires: Date.now() + 10_000 }
    })
    releaseFirst?.()
    await Promise.all([first, second])
    expect(sequence).toEqual(['first-start', 'first-end', 'second-start:oauth', 'second-end'])
  })

  it('validates malformed stored values without exposing credential content', async () => {
    const { credentials, store } = buildStore()
    const ref = oauthCredentialRef('github-copilot')
    await credentials.set(ref, '{"type":"oauth","access":"secret-access"}')
    await expect(store.read('github-copilot')).rejects.toThrow(/missing a non-empty refresh token/)
    await expect(store.read('github-copilot')).rejects.not.toThrow(/secret-access/)
    await credentials.set(ref, '{"type":"oauth","access":"secret-access","refresh":"secret-refresh","expires":"nope"}')
    await expect(store.read('github-copilot')).rejects.toThrow(/invalid expiry/)
    await credentials.set(ref, '{not-json')
    await expect(store.read('github-copilot')).rejects.toThrow(/not valid JSON/)
  })

  it('lists only providers surfaced as serviceable', async () => {
    const { store } = buildStore(['github-copilot'])
    await store.modify('github-copilot', async () => ({
      type: 'oauth',
      access: 'access-token',
      refresh: 'refresh-token',
      expires: Date.now() + 60_000,
    }))
    await store.modify('openai-codex', async () => ({
      type: 'oauth',
      access: 'access-token',
      refresh: 'refresh-token',
      expires: Date.now() + 60_000,
    }))
    expect(await store.list()).toEqual([{ providerId: 'github-copilot', type: 'oauth' }])
  })

  it('derives stable credential references from provider ids', () => {
    expect(oauthCredentialRef('github-copilot')).toBe(credentialRef('DSH_PI_AI_OAUTH_GITHUB_COPILOT'))
  })
})
