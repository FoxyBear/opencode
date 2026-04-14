import type { AuthOAuthResult, Hooks } from "@opencode-ai/plugin"
import { NamedError } from "@opencode-ai/util/error"
import { Auth } from "@/auth"
import { InstanceState } from "@/effect/instance-state"
import { zod } from "@/util/effect-zod"
import { withStatics } from "@/util/schema"
import { Plugin } from "../plugin"
import { ProviderID } from "./schema"
import { Array as Arr, Effect, Layer, Record, Result, Context, Schema } from "effect"
import z from "zod"

export namespace ProviderAuth {
  export class When extends Schema.Class<When>("ProviderAuthWhen")({
    key: Schema.String,
    op: Schema.Union([Schema.Literal("eq"), Schema.Literal("neq")]),
    value: Schema.String,
  }) {
    static readonly zod = zod(this)
  }

  export class TextPrompt extends Schema.Class<TextPrompt>("ProviderAuthTextPrompt")({
    type: Schema.Literal("text"),
    key: Schema.String,
    message: Schema.String,
    placeholder: Schema.optional(Schema.String),
    when: Schema.optional(When),
  }) {
    static readonly zod = zod(this)
  }

  export class SelectOption extends Schema.Class<SelectOption>("ProviderAuthSelectOption")({
    label: Schema.String,
    value: Schema.String,
    hint: Schema.optional(Schema.String),
  }) {
    static readonly zod = zod(this)
  }

  export class SelectPrompt extends Schema.Class<SelectPrompt>("ProviderAuthSelectPrompt")({
    type: Schema.Literal("select"),
    key: Schema.String,
    message: Schema.String,
    options: Schema.Array(SelectOption),
    when: Schema.optional(When),
  }) {
    static readonly zod = zod(this)
  }

  export const Prompt = Schema.Union([TextPrompt, SelectPrompt])
    .annotate({ discriminator: "type", identifier: "ProviderAuthPrompt" })
    .pipe(withStatics((s) => ({ zod: zod(s) })))
  export type Prompt = Schema.Schema.Type<typeof Prompt>

  export class Method extends Schema.Class<Method>("ProviderAuthMethod")({
    type: Schema.Union([Schema.Literal("oauth"), Schema.Literal("api")]),
    label: Schema.String,
    prompts: Schema.optional(Schema.Array(Prompt)),
  }) {
    static readonly zod = zod(this)
  }

  export class Authorization extends Schema.Class<Authorization>("ProviderAuthAuthorization")({
    url: Schema.String,
    method: Schema.Union([Schema.Literal("auto"), Schema.Literal("code")]),
    instructions: Schema.String,
  }) {
    static readonly zod = zod(this)
  }

  export const Methods = Schema.Record(Schema.String, Schema.Array(Method))
    .annotate({ identifier: "ProviderAuthMethods" })
    .pipe(withStatics((s) => ({ zod: zod(s) })))
  export type Methods = Schema.Schema.Type<typeof Methods>

  export const OauthMissing = NamedError.create("ProviderAuthOauthMissing", z.object({ providerID: ProviderID.zod }))

  export const OauthCodeMissing = NamedError.create(
    "ProviderAuthOauthCodeMissing",
    z.object({ providerID: ProviderID.zod }),
  )

  export const OauthCallbackFailed = NamedError.create("ProviderAuthOauthCallbackFailed", z.object({}))

  export const ValidationFailed = NamedError.create(
    "ProviderAuthValidationFailed",
    z.object({
      field: z.string(),
      message: z.string(),
    }),
  )

  export type Error =
    | Auth.AuthError
    | InstanceType<typeof OauthMissing>
    | InstanceType<typeof OauthCodeMissing>
    | InstanceType<typeof OauthCallbackFailed>
    | InstanceType<typeof ValidationFailed>

  type Hook = NonNullable<Hooks["auth"]>

  export interface Interface {
    readonly methods: () => Effect.Effect<Record<ProviderID, Method[]>>
    readonly authorize: (input: {
      providerID: ProviderID
      method: number
      inputs?: Record<string, string>
    }) => Effect.Effect<Authorization | undefined, Error>
    readonly callback: (input: { providerID: ProviderID; method: number; code?: string }) => Effect.Effect<void, Error>
  }

  interface State {
    hooks: Record<ProviderID, Hook>
    pending: Map<ProviderID, AuthOAuthResult>
  }

  export class Service extends Context.Service<Service, Interface>()("@opencode/ProviderAuth") {}

  export const layer: Layer.Layer<Service, never, Auth.Service | Plugin.Service> = Layer.effect(
    Service,
    Effect.gen(function* () {
      const auth = yield* Auth.Service
      const plugin = yield* Plugin.Service
      const state = yield* InstanceState.make<State>(
        Effect.fn("ProviderAuth.state")(function* () {
          const plugins = yield* plugin.list()
          return {
            hooks: Record.fromEntries(
              Arr.filterMap(plugins, (x) =>
                x.auth?.provider !== undefined
                  ? Result.succeed([ProviderID.make(x.auth.provider), x.auth] as const)
                  : Result.failVoid,
              ),
            ),
            pending: new Map<ProviderID, AuthOAuthResult>(),
          }
        }),
      )

      const methods = Effect.fn("ProviderAuth.methods")(function* () {
        const hooks = (yield* InstanceState.get(state)).hooks
        return Record.map(hooks, (item) =>
          item.methods.map(
            (method): Method => ({
              type: method.type,
              label: method.label,
              prompts: method.prompts?.map((prompt) => {
                if (prompt.type === "select") {
                  return {
                    type: "select" as const,
                    key: prompt.key,
                    message: prompt.message,
                    options: prompt.options,
                    when: prompt.when,
                  }
                }
                return {
                  type: "text" as const,
                  key: prompt.key,
                  message: prompt.message,
                  placeholder: prompt.placeholder,
                  when: prompt.when,
                }
              }),
            }),
          ),
        )
      })

      const authorize = Effect.fn("ProviderAuth.authorize")(function* (input: {
        providerID: ProviderID
        method: number
        inputs?: Record<string, string>
      }) {
        const { hooks, pending } = yield* InstanceState.get(state)
        const method = hooks[input.providerID].methods[input.method]
        if (method.type !== "oauth") return

        if (method.prompts && input.inputs) {
          for (const prompt of method.prompts) {
            if (prompt.type === "text" && prompt.validate && input.inputs[prompt.key] !== undefined) {
              const error = prompt.validate(input.inputs[prompt.key])
              if (error) return yield* Effect.fail(new ValidationFailed({ field: prompt.key, message: error }))
            }
          }
        }

        const result = yield* Effect.promise(() => method.authorize(input.inputs))
        pending.set(input.providerID, result)
        return {
          url: result.url,
          method: result.method,
          instructions: result.instructions,
        }
      })

      const callback = Effect.fn("ProviderAuth.callback")(function* (input: {
        providerID: ProviderID
        method: number
        code?: string
      }) {
        const pending = (yield* InstanceState.get(state)).pending
        const match = pending.get(input.providerID)
        if (!match) return yield* Effect.fail(new OauthMissing({ providerID: input.providerID }))
        if (match.method === "code" && !input.code) {
          return yield* Effect.fail(new OauthCodeMissing({ providerID: input.providerID }))
        }

        const result = yield* Effect.promise(() =>
          match.method === "code" ? match.callback(input.code!) : match.callback(),
        )
        if (!result || result.type !== "success") return yield* Effect.fail(new OauthCallbackFailed({}))

        if ("key" in result) {
          yield* auth.set(input.providerID, {
            type: "api",
            key: result.key,
          })
        }

        if ("refresh" in result) {
          const { type: _, provider: __, refresh, access, expires, ...extra } = result
          yield* auth.set(input.providerID, {
            type: "oauth",
            access,
            refresh,
            expires,
            ...extra,
          })
        }
      })

      return Service.of({ methods, authorize, callback })
    }),
  )

  export const defaultLayer = Layer.suspend(() =>
    layer.pipe(Layer.provide(Auth.defaultLayer), Layer.provide(Plugin.defaultLayer)),
  )
}
