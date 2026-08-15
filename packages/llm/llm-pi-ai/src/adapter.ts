/**
 * Generic pi-ai-backed implementation of the Harness LLM seam.
 *
 * Each resolution produces one **immutable** snapshot — the profiles plus a
 * `Models` collection holding the `Provider` each route built — and an
 * operation captures a whole snapshot before its first `await`. A
 * configuration change builds a *new* collection rather than mutating the one
 * in use, because `Models.streamSimple()` is lazy: it resolves the provider
 * when the stream is first consumed, which is after the credential await, so a
 * mutated collection would let a request that started under one configuration
 * finish under another — or fail with a provider that no longer exists. This is
 * what makes the seam's per-step call freeze (`llm.prepareCall()`) hold all the
 * way down: switching models mid-reply takes effect on the next step, never
 * inside the one in flight.
 *
 * Credentials stay outside that collection. The harness resolves a route's key
 * through its own seam and passes it as the request's `apiKey` option, which
 * pi-ai treats as the highest-priority auth override — so `Models` never holds
 * a credential store and the harness keeps its fail-loud reference semantics.
 *
 * @module dsh-llm-pi-ai/adapter
 */

import { createModels, getSupportedThinkingLevels } from '@earendil-works/pi-ai'
import type {
  Api,
  AuthEvent,
  AuthInteraction,
  AuthPrompt,
  CredentialStore,
  Model,
  Models,
  ModelThinkingLevel,
  MutableModels,
  SimpleStreamOptions,
  ThinkingLevel,
} from '@earendil-works/pi-ai'
import {
  attributionHeaders,
  contentHasImage,
  LlmAdapter,
  LlmError,
  ReasoningEffortId,
} from '@deepseek-ai/dsh-llm'
import type {
  GenerateOptions,
  LlmProviderAuthLoginEvent,
  LlmProviderAuthLoginSnapshot,
  LlmProviderAuthMethod,
  LlmProviderAuthStatus,
  LlmModelInfo,
  LlmProviderInfo,
  LlmResolvedModelInfo,
  ReasoningEffortId as ReasoningEffortIdType,
  ResolvedRetryPolicy,
  StreamChunk,
} from '@deepseek-ai/dsh-llm'
import type { AttachmentStore } from '@deepseek-ai/dsh-attachment'
import { idleWatchdog, timeoutOf } from '@deepseek-ai/dsh-timeout'
import type { ResolvedPiAiProviderProfile } from './config.ts'
import { toPiContext } from './context.ts'
import { toStreamChunks } from './stream.ts'

/** One resolution's frozen view: the profiles and the collection built from them. */
interface PiAiSnapshot {
  /** The resolved profiles this collection was built from, used as its identity. */
  profiles: ReadonlyMap<string, ResolvedPiAiProviderProfile>
  /** Providers for exactly those profiles; never mutated once published. */
  models: Models
}

interface PromptWaiter {
  resolve(answer: string): void
  reject(error: Error): void
}

type LoginEventWithoutId = LlmProviderAuthLoginEvent extends infer Event
  ? Event extends { id: string } ? Omit<Event, 'id'> : never
  : never

interface LoginSession {
  provider: string
  controller: AbortController
  state: LlmProviderAuthLoginSnapshot['state']
  events: LlmProviderAuthLoginEvent[]
  waiters: Map<string, PromptWaiter>
  status?: LlmProviderAuthStatus
  error?: string
  settledAt?: number
}

const LOGIN_RETENTION_MS = 5 * 60_000

function providerAuthFailureMessage(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code
  if (code === 'ABORTED') return 'provider auth login cancelled'
  if (code === 'AUTH_EXPIRED') return 'provider auth credential expired'
  return 'provider auth login failed'
}

/** Constructor options for {@link PiAiAdapter}: the two resolution hooks the plugin owns. */
export interface PiAiAdapterOptions {
  /** Current validated profiles by provider route; called once per operation. */
  profiles: () => ReadonlyMap<string, ResolvedPiAiProviderProfile>
  /**
   * Resolve the credential for one already-resolved profile; called once per
   * stream call and frozen for that call. `undefined` defers to the route's own
   * pi-ai auth, which for an installed catalog route is its provider-native
   * ambient discovery; the plugin allows that only for a profile naming no
   * credential at all, because a named reference that misses throws `LlmError`
   * `MISSING_CREDENTIAL` rather than falling back.
   */
  resolveApiKey: (provider: string, profile: ResolvedPiAiProviderProfile) => Promise<string | undefined>
  /** Durable pi-ai credential store shared by every immutable Models snapshot. */
  credentials?: CredentialStore
  /** Resolve the optional durable attachment service at request time. */
  resolveAttachments?: () => AttachmentStore | undefined
}

/** Copy profile stream knobs into pi-ai's common option vocabulary. */
function profileOptions(
  profile: ResolvedPiAiProviderProfile,
  reasoning: ModelThinkingLevel | undefined,
  apiKey: string | undefined,
): SimpleStreamOptions {
  const enabledReasoning: ThinkingLevel | undefined = reasoning === 'off' ? undefined : reasoning
  return {
    ...apiKey === undefined ? {} : { apiKey },
    ...enabledReasoning === undefined ? {} : { reasoning: enabledReasoning },
    ...profile.thinkingBudgets === undefined ? {} : { thinkingBudgets: profile.thinkingBudgets },
    ...profile.cacheRetention === undefined ? {} : { cacheRetention: profile.cacheRetention },
    ...profile.transport === undefined ? {} : { transport: profile.transport },
    ...profile.timeoutMs === undefined ? {} : { timeoutMs: profile.timeoutMs },
    ...profile.websocketConnectTimeoutMs === undefined ? {} : { websocketConnectTimeoutMs: profile.websocketConnectTimeoutMs },
    // The agent recovery layer owns visible attempts; one adapter call is one SDK attempt.
    maxRetries: 0,
  }
}

/**
 * The profile default this exact model can actually take, for DESCRIBING it.
 * A configured level the model does not support yields none rather than
 * throwing: `resolveModel` builds the model catalog, and a catalog that fails
 * takes its whole provider out of every picker — so one mis-set profile field
 * would hide every model on the route, including the ones that support the
 * level. The request path still refuses, which is where a bad configuration
 * belongs: describing what a model can do must not fail because a deployment
 * asked it for something it cannot.
 * @param model - the resolved model descriptor.
 * @param effort - the profile's configured level, if any.
 * @returns the level when this model supports it, otherwise undefined.
 */
function describableReasoningLevel(
  model: Model<Api>,
  effort: ReasoningEffortIdType | ModelThinkingLevel | undefined,
): ModelThinkingLevel | undefined {
  if (effort === undefined) return undefined
  return getSupportedThinkingLevels(model).some(level => level === effort)
    ? effort as ModelThinkingLevel
    : undefined
}

/** Validate an explicit Harness/profile effort without invoking pi-ai's clamp. */
function resolveReasoningLevel(
  model: Model<Api>,
  effort: ReasoningEffortIdType | ModelThinkingLevel | undefined,
): ModelThinkingLevel | undefined {
  if (effort === undefined) return undefined
  const supported = getSupportedThinkingLevels(model)
  if (supported.some(level => level === effort)) return effort as ModelThinkingLevel
  throw new LlmError(
    `pi-ai provider "${model.provider}" model "${model.id}" does not support reasoning effort "${effort}"`,
    'UNSUPPORTED_REASONING_EFFORT',
  )
}

/**
 * Selectable reasoning efforts for one model, or nothing at all.
 *
 * A model that carries no reasoning metadata — every hand-declared one, and
 * every catalog model pi-ai marks as non-reasoning — is reported by pi-ai as
 * supporting the single level `off`. Passing that through would offer a control
 * that cannot do what it says: `off` is translated to *omitting* the reasoning
 * option, which for such a model is byte-for-byte the same request as naming no
 * effort — so a provider whose own default is to think would keep thinking with
 * `off` selected. Omitting `reasoning` entirely is the seam's way of saying the
 * capability is unavailable, which leaves the surface offering only the
 * provider's default.
 * @param model - the resolved model descriptor.
 * @param defaultLevel - the profile's configured effort, already validated.
 * @returns the `reasoning` field, or an empty object when none can be offered.
 */
function reasoningInfo(
  model: Model<Api>,
  defaultLevel: ModelThinkingLevel | undefined,
): Pick<LlmResolvedModelInfo, 'reasoning'> | Record<string, never> {
  if (!model.reasoning) return {}
  const levels = getSupportedThinkingLevels(model)
  return {
    reasoning: {
      efforts: levels.map(level => ({
        id: ReasoningEffortId(level),
        name: `${level.charAt(0).toUpperCase()}${level.slice(1)}`,
      })),
      ...defaultLevel === undefined ? {} : { defaultEffort: ReasoningEffortId(defaultLevel) },
    },
  }
}

/** Merge deployment headers while removing case-insensitive attribution collisions. */
function requestHeaders(headers: Readonly<Record<string, string>> | undefined): Record<string, string> {
  const attribution = attributionHeaders()
  const reserved = new Set(Object.keys(attribution).map(name => name.toLowerCase()))
  return {
    ...Object.fromEntries(Object.entries(headers ?? {}).filter(([name]) => !reserved.has(name.toLowerCase()))),
    ...attribution,
  }
}

/**
 * pi-ai-backed multi-provider adapter. Each operation reads the current
 * profiles, so a configuration change reaches the next request without a
 * restart; model descriptors come from the collection those profiles built.
 */
export class PiAiAdapter extends LlmAdapter {
  private snapshot: PiAiSnapshot | undefined
  private readonly logins = new Map<string, LoginSession>()

  constructor(private readonly config: PiAiAdapterOptions) {
    super()
  }

  /**
   * The snapshot for the current profiles. Resolution memoizes its result, so
   * an unchanged configuration is recognized by identity; a changed one gets a
   * brand-new collection, leaving any snapshot an operation already captured
   * untouched for as long as that operation holds it.
   */
  private current(): PiAiSnapshot {
    const profiles = this.config.profiles()
    if (this.snapshot?.profiles === profiles) return this.snapshot
    const models: MutableModels = createModels(
      this.config.credentials === undefined ? undefined : { credentials: this.config.credentials },
    )
    for (const profile of profiles.values()) models.setProvider(profile.piProvider)
    this.snapshot = { profiles, models }
    return this.snapshot
  }

  private authStatusFromProvider(
    provider: string,
    piProvider = this.current().models.getProvider(provider),
  ): Promise<LlmProviderAuthStatus> {
    if (piProvider === undefined) return Promise.resolve({ provider, methods: [] })
    return Promise.all([
      ...(piProvider.auth.apiKey === undefined ? [] : [Promise.resolve({
        type: 'api_key' as const,
        label: piProvider.auth.apiKey.name,
        serviceable: true,
        configured: false,
      })]),
      ...(piProvider.auth.oauth === undefined ? [] : [(async () => {
        const credential = await this.config.credentials?.read(provider)
        return {
          type: 'oauth' as const,
          label: piProvider.auth.oauth?.loginLabel ?? piProvider.auth.oauth?.name ?? 'OAuth',
          serviceable: this.config.credentials !== undefined,
          configured: credential?.type === 'oauth',
          ...credential?.type === 'oauth' ? { source: 'OAuth' } : {},
        }
      })()]),
    ]).then(methods => ({ provider, methods }))
  }

  override providerAuthStatus(provider: string): Promise<LlmProviderAuthStatus> {
    this.profileOf(this.current(), provider)
    return this.authStatusFromProvider(provider)
  }

  private snapshotOf(session: LoginSession): LlmProviderAuthLoginSnapshot {
    return {
      loginId: [...this.logins.entries()].find(([, value]) => value === session)?.[0] ?? '',
      state: session.state,
      events: session.events.map(event => ({ ...event })),
      ...session.status === undefined ? {} : { status: session.status },
      ...session.error === undefined ? {} : { error: session.error },
    }
  }

  private addEvent(session: LoginSession, event: LoginEventWithoutId): void {
    session.events.push({ ...event, id: crypto.randomUUID() })
  }

  private pruneLogins(now = Date.now()): void {
    for (const [loginId, session] of this.logins.entries()) {
      if (session.settledAt === undefined) continue
      if (now - session.settledAt < LOGIN_RETENTION_MS) continue
      this.logins.delete(loginId)
    }
  }

  private sessionOf(provider: string, loginId: string): LoginSession {
    this.pruneLogins()
    const session = this.logins.get(loginId)
    if (session === undefined || session.provider !== provider) {
      throw new LlmError(`unknown provider auth login "${loginId}"`, 'UNKNOWN_AUTH_LOGIN')
    }
    return session
  }

  private settleLogin(loginId: string, session: LoginSession, state: LlmProviderAuthLoginSnapshot['state']): void {
    session.state = state
    session.settledAt = Date.now()
    for (const [promptId, waiter] of session.waiters.entries()) {
      waiter.reject(new Error(`provider auth prompt "${promptId}" was settled by ${state}`))
      session.waiters.delete(promptId)
    }
    this.logins.set(loginId, session)
    this.pruneLogins()
  }

  private prompt(session: LoginSession, prompt: AuthPrompt): Promise<string> {
    if (prompt.type === 'secret') {
      return Promise.reject(new Error('provider auth flow requested a secret prompt this UI does not expose'))
    }
    const id = crypto.randomUUID()
    if (prompt.type === 'text') {
      this.addEvent(session, {
        type: 'prompt',
        promptType: prompt.type,
        message: prompt.message,
        ...prompt.placeholder === undefined ? {} : { placeholder: prompt.placeholder },
      })
    } else if (prompt.type === 'select') {
      this.addEvent(session, {
        type: 'prompt',
        promptType: prompt.type,
        message: prompt.message,
        options: prompt.options.map(option => ({ ...option })),
      })
    } else {
      this.addEvent(session, {
        type: 'prompt',
        promptType: 'manual_code',
        message: prompt.message,
      })
    }
    const event = session.events.at(-1)
    if (event?.type !== 'prompt') return Promise.reject(new Error('provider auth prompt could not be created'))
    Object.assign(event, { id })
    return new Promise((resolve, reject) => {
      const abort = (): void => {
        session.waiters.delete(id)
        reject(new Error('provider auth login cancelled'))
      }
      if (session.controller.signal.aborted || prompt.signal?.aborted) {
        abort()
        return
      }
      const onAbort = (): void => { abort() }
      session.controller.signal.addEventListener('abort', onAbort, { once: true })
      prompt.signal?.addEventListener('abort', onAbort, { once: true })
      session.waiters.set(id, {
        resolve: (answer) => {
          session.controller.signal.removeEventListener('abort', onAbort)
          prompt.signal?.removeEventListener('abort', onAbort)
          resolve(answer)
        },
        reject: (error) => {
          session.controller.signal.removeEventListener('abort', onAbort)
          prompt.signal?.removeEventListener('abort', onAbort)
          reject(error)
        },
      })
    })
  }

  private notify(session: LoginSession, event: AuthEvent): void {
    this.addEvent(session, event)
  }

  override startProviderAuthLogin(provider: string, method: LlmProviderAuthMethod): Promise<LlmProviderAuthLoginSnapshot> {
    if (method !== 'oauth') throw new LlmError('llm-pi-ai only supports OAuth provider-auth login', 'UNSUPPORTED_AUTH')
    const snapshot = this.current()
    this.profileOf(snapshot, provider)
    const piProvider = snapshot.models.getProvider(provider)
    if (piProvider?.auth.oauth === undefined || this.config.credentials === undefined) {
      throw new LlmError(`pi-ai provider "${provider}" does not have serviceable OAuth login`, 'UNSUPPORTED_AUTH')
    }
    const loginId = crypto.randomUUID()
    const session: LoginSession = {
      provider,
      controller: new AbortController(),
      state: 'pending',
      events: [],
      waiters: new Map(),
    }
    this.logins.set(loginId, session)
    const interaction: AuthInteraction = {
      signal: session.controller.signal,
      prompt: prompt => this.prompt(session, prompt),
      notify: (event) => { this.notify(session, event) },
    }
    void snapshot.models.login(provider, 'oauth', interaction).then(
      async () => {
        this.settleLogin(loginId, session, 'completed')
        session.status = await this.authStatusFromProvider(provider, piProvider)
      },
      (error: unknown) => {
        this.settleLogin(loginId, session, session.controller.signal.aborted ? 'cancelled' : 'failed')
        if (!session.controller.signal.aborted) session.error = providerAuthFailureMessage(error)
      },
    )
    return Promise.resolve(this.snapshotOf(session))
  }

  override providerAuthLogin(provider: string, loginId: string): Promise<LlmProviderAuthLoginSnapshot> {
    return Promise.resolve(this.snapshotOf(this.sessionOf(provider, loginId)))
  }

  override answerProviderAuthLogin(
    provider: string,
    loginId: string,
    promptId: string,
    answer: string,
  ): Promise<LlmProviderAuthLoginSnapshot> {
    const session = this.sessionOf(provider, loginId)
    if (session.state !== 'pending') throw new LlmError(`provider auth login "${loginId}" is not pending`, 'UNSUPPORTED_AUTH')
    const waiter = session.waiters.get(promptId)
    if (waiter === undefined) throw new LlmError(`unknown provider auth prompt "${promptId}"`, 'UNKNOWN_AUTH_PROMPT')
    session.waiters.delete(promptId)
    waiter.resolve(answer)
    return Promise.resolve(this.snapshotOf(session))
  }

  override cancelProviderAuthLogin(provider: string, loginId: string): Promise<LlmProviderAuthLoginSnapshot> {
    const session = this.sessionOf(provider, loginId)
    session.controller.abort('provider auth login cancelled')
    this.settleLogin(loginId, session, 'cancelled')
    return Promise.resolve(this.snapshotOf(session))
  }

  override async logoutProviderAuth(provider: string, method: LlmProviderAuthMethod): Promise<LlmProviderAuthStatus> {
    if (method !== 'oauth') throw new LlmError('llm-pi-ai only supports OAuth provider-auth logout', 'UNSUPPORTED_AUTH')
    this.profileOf(this.current(), provider)
    await this.current().models.logout(provider)
    return this.authStatusFromProvider(provider)
  }

  /** The profile for one route within one snapshot, or the not-owned failure. */
  private profileOf(snapshot: PiAiSnapshot, provider: string): ResolvedPiAiProviderProfile {
    const profile = snapshot.profiles.get(provider)
    if (profile === undefined) {
      throw new LlmError(`pi-ai adapter does not own provider "${provider}"`, 'NO_ADAPTER')
    }
    return profile
  }

  /** The configured descriptor for one exact route/model pair within one snapshot. */
  private modelOf(snapshot: PiAiSnapshot, provider: string, model: string): Model<Api> {
    this.profileOf(snapshot, provider)
    const resolved = snapshot.models.getModel(provider, model)
    if (resolved === undefined) {
      throw new LlmError(`pi-ai provider "${provider}" has no configured model "${model}"`, 'UNKNOWN_MODEL')
    }
    return resolved
  }

  override providerInfo(provider: string): LlmProviderInfo {
    // The configured name, not the route key: `displayName` exists so a
    // deployment can label a route, and a label only the configuration surface
    // reads would leave every selector showing the raw key.
    return { id: provider, name: this.current().profiles.get(provider)?.displayName ?? provider }
  }

  override providerRetryPolicy(provider: string): ResolvedRetryPolicy | undefined {
    return this.current().profiles.get(provider)?.retryPolicy
  }

  override listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    return Promise.resolve().then(() => {
      const snapshot = this.current()
      this.profileOf(snapshot, provider)
      return snapshot.models.getModels(provider).map(model => ({
        provider,
        id: model.id,
        name: model.name,
        inputModalities: [...model.input],
      }))
    })
  }

  override resolveModel(
    provider: string,
    model: string,
    _signal?: AbortSignal,
  ): Promise<LlmResolvedModelInfo> {
    return Promise.resolve().then(() => {
      const snapshot = this.current()
      const profile = this.profileOf(snapshot, provider)
      const resolvedModel = this.modelOf(snapshot, provider, model)
      const defaultLevel = describableReasoningLevel(resolvedModel, profile.reasoning)
      // Only a cap the deployment configured is a request default; the
      // catalog's `maxTokens` sizes the model and stops there.
      const configuredMaxTokens = profile.configuredMaxTokens.get(model)
      return {
        provider,
        id: model,
        name: resolvedModel.name,
        inputModalities: [...resolvedModel.input],
        context: { contextWindow: resolvedModel.contextWindow },
        ...configuredMaxTokens === undefined ? {} : { defaultMaxTokens: configuredMaxTokens },
        ...reasoningInfo(resolvedModel, defaultLevel),
      }
    })
  }

  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    if (options.stop !== undefined) {
      throw new LlmError('llm-pi-ai does not support GenerateOptions.stop', 'UNSUPPORTED_OPTION')
    }
    // One capture per stream call, taken before any await: the profile, the
    // model descriptor, and the collection all come from the same immutable
    // snapshot, and the credential freezes with them. A configuration change
    // mid-request builds a separate snapshot, so this request finishes under
    // the one it started with and the next call picks up the new one.
    const snapshot = this.current()
    const profile = this.profileOf(snapshot, options.provider)
    const model = this.modelOf(snapshot, options.provider, options.model)
    const reasoning = resolveReasoningLevel(
      model,
      options.reasoningEffort ?? profile.reasoning,
    )
    const apiKey = await this.config.resolveApiKey(options.provider, profile)

    const consumer = new AbortController()
    const upstream = options.signal === undefined
      ? consumer.signal
      : AbortSignal.any([options.signal, consumer.signal])
    const streamIdleTimeoutMs = profile.streamIdleTimeoutMs
    using watchdog = idleWatchdog(upstream, streamIdleTimeoutMs, 'LLM_STREAM_IDLE_TIMEOUT')

    try {
      const containsImage = options.messages.some(message => contentHasImage(message.content))
      if (containsImage && !model.input.includes('image')) {
        throw new LlmError(`pi-ai model "${model.id}" does not support image input`, 'UNSUPPORTED_CONTENT')
      }
      const attachments = containsImage ? this.config.resolveAttachments?.() : undefined
      if (containsImage && attachments === undefined) {
        throw new LlmError('pi-ai image input requires the durable attachment service', 'UNSUPPORTED_CONTENT')
      }
      const context = attachments === undefined
        ? toPiContext(options)
        : await toPiContext(options, attachments)
      const events = snapshot.models.streamSimple(model, context, {
        ...profileOptions(profile, reasoning, apiKey),
        ...options.temperature === undefined ? {} : { temperature: options.temperature },
        ...options.maxTokens === undefined ? {} : { maxTokens: options.maxTokens },
        ...options.sessionId === undefined ? {} : { sessionId: String(options.sessionId) },
        signal: watchdog.signal,
        // Profile headers are deployment-owned; attribution names are
        // Harness-owned and therefore win collisions.
        headers: requestHeaders(profile.headers),
      })
      const iterator = toStreamChunks(events, model.contextWindow)[Symbol.asyncIterator]()
      let exhausted = false
      try {
        while (true) {
          const result = await watchdog.next(iterator)
          const timeout = timeoutOf(watchdog.signal, 'LLM_STREAM_IDLE_TIMEOUT')
          if (timeout !== undefined) throw timeout
          if (result.done) {
            exhausted = true
            return
          }
          yield result.value
        }
      } finally {
        if (!exhausted) {
          consumer.abort('pi-ai stream consumer stopped')
          try {
            await iterator.return(undefined)
          } catch (_abortedSdkTeardown) {
            // The stable signal already owns SDK termination; return-time abort cannot add an outcome.
          }
        }
      }
    } catch (error: unknown) {
      if (timeoutOf(watchdog.signal, 'LLM_STREAM_IDLE_TIMEOUT') !== undefined) {
        throw new LlmError(`pi-ai stream idle timeout after ${streamIdleTimeoutMs}ms`, 'TIMEOUT', { cause: error })
      }
      if (options.signal?.aborted) {
        throw new LlmError('pi-ai request aborted by caller', 'ABORTED', { cause: error })
      }
      throw error
    } finally {
      consumer.abort('pi-ai stream consumer stopped')
    }
  }
}
