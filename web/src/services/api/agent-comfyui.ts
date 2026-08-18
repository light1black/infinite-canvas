import { discoverAgentConfig, fetchAgentJson } from "./canvas-agent";

export type AgentComfyUiStatus = {
    mode: "simulated" | "comfyui";
    baseUrl: string;
    workflowPath: string;
    workflowAvailable: boolean;
    allowSimulation: boolean;
};

export type AgentComfyUiTaskResult = {
    taskId: string;
    status: "succeeded";
    mode: "simulated" | "comfyui";
    images: string[];
    promptId?: string;
    fallbackReason?: string;
};

const DEFAULT_AGENT_URL = "http://127.0.0.1:17371";

export async function getAgentComfyUiStatus() {
    return requestAgentComfyUi<{ ok?: boolean; data?: AgentComfyUiStatus }>("/generation/comfyui/config").then((response) => response.data);
}

export async function requestAgentComfyUiTask(input: { prompt: string; count?: number }, signal?: AbortSignal) {
    const response = await requestAgentComfyUi<{ ok?: boolean; data?: AgentComfyUiTaskResult }>("/generation/comfyui/tasks", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(input),
        signal,
    });
    if (!response.data?.images.length) throw new Error("本地 ComfyUI 任务没有返回结果");
    return response.data;
}

async function requestAgentComfyUi<T>(path: string, init?: RequestInit) {
    const endpoint = (localStorage.getItem("canvas-agent-url") || DEFAULT_AGENT_URL).replace(/\/$/, "");
    const discovered = await discoverAgentConfig(endpoint);
    const token = localStorage.getItem("canvas-agent-token") || discovered?.token || "";
    if (!token) throw new Error("本地 Canvas Agent 未连接，无法运行 ComfyUI 任务");
    return fetchAgentJson<T>(endpoint, token, path, init);
}
