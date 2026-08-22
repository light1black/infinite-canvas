import { discoverAgentConfig, fetchAgentJson } from "./canvas-agent";

type AgentImageTaskInput = {
    prompt: string;
    images?: string[];
    baseUrl?: string;
    apiKey?: string;
    model?: string;
    size?: string;
    quality?: string;
    background?: string;
    count?: number;
};

type AgentImageTaskResponse = {
    ok?: boolean;
    data?: { taskId: string; status: "succeeded"; mode: "simulated" | "openai-compatible"; fallbackReason?: string; model: string; images: string[] };
};

const DEFAULT_AGENT_URL = "http://127.0.0.1:17371";

export async function requestAgentImageTask(input: AgentImageTaskInput, signal?: AbortSignal) {
    const endpoint = (localStorage.getItem("canvas-agent-url") || DEFAULT_AGENT_URL).replace(/\/$/, "");
    const discovered = await discoverAgentConfig(endpoint);
    const token = localStorage.getItem("canvas-agent-token") || discovered?.token || "";
    if (!token) throw new Error("本地 Canvas Agent 未连接，无法运行图片任务");
    const response = await fetchAgentJson<AgentImageTaskResponse>(endpoint, token, "/generation/image/tasks", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(input),
        signal,
    });
    if (!response.data?.images?.length) throw new Error("本地图片任务没有返回结果");
    return response.data;
}
