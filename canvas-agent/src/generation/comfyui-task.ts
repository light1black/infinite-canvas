import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export type ComfyUiTaskInput = {
    prompt: string;
    count?: number;
};

export type ComfyUiTaskResult = {
    taskId: string;
    status: "succeeded";
    mode: "simulated" | "comfyui";
    images: string[];
    promptId?: string;
    fallbackReason?: string;
};

type ComfyUiSettings = {
    baseUrl: string;
    workflowPath: string;
    promptNodeId: string;
    promptInput: string;
    outputNodeId: string;
    allowSimulation: boolean;
    timeoutMs: number;
};

type ComfyHistory = Record<string, { outputs?: Record<string, { images?: Array<{ filename?: string; subfolder?: string; type?: string }> }>; status?: { completed?: boolean } }>;

/** 执行一个固定 ComfyUI 工作流；缺少 workflow 或服务时返回可识别的模拟结果。 */
export async function runComfyUiTask(input: ComfyUiTaskInput, signal?: AbortSignal): Promise<ComfyUiTaskResult> {
    const prompt = input.prompt?.trim();
    if (!prompt) throw new Error("ComfyUI 图片任务提示词不能为空");
    const settings = loadComfyUiSettings();
    const taskId = `comfyui-task-${crypto.randomUUID()}`;
    const count = Math.max(1, Math.min(10, Math.floor(Number(input.count) || 1)));
    if (!settings.workflowPath) return simulatedResult(taskId, prompt, count, "未配置 COMFYUI_WORKFLOW_PATH");

    const workflow = readWorkflow(settings.workflowPath);
    if (!workflow) return simulatedResult(taskId, prompt, count, "ComfyUI workflow 文件不存在");
    applyPrompt(workflow, settings.promptNodeId, settings.promptInput, prompt);
    try {
        const promptId = await submitWorkflow(settings, workflow, signal);
        const images = await waitForImages(settings, promptId, count, signal);
        return { taskId, status: "succeeded", mode: "comfyui", promptId, images };
    } catch (error) {
        if (isAbortError(error) || !settings.allowSimulation) throw error;
        const reason = error instanceof Error ? error.message : String(error);
        return simulatedResult(taskId, prompt, count, `ComfyUI 不可用：${reason}`);
    }
}

export function getComfyUiStatus() {
    const settings = loadComfyUiSettings();
    const workflowAvailable = Boolean(settings.workflowPath && fileExists(settings.workflowPath));
    return {
        mode: workflowAvailable ? "comfyui" : "simulated",
        baseUrl: settings.baseUrl,
        workflowPath: settings.workflowPath,
        workflowAvailable,
        allowSimulation: settings.allowSimulation,
    } as const;
}

function loadComfyUiSettings(): ComfyUiSettings {
    const values = readEnvFile();
    const workflowPath = process.env.COMFYUI_WORKFLOW_PATH || values.COMFYUI_WORKFLOW_PATH || "";
    const timeoutMs = Math.max(1_000, Math.min(600_000, Number(process.env.COMFYUI_TIMEOUT_MS || values.COMFYUI_TIMEOUT_MS) || 120_000));
    return {
        baseUrl: (process.env.COMFYUI_BASE_URL || process.env.COMFYUI_URL || values.COMFYUI_BASE_URL || values.COMFYUI_URL || "http://127.0.0.1:8188").replace(/\/+$/, ""),
        workflowPath: workflowPath ? path.resolve(workflowPath) : "",
        promptNodeId: process.env.COMFYUI_PROMPT_NODE_ID || values.COMFYUI_PROMPT_NODE_ID || "6",
        promptInput: process.env.COMFYUI_PROMPT_INPUT || values.COMFYUI_PROMPT_INPUT || "text",
        outputNodeId: process.env.COMFYUI_OUTPUT_NODE_ID || values.COMFYUI_OUTPUT_NODE_ID || "",
        allowSimulation: (process.env.COMFYUI_ALLOW_SIMULATION || values.COMFYUI_ALLOW_SIMULATION || "true").toLowerCase() !== "false",
        timeoutMs,
    };
}

function readWorkflow(filePath: string): Record<string, Record<string, unknown>> | null {
    if (!fileExists(filePath)) return null;
    try {
        const parsed = JSON.parse(fs.readFileSync(filePath, "utf8")) as unknown;
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("workflow JSON 必须是对象");
        const workflow = parsed as Record<string, unknown>;
        const nodes = Object.fromEntries(Object.entries(workflow).filter(([, value]) => value && typeof value === "object" && !Array.isArray(value))) as Record<string, Record<string, unknown>>;
        if (!Object.keys(nodes).length) throw new Error("workflow JSON 没有节点");
        return nodes;
    } catch (error) {
        if (error instanceof Error && error.message.includes("workflow JSON")) throw error;
        throw new Error(`workflow JSON 读取失败：${error instanceof Error ? error.message : String(error)}`);
    }
}

function applyPrompt(workflow: Record<string, Record<string, unknown>>, nodeId: string, inputName: string, prompt: string) {
    const node = workflow[nodeId];
    if (!node || !node.inputs || typeof node.inputs !== "object" || Array.isArray(node.inputs)) throw new Error(`找不到提示词节点 ${nodeId}`);
    (node.inputs as Record<string, unknown>)[inputName] = prompt;
}

async function submitWorkflow(settings: ComfyUiSettings, workflow: Record<string, Record<string, unknown>>, signal?: AbortSignal) {
    const response = await fetch(`${settings.baseUrl}/prompt`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ prompt: workflow, client_id: "infinite-canvas" }),
        signal,
    });
    const payload = await readJson(response) as { prompt_id?: string; error?: string; node_errors?: unknown };
    if (!response.ok || !payload.prompt_id) throw new Error(payload.error || `ComfyUI 提交失败 (${response.status})`);
    return payload.prompt_id;
}

async function waitForImages(settings: ComfyUiSettings, promptId: string, count: number, signal?: AbortSignal) {
    const deadline = Date.now() + settings.timeoutMs;
    while (Date.now() < deadline) {
        const response = await fetch(`${settings.baseUrl}/history/${encodeURIComponent(promptId)}`, { signal });
        const history = await readJson(response) as ComfyHistory;
        if (!response.ok) throw new Error(`ComfyUI 历史查询失败 (${response.status})`);
        const entry = history[promptId];
        const descriptors = collectImages(entry, settings.outputNodeId);
        if (descriptors.length) return Promise.all(descriptors.slice(0, count).map((descriptor) => downloadImage(settings, descriptor, signal)));
        if (entry?.status?.completed) throw new Error("ComfyUI 工作流已完成但没有返回图片");
        await delay(250, signal);
    }
    throw new Error("ComfyUI 任务超时");
}

function collectImages(entry: ComfyHistory[string] | undefined, outputNodeId: string) {
    if (!entry?.outputs) return [];
    return Object.entries(entry.outputs)
        .filter(([nodeId]) => !outputNodeId || nodeId === outputNodeId)
        .flatMap(([, output]) => output.images || [])
        .filter((image): image is { filename: string; subfolder?: string; type?: string } => Boolean(image.filename));
}

async function downloadImage(settings: ComfyUiSettings, image: { filename: string; subfolder?: string; type?: string }, signal?: AbortSignal) {
    const query = new URLSearchParams({ filename: image.filename, subfolder: image.subfolder || "", type: image.type || "output" });
    const response = await fetch(`${settings.baseUrl}/view?${query}`, { signal });
    if (!response.ok) throw new Error(`ComfyUI 图片读取失败 (${response.status})`);
    const mimeType = response.headers.get("content-type")?.split(";", 1)[0] || "image/png";
    return `data:${mimeType};base64,${Buffer.from(await response.arrayBuffer()).toString("base64")}`;
}

async function readJson(response: Response) {
    return response.json().catch(() => ({}));
}

function simulatedResult(taskId: string, prompt: string, count: number, fallbackReason: string): ComfyUiTaskResult {
    return { taskId, status: "succeeded", mode: "simulated", fallbackReason, images: Array.from({ length: count }, (_, index) => simulatedImage(prompt, index + 1, count)) };
}

function simulatedImage(prompt: string, index: number, count: number) {
    const label = escapeXml(prompt).slice(0, 120);
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024"><rect width="1024" height="1024" fill="#10202a"/><rect x="96" y="96" width="832" height="832" rx="24" fill="#163746" stroke="#5eead4" stroke-width="2"/><text x="512" y="420" text-anchor="middle" fill="#ecfeff" font-family="Arial,sans-serif" font-size="42">ComfyUI 单工作流</text><text x="512" y="486" text-anchor="middle" fill="#99f6e4" font-family="Arial,sans-serif" font-size="28">模拟结果 ${index}/${count}</text><foreignObject x="170" y="540" width="684" height="240"><div xmlns="http://www.w3.org/1999/xhtml" style="color:#ccfbf1;font:24px Arial,sans-serif;text-align:center;line-height:1.5;word-break:break-word">${label}</div></foreignObject></svg>`;
    return `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;
}

function escapeXml(value: string) {
    return value.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[char] || char);
}

function readEnvFile() {
    const file = new URL("../../.env.local", import.meta.url);
    if (!fs.existsSync(file)) return {};
    return Object.fromEntries(fs.readFileSync(file, "utf8").split(/\r?\n/).map((line) => line.trim()).filter((line) => line && !line.startsWith("#") && line.includes("=")).map((line) => {
        const index = line.indexOf("=");
        return [line.slice(0, index).trim(), line.slice(index + 1).trim().replace(/^(['"])(.*)\1$/, "$2")];
    }));
}

function fileExists(filePath: string) {
    try {
        return fs.existsSync(filePath);
    } catch {
        return false;
    }
}

function delay(ms: number, signal?: AbortSignal) {
    return new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, ms);
        signal?.addEventListener("abort", () => { clearTimeout(timer); reject(new DOMException("任务已取消", "AbortError")); }, { once: true });
    });
}

function isAbortError(error: unknown) {
    return error instanceof Error && error.name === "AbortError";
}
