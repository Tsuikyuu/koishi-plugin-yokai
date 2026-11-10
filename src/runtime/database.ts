import { Layer, type Semaphore } from "effect"
import type { Context } from "koishi"
import { SchedulerLive } from "../scheduling/scheduler-layer"
import { channelStoreLayer } from "../channels/koishi-store"
import { notebookStoreLayer } from "../notebook/koishi-store"
import { scheduleStoreLayer } from "../scheduling/koishi-store"

export const databaseLayer = (database: Context["database"], serialize: Semaphore.Semaphore["withPermit"]) => {
  const schedules = scheduleStoreLayer(database, serialize)
  return Layer.mergeAll(
    channelStoreLayer(database, serialize),
    notebookStoreLayer(database, serialize),
    SchedulerLive.pipe(Layer.provideMerge(schedules)),
  )
}
