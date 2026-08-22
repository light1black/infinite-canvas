import { nanoid } from "nanoid";

import type { CanvasGenerationMode, CanvasGenerationTask, CanvasGenerationTaskEvent, CanvasGenerationTaskPhase, CanvasGenerationTaskStatus, CanvasNodeData } from "@/types/canvas";

export type CanvasGenerationTaskSnapshot = { nodeId: string; task: CanvasGenerationTask };

export function createGenerationTask(mode: CanvasGenerationMode, sourceNodeIds: string[], resultNodeIds: string[], previous?: CanvasGenerationTask): CanvasGenerationTask {
    const now = new Date().toISOString();
    const taskId = previous?.taskId || `canvas-${mode}-${nanoid()}`;
    const previousResultKeys = new Map((previous?.resultNodeIds || []).map((resultNodeId, index) => [resultNodeId, previous?.resultKeys?.[index]]));
    const nextResultIndex = previous?.resultKeys?.length || 0;
    return {
        taskId,
        mode,
        status: "queued",
        phase: "created",
        sourceNodeIds,
        resultNodeIds,
        resultKeys: resultNodeIds.map((resultNodeId, index) => previousResultKeys.get(resultNodeId) || generationResultKey(taskId, previous ? nextResultIndex + index : index)),
        retryCount: previous ? (previous.retryCount ?? 0) + 1 : 0,
        createdAt: previous?.createdAt || now,
        updatedAt: now,
        events: [{ at: now, status: "queued", phase: "created" }],
    };
}

export function updateGenerationTask(task: CanvasGenerationTask, status: CanvasGenerationTaskStatus, errorDetails?: string, phase = phaseForStatus(status)): CanvasGenerationTask {
    const updatedAt = new Date().toISOString();
    const event: CanvasGenerationTaskEvent = { at: updatedAt, status, phase, ...(errorDetails ? { errorDetails } : {}) };
    return { ...task, status, phase, errorDetails, updatedAt, persistedAt: undefined, events: [...(task.events || []), event].slice(-32) };
}

export function markGenerationTaskPersisted(task: CanvasGenerationTask, persistedAt = new Date().toISOString()): CanvasGenerationTask {
    if (task.persistedAt || task.status === "queued" || task.status === "running") return task;
    const phase: CanvasGenerationTaskPhase = task.status === "succeeded" ? "completed" : "interrupted";
    const event: CanvasGenerationTaskEvent = { at: persistedAt, status: task.status, phase, ...(task.errorDetails ? { errorDetails: task.errorDetails } : {}) };
    return { ...task, phase, persistedAt, updatedAt: persistedAt, events: [...(task.events || []), event].slice(-32) };
}

export function captureUnpersistedGenerationTasks(nodes: CanvasNodeData[]): CanvasGenerationTaskSnapshot[] {
    return nodes.flatMap((node) => {
        const task = node.metadata?.generationTask;
        if (!task || task.persistedAt || task.status === "queued" || task.status === "running") return [];
        return [{ nodeId: node.id, task }];
    });
}

export function markCapturedGenerationTasksPersisted(nodes: CanvasNodeData[], snapshots: CanvasGenerationTaskSnapshot[], persistedAt: string): CanvasNodeData[] {
    if (!snapshots.length) return nodes;
    const byNodeId = new Map(snapshots.map((snapshot) => [snapshot.nodeId, snapshot.task]));
    let changed = false;
    const next = nodes.map((node) => {
        const task = node.metadata?.generationTask;
        if (!task || task !== byNodeId.get(node.id)) return node;
        changed = true;
        return { ...node, metadata: { ...node.metadata, generationTask: markGenerationTaskPersisted(task, persistedAt) } };
    });
    return changed ? next : nodes;
}

export function interruptInFlightGenerationTasks(nodes: CanvasNodeData[], errorDetails: string): CanvasNodeData[] {
    const interruptedTasks = new Map<string, CanvasGenerationTask>();
    nodes.forEach((node) => {
        const task = node.metadata?.generationTask;
        if (!task || (task.status !== "queued" && task.status !== "running")) return;
        const key = generationTaskRunKey(task);
        if (!interruptedTasks.has(key)) interruptedTasks.set(key, updateGenerationTask(task, "failed", errorDetails));
    });
    let changed = false;
    const next = nodes.map((node) => {
        const metadata = node.metadata;
        if (!metadata) return node;
        const interruptedTask = metadata.generationTask ? interruptedTasks.get(generationTaskRunKey(metadata.generationTask)) : undefined;
        if (!interruptedTask && metadata.status !== "loading") return node;
        changed = true;
        return {
            ...node,
            metadata: {
                ...metadata,
                ...(interruptedTask ? { generationTask: interruptedTask } : {}),
                ...(metadata.status === "loading" ? { status: "error" as const, errorDetails } : {}),
                images: metadata.images?.map((image) => (image.status === "loading" ? { ...image, status: "error" as const, errorDetails } : image)),
            },
        };
    });
    return changed ? next : nodes;
}

function phaseForStatus(status: CanvasGenerationTaskStatus): CanvasGenerationTaskPhase {
    if (status === "queued") return "created";
    if (status === "running") return "executing";
    if (status === "cancelled" || status === "failed") return "interrupted";
    return "persisting";
}

export function generationResultKey(taskId: string, index: number) {
    return `${taskId}:${index}`;
}

function generationTaskRunKey(task: CanvasGenerationTask) {
    return `${task.taskId}:${task.retryCount ?? 0}`;
}
