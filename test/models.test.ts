import assert from "node:assert/strict"
import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import test, { type TestContext } from "node:test"
import { App, HTTP } from "koishi"
import { Cause, Effect, Exit, Fiber, Layer, Logger, ManagedRuntime, Option, Redacted } from "effect"
import { ModelGateway } from "../src/models/gateway"
import type { ModelInput } from "../src/models/model"
import { ModelGatewayDeepSeek } from "../src/models/deepseek/gateway"
import { ModelGatewayOpenAI } from "../src/models/openai/gateway"
import { ModelGatewayGemini } from "../src/models/gemini/gateway"
import { ModelHttp } from "../src/models/http/client"
import { listModels } from "../src/models/catalog"
import { ModelHttpKoishi } from "../src/models/http/koishi-client"
import { ModelGatewayRecorded } from "../src/models/records/recorded-gateway"
import { ModelTraceStore } from "../src/models/records/store"
import { notebookQueryTool } from "../src/dialogue/tools/notebook-query"
import { registerModelSchema, watchModelSchema } from "../src/runtime/model-schema"
import { Config, ModelSchemaName } from "../src/config/schema"
import { resolveModel } from "../src/config/resolve"

const fixture = async (
  t: TestContext,
  handle: (request: IncomingMessage, response: ServerResponse) => void,
  config: HTTP.Config = {},
) => {
  const server = createServer(handle)
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  assert.ok(address && typeof address !== "string")
  const app = new App()
  app.plugin(HTTP, config)
  await app.start()
  t.after(async () => {
    await app.stop()
    server.closeAllConnections()
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
  })
  return { app, baseUrl: `http://127.0.0.1:${address.port}` }
}

const readBody = async (request: IncomingMessage): Promise<unknown> => {
  const chunks: Buffer[] = []
  for await (const chunk of request) chunks.push(Buffer.from(chunk))
  return JSON.parse(Buffer.concat(chunks).toString("utf8"))
}
const json = (response: ServerResponse, body: unknown) => {
  response.setHeader("Content-Type", "application/json")
  response.end(JSON.stringify(body))
}
const completion = { choices: [{ finish_reason: "stop", message: { role: "assistant", content: "hello" } }] }
const key = Redacted.make("private-api-key")
const input: ModelInput = { messages: [{ role: "user", content: "hello" }] }
const generate = (model: Layer.Layer<ModelGateway, never, ModelHttp>, http: HTTP, request = input) =>
  Effect.gen(function* () {
    return yield* (yield* ModelGateway).generate(request)
  }).pipe(Effect.provide(model.pipe(Layer.provide(ModelHttpKoishi(http)))))

const errorKind = async <A>(effect: Effect.Effect<A, { readonly kind: string }>) => {
  const exit = await Effect.runPromiseExit(effect)
  assert.ok(Exit.isFailure(exit))
  const error = Cause.findErrorOption(exit.cause)
  assert.ok(Option.isSome(error))
  assert.ok(!JSON.stringify(error.value).includes("private-api-key"))
  assert.ok(!JSON.stringify(error.value).includes("provider-secret"))
  return error.value.kind
}

test("Chat Completions uses Koishi global HTTP headers and request hooks", async (t) => {
  const requests: {
    readonly url: string | undefined
    readonly headers: IncomingMessage["headers"]
    readonly body: unknown
  }[] = []
  const { app, baseUrl } = await fixture(
    t,
    (request, response) => {
      void readBody(request).then((body) => {
        requests.push({ url: request.url, headers: request.headers, body })
        json(response, completion)
      })
    },
    { headers: { "X-Global-Header": "configured" } },
  )
  app.on("http/fetch-init", (_url, init) => {
    const headers = new Headers(init.headers)
    headers.set("X-Global-Hook", "enabled")
    init.headers = headers
  })
  const result = await Effect.runPromise(
    generate(
      ModelGatewayDeepSeek({
        baseUrl,
        apiKey: key,
        model: "deepseek-chat",
        timeoutMs: 1000,
        temperature: 0.5,
        topP: 0.8,
      }),
      app.http,
    ),
  )
  assert.deepEqual(result, { text: "hello" })
  assert.equal(requests[0]?.url, "/chat/completions")
  assert.equal(requests[0]?.headers["x-global-header"], "configured")
  assert.equal(requests[0]?.headers["x-global-hook"], "enabled")
  assert.equal(requests[0]?.headers.authorization, "Bearer private-api-key")
  assert.deepEqual(requests[0]?.body, {
    model: "deepseek-chat",
    stream: false,
    temperature: 0.5,
    top_p: 0.8,
    messages: [{ role: "user", content: "hello" }],
  })
})

test("DeepSeek forwards reasoning settings from Koishi config and leaves omitted settings to the provider", async (t) => {
  const bodies: unknown[] = []
  const { app, baseUrl } = await fixture(t, (request, response) => {
    void readBody(request).then((body) => {
      bodies.push(body)
      json(response, completion)
    })
  })
  for (const reasoningEffort of [undefined, "none", "low", "high", "max"] as const) {
    const settings = reasoningEffort === undefined ? {} : { reasoningEffort, temperature: 0, topP: 0.9 }
    const raw = Config({
      models: {
        default: "deepseek/deepseek-v4-pro",
        deepseek: { baseUrl, apiKey: "private-api-key", ...settings },
      },
    })
    const resolved = await Effect.runPromise(resolveModel(raw.models))
    assert.equal(resolved.provider, "deepseek")
    const result = await Effect.runPromise(generate(ModelGatewayDeepSeek(resolved), app.http))
    assert.deepEqual(result, { text: "hello" })
    assert.deepEqual(bodies.at(-1), {
      model: "deepseek-v4-pro",
      stream: false,
      messages: input.messages,
      ...(reasoningEffort === undefined ? {} : { reasoning_effort: reasoningEffort, temperature: 0, top_p: 0.9 }),
    })
  }
})

test("DeepSeek maps output limits and stop sequences while rejecting token-truncated replies", async (t) => {
  const bodies: unknown[] = []
  let finishReason = "stop"
  const { app, baseUrl } = await fixture(t, (request, response) => {
    void readBody(request).then((body) => {
      bodies.push(body)
      json(response, { choices: [{ finish_reason: finishReason, message: { role: "assistant", content: "hello" } }] })
    })
  })
  for (const { settings, wire } of [
    { settings: {}, wire: {} },
    { settings: { stopSequences: [] }, wire: {} },
    {
      settings: { maxOutputTokens: 4096, stopSequences: ["\nEND\n", "结束"] },
      wire: { max_tokens: 4096, stop: ["\nEND\n", "结束"] },
    },
  ]) {
    const raw = Config({
      models: {
        default: "deepseek/deepseek-v4-pro",
        deepseek: { baseUrl, apiKey: "private-api-key", ...settings },
      },
    })
    const resolved = await Effect.runPromise(resolveModel(raw.models))
    assert.equal(resolved.provider, "deepseek")
    assert.deepEqual(await Effect.runPromise(generate(ModelGatewayDeepSeek(resolved), app.http)), { text: "hello" })
    assert.deepEqual(bodies.at(-1), {
      model: "deepseek-v4-pro",
      stream: false,
      messages: input.messages,
      ...wire,
    })
  }
  finishReason = "length"
  assert.equal(await errorKind(generate(ModelGatewayDeepSeek({
    baseUrl, apiKey: key, model: "deepseek-v4-pro", timeoutMs: 1000, maxOutputTokens: 1,
  }), app.http)), "IncompleteResponse")
  assert.deepEqual(bodies.at(-1), {
    model: "deepseek-v4-pro",
    stream: false,
    max_tokens: 1,
    messages: input.messages,
  })
})

test("DeepSeek preserves reasoning across tool rounds without exposing it in replies or call records", async (t) => {
  const bodies: unknown[] = []
  const traces: unknown[] = []
  const calls = [
    { id: "call-1", type: "function", function: { name: "lookup", arguments: "{}" } },
    { id: "call-2", type: "function", function: { name: "lookup", arguments: '{"query":"next"}' } },
  ]
  const responses = [
    { finish_reason: "tool_calls", message: {
      role: "assistant", content: null, reasoning_content: "provider-secret reasoning-1", tool_calls: [calls[0]],
    } },
    { finish_reason: "tool_calls", message: {
      role: "assistant", content: "checking", reasoning_content: "provider-secret reasoning-2", tool_calls: [calls[1]],
    } },
    { finish_reason: "stop", message: {
      role: "assistant", content: "done", reasoning_content: "provider-secret reasoning-final", tool_calls: null,
    } },
    { finish_reason: "stop", message: {
      role: "assistant", content: "next answer", reasoning_content: null,
    } },
  ]
  const { app, baseUrl } = await fixture(t, (request, response) => {
    void readBody(request).then((body) => {
      const next = responses[bodies.length]
      bodies.push(body)
      json(response, { choices: [next] })
    })
  })
  const model = ModelGatewayRecorded("deepseek-v4-pro").pipe(Layer.provide(Layer.merge(
    ModelGatewayDeepSeek({ baseUrl, apiKey: key, model: "deepseek-v4-pro", timeoutMs: 1000, reasoningEffort: "high" }),
    Layer.succeed(ModelTraceStore, ModelTraceStore.of({
      begin: (_model, request) => Effect.sync(() => {
        traces.push(request)
        return `trace-${traces.length}`
      }),
      finish: (_id, outcome) => Effect.sync(() => { traces.push(outcome) }),
    })),
  )))
  const tools = [{ name: "lookup", description: "lookup", parameters: { type: "object" } }] as const
  let messages: ModelInput["messages"] = [{ role: "system", content: "instructions" }, ...input.messages]
  for (let round = 0; round < 2; round++) {
    const result = await Effect.runPromise(generate(model, app.http, { messages, tools }))
    assert.ok(result.toolCalls)
    assert.ok(result.continuation)
    assert.ok(!JSON.stringify(result).includes("provider-secret"))
    messages = [
      ...messages,
      { role: "assistant", content: result.text, toolCalls: result.toolCalls, continuation: result.continuation },
      { role: "tool", toolCallId: result.toolCalls[0].id, content: `found-${round + 1}` },
    ]
  }
  const result = await Effect.runPromise(generate(model, app.http, { messages, tools }))
  assert.equal(result.text, "done")
  assert.equal(result.toolCalls, undefined)
  assert.ok(result.continuation)
  assert.ok(!JSON.stringify(result).includes("provider-secret"))
  const next = await Effect.runPromise(generate(model, app.http, {
    tools,
    messages: [
      ...messages,
      { role: "assistant", content: result.text, continuation: result.continuation },
      { role: "user", content: "next question" },
    ],
  }))
  assert.deepEqual(next, { text: "next answer" })
  assert.deepEqual(bodies[3], {
    model: "deepseek-v4-pro",
    stream: false,
    reasoning_effort: "high",
    tools: [{ type: "function", function: tools[0] }],
    messages: [
      { role: "system", content: "instructions" },
      { role: "user", content: "hello" },
      { role: "assistant", content: "", reasoning_content: "provider-secret reasoning-1", tool_calls: [calls[0]] },
      { role: "tool", tool_call_id: "call-1", content: "found-1" },
      { role: "assistant", content: "checking", reasoning_content: "provider-secret reasoning-2", tool_calls: [calls[1]] },
      { role: "tool", tool_call_id: "call-2", content: "found-2" },
      { role: "assistant", content: "done", reasoning_content: "provider-secret reasoning-final" },
      { role: "user", content: "next question" },
    ],
  })
  assert.equal(traces.length, 8)
  assert.ok(!JSON.stringify(traces).includes("provider-secret"))
  assert.ok(!JSON.stringify(traces).includes("reasoning_content"))
  assert.ok(!JSON.stringify(traces).includes("continuation"))
})

test("DeepSeek rejects malformed reasoning and continuation without leaking provider content", async (t) => {
  let requests = 0
  let reasoning: unknown
  const { app, baseUrl } = await fixture(t, (_request, response) => {
    requests++
    json(response, { choices: [{
      finish_reason: "stop",
      message: { role: "assistant", content: "done", reasoning_content: reasoning },
    }] })
  })
  const model = ModelGatewayDeepSeek({ baseUrl, apiKey: key, model: "deepseek-v4-pro", timeoutMs: 1000 })
  for (const invalid of [123, { secret: "provider-secret" }]) {
    reasoning = invalid
    assert.equal(await errorKind(generate(model, app.http)), "InvalidResponse")
  }
  const before = requests
  for (const invalid of [
    { api: "openai-responses", reasoning_content: "provider-secret" },
    { api: "chat-completions", reasoning_content: { secret: "provider-secret" } },
  ]) {
    assert.equal(await errorKind(generate(model, app.http, {
      messages: [{ role: "assistant", content: "previous answer", continuation: Redacted.make(invalid) }],
    })), "InvalidResponse")
  }
  assert.equal(requests, before)
})

test("OpenAI uses Responses, maps generation controls and omits unspecified options", async (t) => {
  const requests: { readonly url: string | undefined; readonly body: unknown }[] = []
  const { app, baseUrl } = await fixture(t, (request, response) => {
    void readBody(request).then((body) => {
      requests.push({ url: request.url, body })
      json(response, { status: "completed", output: [{
        type: "message", role: "assistant", status: "completed",
        content: [{ type: "output_text", text: "hello" }],
      }] })
    })
  })
  const cases: {
    readonly settings: NonNullable<Config["models"]["openai"]>
    readonly wire: object
  }[] = [
    {
      settings: { maxOutputTokens: 16, verbosity: "low", reasoningEffort: "high", reasoningMode: "pro", reasoningContext: "all_turns" },
      wire: { max_output_tokens: 16, text: { verbosity: "low" }, reasoning: { effort: "high", mode: "pro", context: "all_turns" } },
    },
    { settings: { reasoningMode: "standard" }, wire: { reasoning: { mode: "standard" } } },
    { settings: { reasoningContext: "current_turn" }, wire: { reasoning: { context: "current_turn" } } },
    { settings: { api: "responses" }, wire: {} },
    {
      settings: { verbosity: "high", reasoningContext: "auto" },
      wire: { text: { verbosity: "high" }, reasoning: { context: "auto" } },
    },
    { settings: {}, wire: {} },
  ]
  for (const { settings, wire } of cases) {
    const raw = Config({
      models: { default: "openai/gpt-test", openai: { baseUrl, apiKey: "private-api-key", ...settings } },
    })
    const resolved = await Effect.runPromise(resolveModel(raw.models))
    assert.equal(resolved.provider, "openai")
    assert.deepEqual(await Effect.runPromise(generate(ModelGatewayOpenAI(resolved), app.http)), { text: "hello" })
    assert.deepEqual(requests.at(-1), {
      url: "/responses",
      body: {
        model: "gpt-test",
        stream: false,
        store: false,
        input: input.messages,
        include: ["reasoning.encrypted_content"],
        ...wire,
      },
    })
  }
})

test("OpenAI rejects output-token truncation instead of returning partial text", async (t) => {
  const { app, baseUrl } = await fixture(t, (request, response) => {
    assert.equal(request.url, "/responses")
    json(response, {
      status: "incomplete",
      incomplete_details: { reason: "max_output_tokens" },
      output: [{
        type: "message", role: "assistant", status: "incomplete",
        content: [{ type: "output_text", text: "partial provider-secret" }],
      }],
    })
  })
  const model = ModelGatewayOpenAI({ baseUrl, apiKey: key, model: "gpt-test", timeoutMs: 1000, maxOutputTokens: 16 })
  assert.equal(await errorKind(generate(model, app.http)), "IncompleteResponse")
})

test("Responses preserves generation controls, tool calls and encrypted continuation through Koishi HTTP", async (t) => {
  const bodies: unknown[] = []
  const output = [
    { type: "reasoning", id: "reason-1", summary: [], encrypted_content: "opaque-provider-context" },
    { type: "function_call", call_id: "call-1", name: "lookup", arguments: "{}", status: "completed" },
  ]
  const { app, baseUrl } = await fixture(t, (request, response) => {
    void readBody(request).then((body) => {
      bodies.push(body)
      json(
        response,
        bodies.length === 1
          ? { status: "completed", output }
          : {
              status: "completed",
              output: [
                {
                  type: "message",
                  role: "assistant",
                  status: "completed",
                  content: [{ type: "output_text", text: "done" }],
                },
              ],
            },
      )
    })
  })
  const model = ModelGatewayOpenAI({
    baseUrl,
    apiKey: key,
    model: "gpt-test",
    timeoutMs: 1000,
    reasoningEffort: "low",
    maxOutputTokens: 4096,
    verbosity: "medium",
    reasoningMode: "pro",
    reasoningContext: "all_turns",
  })
  const toolInput: ModelInput = {
    ...input,
    tools: [{ name: "lookup", description: "lookup", parameters: { type: "object" } }],
  }
  const first = await Effect.runPromise(generate(model, app.http, toolInput))
  assert.ok(first.toolCalls)
  assert.ok(first.continuation)
  assert.ok(!JSON.stringify(first).includes("opaque-provider-context"))
  const second = await Effect.runPromise(
    generate(model, app.http, {
      ...toolInput,
      messages: [
        ...toolInput.messages,
        { role: "assistant", content: first.text, toolCalls: first.toolCalls, continuation: first.continuation },
        { role: "tool", toolCallId: "call-1", content: "found" },
      ],
    }),
  )
  assert.deepEqual(second, { text: "done" })
  assert.deepEqual(bodies[1], {
    model: "gpt-test",
    stream: false,
    store: false,
    reasoning: { effort: "low", mode: "pro", context: "all_turns" },
    max_output_tokens: 4096,
    text: { verbosity: "medium" },
    input: [
      { role: "user", content: "hello" },
      ...output,
      { type: "function_call_output", call_id: "call-1", output: "found" },
    ],
    include: ["reasoning.encrypted_content"],
    tools: [{ type: "function", name: "lookup", description: "lookup", parameters: { type: "object" }, strict: false }],
  })
})

test("provider status errors and malformed JSON are sanitized", async (t) => {
  let status = 401
  const { app, baseUrl } = await fixture(t, (_request, response) => {
    response.statusCode = status
    response.end("provider-secret private-api-key")
  })
  const model = ModelGatewayDeepSeek({ baseUrl, apiKey: key, model: "deepseek-chat", timeoutMs: 1000 })
  for (const [code, kind] of [
    [401, "Authentication"],
    [429, "RateLimit"],
    [500, "Http"],
    [200, "InvalidResponse"],
  ] as const) {
    status = code
    assert.equal(await errorKind(generate(model, app.http)), kind)
  }
})

test("Koishi global timeout remains active and maps to Timeout", async (t) => {
  const { app, baseUrl } = await fixture(t, () => {}, { timeout: 25 })
  assert.equal(
    await errorKind(
      generate(
        ModelGatewayDeepSeek({
          baseUrl,
          apiKey: key,
          model: "deepseek-chat",
          timeoutMs: 1000,
        }),
        app.http,
      ),
    ),
    "Timeout",
  )
})

test("model timeout cancels a response while its body is still being read", async (t) => {
  const { app, baseUrl } = await fixture(t, (_request, response) => {
    response.writeHead(200, { "Content-Type": "application/json" })
    response.write("{")
  })
  assert.equal(
    await errorKind(
      generate(
        ModelGatewayDeepSeek({
          baseUrl,
          apiKey: key,
          model: "deepseek-chat",
          timeoutMs: 25,
        }),
        app.http,
      ),
    ),
    "Timeout",
  )
})

test("Koishi global timeout also covers reading the response body", async (t) => {
  const { app, baseUrl } = await fixture(
    t,
    (_request, response) => {
      response.writeHead(200, { "Content-Type": "application/json" })
      response.write("{")
    },
    { timeout: 250 },
  )
  assert.equal(
    await errorKind(
      generate(
        ModelGatewayDeepSeek({
          baseUrl,
          apiKey: key,
          model: "deepseek-chat",
          timeoutMs: 1000,
        }),
        app.http,
      ),
    ),
    "Timeout",
  )
})

test("interrupting model work aborts the Koishi HTTP request", async (t) => {
  let markReceived = () => {}
  let markClosed = () => {}
  const received = new Promise<void>((resolve) => {
    markReceived = resolve
  })
  const closed = new Promise<void>((resolve) => {
    markClosed = resolve
  })
  const { app, baseUrl } = await fixture(t, (_request, response) => {
    response.on("close", markClosed)
    markReceived()
  })
  const fiber = Effect.runFork(
    generate(
      ModelGatewayDeepSeek({
        baseUrl,
        apiKey: key,
        model: "deepseek-chat",
        timeoutMs: 10000,
      }),
      app.http,
    ),
  )
  await received
  await Effect.runPromise(Fiber.interrupt(fiber))
  await closed
  const exit = await Effect.runPromise(Fiber.await(fiber))
  assert.ok(Exit.isFailure(exit))
  assert.ok(Cause.hasInterrupts(exit.cause))
})

test("model catalog lists provider models through Koishi HTTP", async (t) => {
  const { app, baseUrl } = await fixture(t, (request, response) => {
    assert.equal(request.method, "GET")
    assert.equal(request.url, "/models")
    assert.equal(request.headers.authorization, "Bearer private-api-key")
    json(response, { object: "list", data: [{ id: "deepseek-chat" }, { id: "deepseek-reasoner" }] })
  })
  const ids = await Effect.runPromise(
    Effect.gen(function* () {
      return yield* listModels(yield* ModelHttp, "deepseek", { apiKey: key, baseUrl })
    }).pipe(Effect.provide(ModelHttpKoishi(app.http))),
  )
  assert.deepEqual(ids, ["deepseek-chat", "deepseek-reasoner"])
})

test("model catalog reports provider authentication failures", async (t) => {
  const { app, baseUrl } = await fixture(t, (_request, response) => {
    response.statusCode = 401
    json(response, { error: { message: "provider-secret" } })
  })
  const kind = await errorKind(
    Effect.gen(function* () {
      return yield* listModels(yield* ModelHttp, "openai", { apiKey: key, baseUrl })
    }).pipe(Effect.provide(ModelHttpKoishi(app.http))),
  )
  assert.equal(kind, "Authentication")
})

const geminiResponse = (parts: readonly unknown[], finishReason = "STOP") => ({
  candidates: [{ finishReason, content: { role: "model", parts } }],
})

test("Gemini uses native generation, system instructions and API-key headers through Koishi HTTP", async (t) => {
  const bodies: unknown[] = []
  const { app, baseUrl } = await fixture(t, (request, response) => {
    assert.equal(request.method, "POST")
    assert.equal(request.url, "/v1beta/models/gemini-test:generateContent")
    assert.equal(request.headers["x-goog-api-key"], "private-api-key")
    assert.equal(request.headers.authorization, undefined)
    assert.equal(request.headers["x-global-header"], "configured")
    void readBody(request).then((body) => {
      bodies.push(body)
      json(response, geminiResponse([
        { text: "provider-secret", thought: true },
        { text: "hel", thoughtSignature: "opaque-provider-context" },
        { text: "lo" },
      ]))
    })
  }, { headers: { "X-Global-Header": "configured" } })
  const settings = Config({
    models: {
      default: "gemini/models/gemini-test",
      gemini: {
        baseUrl: `${baseUrl}/v1beta/`,
        apiKey: Redacted.value(key),
        timeoutMs: 1000,
        thinkingLevel: "xhigh",
        maxOutputTokens: 65536,
        stopSequences: ["<end>"],
        seed: 0,
        presencePenalty: 0,
        frequencyPenalty: -0.5,
        safetySettings: [{ category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_ONLY_HIGH" }],
      },
    },
  })
  const selected = await Effect.runPromise(resolveModel(settings.models))
  assert.equal(selected.provider, "gemini")
  const result = await Effect.runPromise(generate(
    ModelGatewayGemini(selected),
    app.http,
    {
      messages: [
        { role: "system", content: "roleplay" },
        { role: "system", content: "instructions" },
        { role: "user", content: "earlier" },
        { role: "assistant", content: "previous reply" },
        ...input.messages,
      ],
    },
  ))
  assert.deepEqual(result, { text: "hello" })
  assert.deepEqual(bodies, [{
    systemInstruction: { parts: [{ text: "roleplay" }, { text: "instructions" }] },
    contents: [
      { role: "user", parts: [{ text: "earlier" }] },
      { role: "model", parts: [{ text: "previous reply" }] },
      { role: "user", parts: [{ text: "hello" }] },
    ],
    generationConfig: {
      thinkingConfig: { thinkingLevel: "XHIGH" },
      maxOutputTokens: 65536,
      stopSequences: ["<end>"],
      seed: 0,
      presencePenalty: 0,
      frequencyPenalty: -0.5,
    },
    safetySettings: [{ category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_ONLY_HIGH" }],
  }])
})

test("Gemini preserves signed parts and matches parallel tool results across multiple rounds", async (t) => {
  const bodies: { contents: unknown[]; tools: unknown; generationConfig: unknown; safetySettings?: unknown }[] = []
  const parts = [
    { text: "provider-secret", thought: true },
    { text: "checking", thoughtSignature: "text-signature" },
    {
      functionCall: { name: "notebook-query", args: { queries: [{ keyword: "first", offset: 0, limit: 1 }] } },
      thoughtSignature: "opaque-provider-context",
    },
    { functionCall: { id: "provider-call-id", name: "notebook-query", args: { queries: [] } } },
  ]
  const nextParts = [{ functionCall: { name: "notebook-query" }, thoughtSignature: "next-signature" }]
  const { app, baseUrl } = await fixture(t, (request, response) => {
    void readBody(request).then((body) => {
      bodies.push(body as typeof bodies[number])
      json(response, geminiResponse(bodies.length === 1 ? parts : bodies.length === 2 ? nextParts : [{ text: "done" }]))
    })
  })
  const selected = await Effect.runPromise(resolveModel(Config({
    models: {
      default: "gemini/gemini-test",
      gemini: { baseUrl, apiKey: Redacted.value(key), timeoutMs: 1000 },
    },
  }).models))
  assert.equal(selected.provider, "gemini")
  const model = ModelGatewayGemini(selected)
  const toolInput: ModelInput = { ...input, tools: [notebookQueryTool] }
  const first = await Effect.runPromise(generate(model, app.http, toolInput))
  assert.equal(first.text, "checking")
  assert.ok(first.toolCalls && first.continuation)
  assert.equal(first.toolCalls.length, 2)
  assert.equal(first.toolCalls[1]?.id, "provider-call-id")
  assert.deepEqual(JSON.parse(first.toolCalls[0].arguments), { queries: [{ keyword: "first", offset: 0, limit: 1 }] })
  assert.ok(!JSON.stringify(first).includes("provider-secret"))
  assert.ok(!JSON.stringify(first).includes("opaque-provider-context"))
  const secondInput: ModelInput = {
    ...toolInput,
    messages: [
      ...toolInput.messages,
      { role: "assistant", content: first.text, toolCalls: first.toolCalls, continuation: first.continuation },
      ...first.toolCalls.map((call) => ({ role: "tool" as const, toolCallId: call.id, content: `result ${call.id}` })),
    ],
  }
  const second = await Effect.runPromise(generate(model, app.http, secondInput))
  assert.ok(second.toolCalls && second.continuation)
  assert.notEqual(second.toolCalls[0].id, first.toolCalls[0].id)
  assert.equal(second.toolCalls[0].arguments, "{}")
  const third = await Effect.runPromise(generate(model, app.http, {
    ...secondInput,
    messages: [
      ...secondInput.messages,
      { role: "assistant", content: second.text, toolCalls: second.toolCalls, continuation: second.continuation },
      { role: "tool", toolCallId: second.toolCalls[0].id, content: "last result" },
    ],
  }))
  assert.deepEqual(third, { text: "done" })
  for (const body of bodies) {
    assert.deepEqual(body.generationConfig, {})
    assert.equal(body.safetySettings, undefined)
  }
  assert.deepEqual(bodies[0]?.tools, [{
    functionDeclarations: [{
      name: notebookQueryTool.name,
      description: notebookQueryTool.description,
      parametersJsonSchema: notebookQueryTool.parameters,
    }],
  }])
  assert.deepEqual(bodies[1]?.contents, [
    { role: "user", parts: [{ text: "hello" }] },
    { role: "model", parts },
    {
      role: "user",
      parts: [
        { functionResponse: { name: "notebook-query", response: { output: `result ${first.toolCalls[0].id}` } } },
        {
          functionResponse: {
            name: "notebook-query",
            id: "provider-call-id",
            response: { output: "result provider-call-id" },
          },
        },
      ],
    },
  ])
  assert.deepEqual(bodies[2]?.contents, [
    ...bodies[1]!.contents,
    { role: "model", parts: nextParts },
    { role: "user", parts: [{ functionResponse: { name: "notebook-query", response: { output: "last result" } } }] },
  ])
})

test("Gemini rejects incomplete, blocked and malformed responses without exposing provider content", async (t) => {
  let body: unknown
  const { app, baseUrl } = await fixture(t, (_request, response) => json(response, body))
  const model = ModelGatewayGemini({ baseUrl, apiKey: key, model: "gemini-test", timeoutMs: 1000 })
  const toolInput: ModelInput = { ...input, tools: [notebookQueryTool] }
  for (const [response, kind] of [
    [geminiResponse([{ text: "provider-secret" }], "MAX_TOKENS"), "IncompleteResponse"],
    [{ promptFeedback: { blockReason: "SAFETY" } }, "IncompleteResponse"],
    [{ candidates: [{ finishReason: "SAFETY" }] }, "IncompleteResponse"],
    [{ candidates: [] }, "InvalidResponse"],
    [geminiResponse([{ text: " " }]), "InvalidResponse"],
    [geminiResponse([{ text: "provider-secret", thought: true }]), "InvalidResponse"],
    [geminiResponse([{ inlineData: { data: "provider-secret" } }]), "InvalidResponse"],
    [geminiResponse([{ functionCall: { name: "unknown", args: {} } }]), "InvalidResponse"],
    [geminiResponse([{ functionCall: { name: "notebook-query", args: "provider-secret" } }]), "InvalidResponse"],
    [geminiResponse([
      { functionCall: { id: "same", name: "notebook-query", args: {} } },
      { functionCall: { id: "same", name: "notebook-query", args: {} } },
    ]), "InvalidResponse"],
  ] as const) {
    body = response
    assert.equal(await errorKind(generate(model, app.http, toolInput)), kind)
  }
  body = geminiResponse([{ functionCall: { name: "notebook-query", args: {} } }])
  assert.equal(await errorKind(generate(model, app.http)), "IncompleteResponse")
})

test("Gemini model catalog paginates, filters generation models and registers dropdown options", async (t) => {
  const requests: string[] = []
  const { app, baseUrl } = await fixture(t, (request, response) => {
    assert.equal(request.method, "GET")
    assert.equal(request.headers["x-goog-api-key"], "private-api-key")
    assert.equal(request.headers.authorization, undefined)
    requests.push(request.url!)
    json(response, requests.length === 1 ? {
      models: [
        { name: "models/gemini-first", supportedGenerationMethods: ["countTokens", "generateContent"] },
        { name: "models/embedding", supportedGenerationMethods: ["embedContent"] },
      ],
      nextPageToken: "page+/=&",
    } : { models: [{ name: "models/gemini-second", supportedGenerationMethods: ["generateContent"] }] })
  })
  await Effect.runPromise(registerModelSchema(app, {
    default: "gemini/current",
    gemini: { apiKey: Redacted.value(key), baseUrl: `${baseUrl}/v1beta` },
  }).pipe(Effect.provide(ModelHttpKoishi(app.http))))
  assert.deepEqual(requests, ["/v1beta/models", "/v1beta/models?pageToken=page%2B%2F%3D%26"])
  const schema = app.schema.get(ModelSchemaName)
  assert.ok(schema)
  const options = JSON.stringify(schema)
  for (const name of ["gemini/current", "gemini/gemini-first", "gemini/gemini-second"])
    assert.ok(options.includes(name))
  assert.ok(!options.includes("embedding"))
})

test("Gemini total timeout aborts the native HTTP response", async (t) => {
  let markClosed = () => {}
  const closed = new Promise<void>((resolve) => { markClosed = resolve })
  const { app, baseUrl } = await fixture(t, (_request, response) => {
    response.on("close", markClosed)
    response.writeHead(200, { "Content-Type": "application/json" })
    response.write("{")
  })
  assert.equal(await errorKind(generate(
    ModelGatewayGemini({ baseUrl, apiKey: key, model: "gemini-test", timeoutMs: 100 }),
    app.http,
  )), "Timeout")
  await closed
})

test("reactive catalog updates discover new credentials and cancel obsolete or disposed requests", { timeout: 10000 }, async (t) => {
  const deferred = () => {
    let resolve = () => {}
    const promise = new Promise<void>((complete) => { resolve = complete })
    return { promise, resolve }
  }
  let received = deferred()
  let closed = deferred()
  const { app, baseUrl } = await fixture(t, (request, response) => {
    if (request.url === "/openai/models") return json(response, { data: [{ id: "available" }] })
    if (request.url === "/old/models") {
      response.on("close", closed.resolve)
      received.resolve()
      return
    }
    assert.equal(request.url, "/new/models")
    assert.equal(request.headers["x-goog-api-key"], "updated-key")
    json(response, { models: [{ name: "models/new-model", supportedGenerationMethods: ["generateContent"] }] })
  })
  const options = () => (app.schema.get(ModelSchemaName).list ?? []).map((option) => option.value as string)
  const waitForOptions = (expected: readonly string[]) => {
    if (JSON.stringify(options()) === JSON.stringify(expected)) return Promise.resolve()
    return new Promise<void>((resolve) => {
      const dispose = app.on("internal/schema", (name) => {
        if (name !== ModelSchemaName || JSON.stringify(options()) !== JSON.stringify(expected)) return
        dispose()
        resolve()
      })
    })
  }
  let starts = 0
  const plugin = {
    name: "catalog-fixture",
    reactive: true,
    Config,
    apply: async (ctx: App, config: Config) => {
      starts++
      const runtime = ManagedRuntime.make(Layer.effectDiscard(
        watchModelSchema(ctx, config.models).pipe(Effect.provide(ModelHttpKoishi(ctx.http))),
      ))
      ctx.on("dispose", () => runtime.dispose())
      await runtime.runPromise(Effect.void)
    },
  }
  const config = Config({
    models: {
      default: "openai/current",
      openai: { baseUrl: `${baseUrl}/openai`, apiKey: "private-api-key" },
    },
  })
  const fork = app.plugin(plugin, config)
  assert.ok(fork)
  const original = ["openai/current", "openai/available"]
  await waitForOptions(original)
  const withGemini = (path: string, apiKey: string) => ({
    ...config,
    models: { ...config.models, gemini: { baseUrl: `${baseUrl}/${path}`, apiKey } },
  })
  fork.update(withGemini("old", "old-key"))
  await received.promise
  fork.update(withGemini("new", "updated-key"))
  await closed.promise
  await waitForOptions([...original, "gemini/new-model"])
  assert.equal(starts, 1)
  fork.update(config)
  await waitForOptions(original)

  received = deferred()
  closed = deferred()
  fork.update(withGemini("old", "old-key"))
  await received.promise
  fork.dispose()
  await closed.promise
  await app.lifecycle.flush()
  assert.equal(starts, 1)
  assert.deepEqual(options(), [])
})

test("catalog failures log sanitized diagnostics while preserving other providers and the selected model", async (t) => {
  const logs: unknown[] = []
  const { app, baseUrl } = await fixture(t, (request, response) => {
    if (request.url === "/openai/models") return json(response, { data: [{ id: "available" }] })
    response.statusCode = 403
    json(response, { error: { message: "provider-secret private-api-key" } })
  })
  await Effect.runPromise(registerModelSchema(app, {
    default: "gemini/current",
    gemini: { baseUrl, apiKey: "private-api-key" },
    openai: { baseUrl: `${baseUrl}/openai`, apiKey: "private-api-key" },
  }).pipe(
    Effect.provide(ModelHttpKoishi(app.http)),
    Effect.provide(Logger.layer([Logger.make(({ message }) => { logs.push(message) })])),
  ))
  assert.deepEqual(app.schema.get(ModelSchemaName).list?.map((option) => option.value), ["gemini/current", "openai/available"])
  const messages = JSON.stringify(logs)
  assert.ok(messages.includes("gemini"))
  assert.ok(messages.includes("Authentication HTTP 403"))
  assert.ok(!messages.includes("private-api-key"))
  assert.ok(!messages.includes("provider-secret"))
})
