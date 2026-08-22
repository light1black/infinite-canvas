import { discoverAgentConfig, fetchAgentJson } from "./canvas-agent";

export type SkillImageExecutor = "general-image-generation" | "aigc-cli";

export type AgentSkillImageTaskInput = {
    executor: SkillImageExecutor;
    prompt: string;
    images?: string[];
    model?: string;
    size?: string;
    quality?: string;
    background?: string;
    count?: number;
};

export type AgentSkillImageTaskResult = {
    taskId: string;
    status: "succeeded";
    mode: SkillImageExecutor;
    model: string;
    images: string[];
    localPaths: string[];
};

type AgentSkillImageTaskResponse = { ok?: boolean; data?: AgentSkillImageTaskResult };

const DEFAULT_AGENT_URL = "http://127.0.0.1:17371";

/** 通过本地 Canvas Agent 调用已安装的图片 Skill。 */
export async function requestAgentSkillImageTask(input: AgentSkillImageTaskInput, signal?: AbortSignal) {
    const endpoint = (localStorage.getItem("canvas-agent-url") || DEFAULT_AGENT_URL).replace(/\/$/, "");
    const discovered = await discoverAgentConfig(endpoint);
    const token = localStorage.getItem("canvas-agent-token") || discovered?.token || "";
    if (!token) throw new Error("本地 Canvas Agent 未连接，无法运行生图 Skill");
    const response = await fetchAgentJson<AgentSkillImageTaskResponse>(endpoint, token, "/generation/skill/image/tasks", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(input),
        signal,
    });
    if (!response.data?.images?.length) throw new Error("生图 Skill 没有返回图片结果");
    return response.data;
}
