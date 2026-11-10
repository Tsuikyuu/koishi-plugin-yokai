import { Cause, Duration, Effect, Exit, Layer, Option } from "effect"
import { ModelError } from "../model"
import { ModelGateway } from "../gateway"
import { ModelTraceStore, type ModelTraceOutcome } from "./store"

// 装饰已提供的 ModelGateway；不依赖文件系统或具体供应商。
export const ModelGatewayRecorded = (modelName: string) =>
  Layer.effect(
    ModelGateway,
    Effect.gen(function* () {
      const gateway = yield* ModelGateway
      const traces = yield* ModelTraceStore
      return ModelGateway.of({
        generate: (input) =>
          Effect.uninterruptibleMask((restore) =>
            Effect.gen(function* () {
              const visibleInput = {
                ...input,
                messages: input.messages.map((message) => {
                  if (message.role !== "assistant") return message
                  const { continuation: _continuation, ...visible } = message
                  return visible
                }),
              }
              const id = yield* traces
                .begin(modelName, visibleInput)
                .pipe(Effect.mapError(() => new ModelError({ kind: "Recording" })))
              yield* Effect.logDebug(`请求模型 ${modelName}，调用记录 ${id}`)
              const [duration, exit] = yield* Effect.timed(Effect.exit(restore(gateway.generate(input))))
              let outcome: ModelTraceOutcome
              if (Exit.isSuccess(exit)) {
                const { continuation: _continuation, ...visible } = exit.value
                outcome = { status: "success", output: visible }
              } else {
                const error = Cause.findErrorOption(exit.cause)
                outcome = Option.isSome(error)
                  ? {
                      status: "failed",
                      error: {
                        kind: error.value.kind,
                        ...(error.value.status === undefined ? {} : { status: error.value.status }),
                      },
                    }
                  : { status: Cause.hasInterrupts(exit.cause) ? "interrupted" : "defect" }
              }
              // 取消时也完成结果落盘；只保护本地记录，不屏蔽模型请求的取消。
              yield* traces.finish(id, outcome).pipe(Effect.mapError(() => new ModelError({ kind: "Recording" })))
              yield* Effect.logDebug(
                `模型调用结束 ${outcome.status}${outcome.status === "failed" ? `（${outcome.error.kind}${outcome.error.status === undefined ? "" : ` ${outcome.error.status}`}）` : ""}，耗时 ${Math.round(Duration.toMillis(duration))}ms，调用记录 ${id}`,
              )
              if (Exit.isFailure(exit)) return yield* Effect.failCause(exit.cause)
              return exit.value
            }),
          ),
      })
    }),
  )
