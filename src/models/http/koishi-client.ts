import type { HTTP } from "koishi"
import { Effect, Layer, Redacted } from "effect"
import { ModelError } from "../model"
import { ModelHttp, type ModelHttpPostRequest, type ModelHttpRequest } from "./client"

const fetchJson = (http: HTTP, method: "GET" | "POST", request: ModelHttpRequest & { readonly body?: unknown }) =>
  Effect.tryPromise({
    try: async (signal) => {
      const response = await http<unknown>(method, request.url, {
        signal,
        redirect: "error",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${Redacted.value(request.apiKey)}`,
        },
        data: request.body,
        // 状态分类和正文解码由本边界完成，避免 HTTP 错误携带供应商正文。
        validateStatus: () => true,
        responseType: async (raw): Promise<unknown> => {
          if (!raw.ok) {
            await raw.body?.cancel()
            throw new ModelError({
              kind:
                raw.status === 401 || raw.status === 403
                  ? "Authentication"
                  : raw.status === 429
                    ? "RateLimit"
                    : "Http",
              status: raw.status,
            })
          }
          try {
            return await raw.json()
          } catch (error) {
            if (http.isError(error) && error.code === "ETIMEDOUT") throw error
            if (error instanceof Error && error.name === "AbortError") {
              throw new ModelError({ kind: "Timeout" })
            }
            throw new ModelError({ kind: "InvalidResponse" })
          }
        },
      })
      return response.data
    },
    catch: (error) =>
      error instanceof ModelError
        ? error
        : new ModelError({ kind: http.isError(error) && error.code === "ETIMEDOUT" ? "Timeout" : "Transport" }),
  })

export const ModelHttpKoishi = (http: HTTP) =>
  Layer.succeed(
    ModelHttp,
    ModelHttp.of({
      getJson: Effect.fn("ModelHttpKoishi.getJson")((request: ModelHttpRequest) =>
        fetchJson(http, "GET", request),
      ),
      postJson: Effect.fn("ModelHttpKoishi.postJson")((request: ModelHttpPostRequest) =>
        fetchJson(http, "POST", request),
      ),
    }),
  )
