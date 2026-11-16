import assert from "node:assert/strict"
import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import test, { type TestContext } from "node:test"
import { App, HTTP } from "koishi"
import { Cause, Effect, Exit, Fiber, Layer, Option, Redacted } from "effect"
import { ModelGateway } from "../src/models/gateway"
import type { ModelInput } from "../src/models/model"
import { ModelGatewayDeepSeek } from "../src/models/deepseek/gateway"
import { ModelGatewayOpenAI } from "../src/models/openai/gateway"
import { ModelGatewayGemini } from "../src/models/gemini/gateway"
import { ModelHttp } from "../src/models/http/client"
import { listModels } from "../src/models/catalog"
import { ModelHttpKoishi } from "../src/models/http/koishi-client"
import { notebookQueryTool } from "../src/dialogue/tools/notebook-query"
import { registerModelSchema } from "../src/runtime/model-schema"
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

test("Responses preserves tool calls and encrypted continuation through Koishi HTTP", async (t) => {
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
    api: "responses",
    timeoutMs: 1000,
    reasoningEffort: "low",
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
    reasoning: { effort: "low" },
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
