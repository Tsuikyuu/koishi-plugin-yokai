import assert from "node:assert/strict"
import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import test, { type TestContext } from "node:test"
import { App, HTTP } from "koishi"
import { Cause, Effect, Exit, Fiber, Layer, Option, Redacted } from "effect"
import { ModelGateway } from "../src/models/gateway"
import type { ModelInput } from "../src/models/model"
import { ModelGatewayDeepSeek } from "../src/models/deepseek/gateway"
import { ModelGatewayOpenAI } from "../src/models/openai/gateway"
import { ModelHttp } from "../src/models/http/client"
import { listModels } from "../src/models/catalog"
import { ModelHttpKoishi } from "../src/models/http/koishi-client"

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
