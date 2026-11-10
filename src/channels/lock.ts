import { Effect, Ref, Semaphore } from "effect"

// 引用计数包含执行者与等待者；最后一个使用者退出后回收，取消等待也会释放引用。
export const makeChannelLock = Effect.gen(function* () {
  const entries = yield* Ref.make<ReadonlyMap<string, { readonly lock: Semaphore.Semaphore; readonly users: number }>>(
    new Map(),
  )
  return <A, E, R>(id: string, task: Effect.Effect<A, E, R>) =>
    Effect.acquireUseRelease(
      Ref.modify(entries, (current) => {
        const entry = current.get(id) ?? { lock: Semaphore.makeUnsafe(1), users: 0 }
        return [entry.lock, new Map(current).set(id, { ...entry, users: entry.users + 1 })] as const
      }),
      (lock) => lock.withPermit(task),
      () =>
        Ref.update(entries, (current) => {
          const entry = current.get(id)!
          const next = new Map(current)
          if (entry.users === 1) next.delete(id)
          else next.set(id, { ...entry, users: entry.users - 1 })
          return next
        }),
    )
})
