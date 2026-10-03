import {
  CommandId,
  ThreadId,
  type ProviderInstanceId,
  type OrchestrationV2ThreadGoal,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProviderSessionManager from "./ProviderSessionManager.ts";
import * as ProviderEventIngestor from "./ProviderEventIngestor.ts";
import * as IdAllocator from "./IdAllocator.ts";
import * as RuntimePolicy from "./RuntimePolicy.ts";
import * as EventSink from "./EventSink.ts";
import * as ThreadCommandExecutor from "./ThreadCommandExecutor.ts";
import type { OrchestrationEffectRequestV2 } from "./EffectOutbox.ts";

export class ThreadGoalError extends Schema.TaggedError<ThreadGoalError>()("ThreadGoalError", {
  threadId: ThreadId,
  cause: Schema.Defect(),
}) {}

export class ThreadGoalService extends Context.Service<
  ThreadGoalService,
  {
    readonly execute: (input: {
      readonly commandId: CommandId;
      readonly willRetry: boolean;
      readonly requestedAt: DateTime.Utc;
      readonly previousGoal?: OrchestrationV2ThreadGoal | null;
      readonly threadId: ThreadId;
      readonly providerInstanceId: ProviderInstanceId;
      readonly operation: Extract<
        OrchestrationEffectRequestV2,
        { type: "thread-goal.update" }
      >["operation"];
    }) => Effect.Effect<void, ThreadGoalError>;
  }
>()("t3/orchestration-v2/ThreadGoalService") {}

const make = Effect.gen(function* () {
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const sessions = yield* ProviderSessionManager.ProviderSessionManagerV2;
  const ingestor = yield* ProviderEventIngestor.ProviderEventIngestorV2;
  const ids = yield* IdAllocator.IdAllocatorV2;
  const policies = yield* RuntimePolicy.RuntimePolicyV2;
  const sink = yield* EventSink.EventSinkV2;
  const executor = yield* ThreadCommandExecutor.ThreadCommandExecutor;

  const finish = (threadId: ThreadId, requestId: CommandId, error?: string) =>
    executor.withLock(
      threadId,
      Effect.gen(function* () {
        const thread = yield* projections.getThread(threadId);
        if (thread.deletedAt !== null || thread.goalOperation?.requestId !== requestId) return;
        yield* sink.write({
          events: [
            {
              id: yield* ids.allocate.event({ threadId }),
              type: "thread.goal-updated",
              threadId,
              providerInstanceId: thread.providerInstanceId,
              occurredAt: yield* DateTime.now,
              payload: {
                ...thread,
                goalOperation: error === undefined ? null : { requestId, status: "failed", error },
              },
            },
          ],
        });
      }),
    );

  const execute: ThreadGoalService["Service"]["execute"] = Effect.fn("ThreadGoalService.execute")(
    function* (input) {
      const projection = yield* projections.getThreadRecords(input.threadId, [
        "providerThreads",
        "providerSessions",
      ]);
      const { thread } = projection;
      // Do not apply a queued native operation to a replacement provider.
      if (thread.deletedAt !== null || thread.providerInstanceId !== input.providerInstanceId)
        return;
      const previous = projection.providerThreads.find(
        (candidate) => candidate.id === thread.activeProviderThreadId,
      );
      if (input.operation.type === "refresh" && previous?.nativeThreadRef == null) return;
      const providerSessionId =
        previous?.providerSessionId ??
        ids.derive.providerSession({ providerInstanceId: input.providerInstanceId });
      const runtimePolicy = yield* policies.resolve({
        thread,
        modelSelection: thread.modelSelection,
      });
      const resumeFromSession = projection.providerSessions.find(
        (candidate) => candidate.id === providerSessionId,
      );
      const session = yield* sessions.open({
        threadId: thread.id,
        providerSessionId,
        modelSelection: thread.modelSelection,
        runtimePolicy,
        ...(resumeFromSession === undefined ? {} : { resumeFromSession }),
        ...(previous?.nativeThreadRef?.nativeId == null
          ? {}
          : { initialNativeThreadId: previous.nativeThreadRef.nativeId }),
      });
      if (
        session.getGoal === undefined ||
        session.setGoal === undefined ||
        session.clearGoal === undefined
      ) {
        return yield* new ThreadGoalError({
          threadId: thread.id,
          cause: "This provider does not support native Goals.",
        });
      }
      const providerThread =
        previous?.nativeThreadRef == null
          ? yield* session.ensureThread({
              configureForGoal: true,
              threadId: thread.id,
              modelSelection: thread.modelSelection,
              runtimePolicy,
              providerSessionId,
              ...(previous === undefined ? {} : { existingProviderThread: previous }),
            })
          : input.operation.type === "clear" ||
              (input.operation.type === "set" && input.operation.status === "paused")
            ? { ...previous, providerSessionId }
            : yield* session.resumeThread({
                configureForGoal: true,
                providerThread: previous,
                threadId: thread.id,
                modelSelection: thread.modelSelection,
                runtimePolicy,
              });
      // Provider I/O must not hold the thread command lock: its notifications
      // use the same lock. Revalidate and merge the binding under that lock.
      yield* executor.withLock(
        thread.id,
        Effect.gen(function* () {
          const current = yield* projections.getThreadRecords(thread.id, ["providerThreads"]);
          if (
            current.thread.deletedAt !== null ||
            current.thread.providerInstanceId !== input.providerInstanceId ||
            current.thread.activeProviderThreadId !== thread.activeProviderThreadId
          ) {
            return yield* new ThreadGoalError({
              threadId: thread.id,
              cause: "The provider binding changed while preparing the Goal.",
            });
          }
          const recorded = current.providerThreads.find(
            (candidate) => candidate.id === providerThread.id,
          );
          yield* sink.write({
            events: [
              {
                id: yield* ids.allocate.event({ threadId: thread.id }),
                type: "provider-thread.updated",
                threadId: thread.id,
                providerInstanceId: input.providerInstanceId,
                occurredAt: providerThread.updatedAt,
                payload:
                  recorded === undefined
                    ? providerThread
                    : {
                        ...recorded,
                        providerSessionId: providerThread.providerSessionId,
                        nativeThreadRef: providerThread.nativeThreadRef,
                      },
              },
            ],
          });
        }),
      );
      const currentGoal =
        input.operation.type === "set" && input.operation.status === "active"
          ? yield* session.getGoal(providerThread)
          : undefined;
      const native = currentGoal?.goal;
      // A replayed activation must not revive work Codex already finished,
      // blocked or limited after this command. The endpoint has no idempotency key.
      const settledActivation =
        native != null &&
        native.status !== "active" &&
        native.status !== "paused" &&
        input.operation.type === "set" &&
        native.updatedAt >=
          DateTime.formatIso(
            DateTime.makeUnsafe(
              Math.floor(DateTime.toEpochMillis(input.requestedAt) / 1000) * 1000,
            ),
          ) &&
        (input.previousGoal == null ||
          native.updatedAt !== input.previousGoal.updatedAt ||
          native.tokensUsed !== input.previousGoal.tokensUsed ||
          native.timeUsedSeconds !== input.previousGoal.timeUsedSeconds ||
          native.status !== input.previousGoal.status ||
          native.objective !== input.previousGoal.objective ||
          native.tokenBudget !== input.previousGoal.tokenBudget) &&
        (input.operation.objective === undefined ||
          input.operation.objective === native.objective) &&
        (input.operation.tokenBudget == null || input.operation.tokenBudget === native.tokenBudget);
      const event =
        settledActivation && currentGoal !== undefined
          ? currentGoal
          : input.operation.type === "clear"
            ? yield* session.clearGoal(providerThread)
            : input.operation.type === "set"
              ? yield* session.setGoal(providerThread, input.operation)
              : yield* session.getGoal(providerThread);
      const currentSession = yield* sessions.get(providerSessionId);
      if (Option.isNone(currentSession) || currentSession.value !== session) {
        return yield* new ThreadGoalError({
          threadId: thread.id,
          cause: "The provider session changed during the Goal update.",
        });
      }
      yield* ingestor.ingestNormalized({
        providerSessionId,
        providerInstanceId: input.providerInstanceId,
        threadId: thread.id,
        event,
      });
      yield* finish(thread.id, input.commandId);
    },
    (effect, input) =>
      effect.pipe(
        Effect.catch((cause) =>
          Effect.gen(function* () {
            if (!input.willRetry)
              yield* finish(
                input.threadId,
                input.commandId,
                cause instanceof Error ? cause.message : "Native Goal update failed.",
              );
            return yield* new ThreadGoalError({ threadId: input.threadId, cause });
          }),
        ),
        Effect.mapError((cause) => new ThreadGoalError({ threadId: input.threadId, cause })),
      ),
  );

  return ThreadGoalService.of({ execute });
});

export const layer = Layer.effect(ThreadGoalService, make);
