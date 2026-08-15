/**
 * llm domain zod schemas (names derived from map keys: llmProvidersRequestSchema /
 * llmProvidersValueSchema / llmModelsRequestSchema / llmModelsValueSchema).
 */

import { z } from 'zod'
import type { RequestPayload, ResponseValue } from './rpc-map.ts'
import type { Wire } from './rpc.schema.ts'
import type { ConfigurableProviderView, DiscoveredModelView, ProviderAuthLoginEventView, ProviderAuthLoginView, ProviderAuthMethodView, ProviderAuthStatusView } from './llm.ts'
import { modelCatalogFailureSchema, modelProviderGroupSchema } from './sessions.schema.ts'

/** ProviderAuthMethodView row. */
export const providerAuthMethodViewSchema = z.object({
  type: z.enum(['api_key', 'oauth']),
  label: z.string().min(1),
  serviceable: z.boolean(),
  configured: z.boolean().optional(),
  source: z.string().min(1).optional(),
}) satisfies z.ZodType<Wire<ProviderAuthMethodView>>

/** ConfigurableProviderView row of llm.providers. */
export const configurableProviderViewSchema = z.object({
  provider: z.string().min(1),
  displayName: z.string().min(1),
  settingsNs: z.string(),
  settingsPath: z.array(z.string()),
  active: z.boolean(),
  declared: z.boolean().optional(),
  authMethods: z.array(providerAuthMethodViewSchema).optional(),
}) satisfies z.ZodType<Wire<ConfigurableProviderView>>

/** llm.providers request payload. */
export const llmProvidersRequestSchema = z.object({}) satisfies z.ZodType<Wire<RequestPayload<'llm.providers'>>>

/** llm.providers response value. */
export const llmProvidersValueSchema = z.object({
  providers: z.array(configurableProviderViewSchema),
}) satisfies z.ZodType<Wire<ResponseValue<'llm.providers'>>>

/** llm.models request payload. */
export const llmModelsRequestSchema = z.object({}) satisfies z.ZodType<Wire<RequestPayload<'llm.models'>>>

/** llm.models response value. */
export const llmModelsValueSchema = z.object({
  groups: z.array(modelProviderGroupSchema),
  failures: z.array(modelCatalogFailureSchema),
}) satisfies z.ZodType<Wire<ResponseValue<'llm.models'>>>

/** DiscoveredModelView row of llm.discoverModels. */
export const discoveredModelViewSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1).optional(),
  contextWindow: z.number().int().positive().optional(),
  maxTokens: z.number().int().positive().optional(),
}) satisfies z.ZodType<Wire<DiscoveredModelView>>

/** llm.discoverModels request payload. */
export const llmDiscoverModelsRequestSchema = z.object({
  settingsNs: z.string().min(1),
  provider: z.string().min(1).optional(),
  baseURL: z.string().min(1).optional(),
  api: z.string().min(1).optional(),
  // Write-only at the host: used for this one interrogation, never stored and
  // never returned. It does ride the client's outgoing envelope like every
  // other secret-bearing payload (`credentials.set`, `settings.update`), which
  // `subscribeEnvelopes()` observers can see — redacting that tap is a
  // configuration-plane-wide change, not this method's to make alone.
  apiKey: z.string().min(1).optional(),
}) satisfies z.ZodType<Wire<RequestPayload<'llm.discoverModels'>>>

/** llm.discoverModels response value. */
export const llmDiscoverModelsValueSchema = z.object({
  models: z.array(discoveredModelViewSchema),
}) satisfies z.ZodType<Wire<ResponseValue<'llm.discoverModels'>>>

/** ProviderAuthStatusView schema. */
export const providerAuthStatusViewSchema = z.object({
  provider: z.string().min(1),
  methods: z.array(providerAuthMethodViewSchema),
}) satisfies z.ZodType<Wire<ProviderAuthStatusView>>

const providerAuthLoginEventViewSchema = z.discriminatedUnion('type', [
  z.object({
    id: z.string().min(1),
    type: z.literal('info'),
    message: z.string(),
    links: z.array(z.object({ url: z.string().min(1), label: z.string().min(1).optional() })).optional(),
  }),
  z.object({
    id: z.string().min(1),
    type: z.literal('auth_url'),
    url: z.string().min(1),
    instructions: z.string().optional(),
  }),
  z.object({
    id: z.string().min(1),
    type: z.literal('device_code'),
    userCode: z.string().min(1),
    verificationUri: z.string().min(1),
    intervalSeconds: z.number().positive().optional(),
    expiresInSeconds: z.number().positive().optional(),
  }),
  z.object({
    id: z.string().min(1),
    type: z.literal('progress'),
    message: z.string(),
  }),
  z.object({
    id: z.string().min(1),
    type: z.literal('prompt'),
    promptType: z.enum(['text', 'select', 'manual_code']),
    message: z.string(),
    placeholder: z.string().optional(),
    options: z.array(z.object({
      id: z.string().min(1),
      label: z.string().min(1),
      description: z.string().optional(),
    })).optional(),
  }),
]) satisfies z.ZodType<Wire<ProviderAuthLoginEventView>>

/** ProviderAuthLoginView schema. */
export const providerAuthLoginViewSchema = z.object({
  loginId: z.string().min(1),
  state: z.enum(['pending', 'completed', 'failed', 'cancelled']),
  events: z.array(providerAuthLoginEventViewSchema),
  status: providerAuthStatusViewSchema.optional(),
  error: z.string().optional(),
}) satisfies z.ZodType<Wire<ProviderAuthLoginView>>

/** Request schema for llm.providerAuthStatus. */
export const llmProviderAuthStatusRequestSchema = z.object({
  provider: z.string().min(1),
}) satisfies z.ZodType<Wire<RequestPayload<'llm.providerAuthStatus'>>>

/** Response schema for llm.providerAuthStatus. */
export const llmProviderAuthStatusValueSchema = z.object({
  status: providerAuthStatusViewSchema,
}) satisfies z.ZodType<Wire<ResponseValue<'llm.providerAuthStatus'>>>

/** Request schema for llm.providerAuthLoginStart. */
export const llmProviderAuthLoginStartRequestSchema = z.object({
  provider: z.string().min(1),
  method: z.literal('oauth'),
}) satisfies z.ZodType<Wire<RequestPayload<'llm.providerAuthLoginStart'>>>

/** Response schema for llm.providerAuthLoginStart. */
export const llmProviderAuthLoginStartValueSchema = providerAuthLoginViewSchema satisfies z.ZodType<Wire<ResponseValue<'llm.providerAuthLoginStart'>>>

/** Request schema for llm.providerAuthLoginGet. */
export const llmProviderAuthLoginGetRequestSchema = z.object({
  provider: z.string().min(1),
  loginId: z.string().min(1),
}) satisfies z.ZodType<Wire<RequestPayload<'llm.providerAuthLoginGet'>>>

/** Response schema for llm.providerAuthLoginGet. */
export const llmProviderAuthLoginGetValueSchema = providerAuthLoginViewSchema satisfies z.ZodType<Wire<ResponseValue<'llm.providerAuthLoginGet'>>>

/** Request schema for llm.providerAuthLoginAnswer. */
export const llmProviderAuthLoginAnswerRequestSchema = z.object({
  provider: z.string().min(1),
  loginId: z.string().min(1),
  promptId: z.string().min(1),
  answer: z.string(),
}) satisfies z.ZodType<Wire<RequestPayload<'llm.providerAuthLoginAnswer'>>>

/** Response schema for llm.providerAuthLoginAnswer. */
export const llmProviderAuthLoginAnswerValueSchema = providerAuthLoginViewSchema satisfies z.ZodType<Wire<ResponseValue<'llm.providerAuthLoginAnswer'>>>

/** Request schema for llm.providerAuthLoginCancel. */
export const llmProviderAuthLoginCancelRequestSchema = llmProviderAuthLoginGetRequestSchema satisfies z.ZodType<Wire<RequestPayload<'llm.providerAuthLoginCancel'>>>

/** Response schema for llm.providerAuthLoginCancel. */
export const llmProviderAuthLoginCancelValueSchema = providerAuthLoginViewSchema satisfies z.ZodType<Wire<ResponseValue<'llm.providerAuthLoginCancel'>>>

/** Request schema for llm.providerAuthLogout. */
export const llmProviderAuthLogoutRequestSchema = z.object({
  provider: z.string().min(1),
  method: z.literal('oauth'),
}) satisfies z.ZodType<Wire<RequestPayload<'llm.providerAuthLogout'>>>

/** Response schema for llm.providerAuthLogout. */
export const llmProviderAuthLogoutValueSchema = z.object({
  status: providerAuthStatusViewSchema,
}) satisfies z.ZodType<Wire<ResponseValue<'llm.providerAuthLogout'>>>
