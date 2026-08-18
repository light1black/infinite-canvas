import { discoverAgentConfig, fetchAgentJson } from "./canvas-agent";

export type AgentVideoTask = {
    taskId: string;
    status: "queued" | "succeeded";
    mode: "simulated";
    fallbackReason: string;
    videoDataUrl?: string;
};

const DEFAULT_AGENT_URL = "http://127.0.0.1:17371";

export async function createAgentVideoTask(input: { prompt: string }, signal?: AbortSignal) {
    return requestAgentVideo<{ ok?: boolean; data?: AgentVideoTask }>("/generation/video/tasks", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(input),
        signal,
    }).then((response) => {
        if (!response.data) throw new Error("本地视频模拟任务没有返回结果");
        return response.data;
    });
}

export async function getAgentVideoTask(taskId: string, signal?: AbortSignal) {
    return requestAgentVideo<{ ok?: boolean; data?: AgentVideoTask }>(`/generation/video/tasks/${encodeURIComponent(taskId)}`, { signal }).then((response) => {
        if (!response.data) throw new Error("本地视频模拟任务没有返回结果");
        return response.data;
    });
}

async function requestAgentVideo<T>(path: string, init?: RequestInit) {
    const endpoint = (localStorage.getItem("canvas-agent-url") || DEFAULT_AGENT_URL).replace(/\/$/, "");
    const discovered = await discoverAgentConfig(endpoint);
    const token = localStorage.getItem("canvas-agent-token") || discovered?.token || "";
    if (!token) throw new Error("本地 Canvas Agent 未连接，无法运行视频模拟任务");
    return fetchAgentJson<T>(endpoint, token, path, init);
}
