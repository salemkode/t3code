import type { EnvironmentId, OrchestrationV2AppThread } from "@t3tools/contracts";
import { useEffect, useState } from "react";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Textarea } from "../ui/textarea";
import { threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";

const statusLabels = {
  active: "Active",
  paused: "Paused",
  blocked: "Blocked",
  usageLimited: "Usage limited",
  budgetLimited: "Budget limited",
  complete: "Complete",
};

export function ThreadGoal({
  thread,
  environmentId,
  supportsTokenBudget,
}: {
  thread: OrchestrationV2AppThread;
  environmentId: EnvironmentId;
  supportsTokenBudget: boolean;
}) {
  const updateGoal = useAtomCommand(threadEnvironment.updateGoal);
  const [editing, setEditing] = useState(false);
  const [objective, setObjective] = useState("");
  const [budget, setBudget] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const goal = thread.goal ?? null;
  useEffect(() => {
    void updateGoal({
      environmentId,
      input: { threadId: thread.id, operation: { type: "refresh" } },
    });
  }, [environmentId, thread.id, updateGoal]);

  const submit = async (operation: Parameters<typeof updateGoal>[0]["input"]["operation"]) => {
    setSubmitting(true);
    const result = await updateGoal({ environmentId, input: { threadId: thread.id, operation } });
    setSubmitting(false);
    if (result._tag === "Success") setEditing(false);
  };
  const edit = () => {
    setObjective(goal?.objective ?? "");
    setBudget(goal?.tokenBudget?.toString() ?? "");
    setEditing(true);
  };
  const pending = submitting || thread.goalOperation?.status === "pending";
  const validBudget =
    budget === "" ||
    (/^\d+$/.test(budget) && Number.isSafeInteger(Number(budget)) && Number(budget) > 0);

  return (
    <section
      aria-label="Codex Goal"
      className="shrink-0 border-b px-(--workspace-gutter-start) py-2 text-sm"
    >
      {editing ? (
        <form
          className="flex flex-col gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            if (objective.trim() === "" || !validBudget) return;
            void submit({
              type: "set",
              objective: objective.trim(),
              ...(goal === null ? { status: "active" } : {}),
              ...(supportsTokenBudget && budget !== "" ? { tokenBudget: Number(budget) } : {}),
            });
          }}
        >
          <label className="flex flex-col gap-1">
            Goal objective
            <Textarea
              autoFocus
              value={objective}
              onChange={(event) => setObjective(event.target.value)}
              disabled={pending}
            />
          </label>
          {supportsTokenBudget ? (
            <label className="flex items-center gap-2">
              Token budget
              <Input
                className="w-40"
                inputMode="numeric"
                type="number"
                min="1"
                step="1"
                placeholder={goal?.tokenBudget == null ? "No limit" : "Keep current budget"}
                value={budget}
                onChange={(event) => setBudget(event.target.value)}
                disabled={pending}
              />
            </label>
          ) : null}
          <div className="flex gap-2">
            <Button
              size="sm"
              type="submit"
              disabled={pending || objective.trim() === "" || !validBudget}
            >
              {goal === null ? "Create Goal" : "Save"}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              type="button"
              disabled={pending}
              onClick={() => setEditing(false)}
            >
              Cancel
            </Button>
          </div>
        </form>
      ) : goal === null ? (
        <Button size="sm" variant="ghost" disabled={pending} onClick={edit}>
          Create Goal
        </Button>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-medium">Goal</span>
          <span role="status" className="text-xs text-muted-foreground">
            {statusLabels[goal.status]}
          </span>
          <p className="min-w-0 basis-full whitespace-pre-wrap break-words">{goal.objective}</p>
          <span className="text-xs text-muted-foreground">
            {goal.timeUsedSeconds === null
              ? null
              : `${goal.timeUsedSeconds.toLocaleString()}s elapsed`}
            {goal.tokensUsed === null ? null : ` · ${goal.tokensUsed.toLocaleString()} tokens`}
            {goal.tokenBudget === null ? null : ` / ${goal.tokenBudget.toLocaleString()} budget`}
          </span>
          <div className="ml-auto flex gap-1">
            <Button size="sm" variant="ghost" disabled={pending} onClick={edit}>
              Edit
            </Button>
            {goal.status === "active" ? (
              <Button
                size="sm"
                variant="ghost"
                disabled={pending}
                onClick={() => void submit({ type: "set", status: "paused" })}
              >
                Pause
              </Button>
            ) : (
              <Button
                size="sm"
                variant="ghost"
                disabled={pending}
                onClick={() => void submit({ type: "set", status: "active" })}
              >
                Resume
              </Button>
            )}
            <Button
              size="sm"
              variant="ghost"
              disabled={pending}
              onClick={() => void submit({ type: "clear" })}
            >
              Clear
            </Button>
          </div>
        </div>
      )}
      {pending ? (
        <p role="status" className="mt-1 text-xs text-muted-foreground">
          Updating Goal…
        </p>
      ) : null}
      {thread.goalOperation?.status === "failed" ? (
        <p role="alert" className="mt-1 text-destructive">
          {thread.goalOperation.error}
        </p>
      ) : null}
    </section>
  );
}
