import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { getComfyUiStatus, runComfyUiTask } from "./comfyui-task.js";

const ENV_KEYS = ["COMFYUI_BASE_URL", "COMFYUI_URL", "COMFYUI_WORKFLOW_PATH", "COMFYUI_PROMPT_NODE_ID", "COMFYUI_PROMPT_INPUT", "COMFYUI_OUTPUT_NODE_ID", "COMFYUI_ALLOW_SIMULATION", "COMFYUI_TIMEOUT_MS"] as const;

test("没有 workflow 时返回 ComfyUI 模拟结果", async () => withComfyEnv({}, async () => {
    const result = await runComfyUiTask({ prompt: "测试 ComfyUI", count: 2 });
    assert.equal(result.mode, "simulated");
    assert.equal(result.images.length, 2);
    assert.equal(result.fallbackReason, "未配置 COMFYUI_WORKFLOW_PATH");
    assert.equal(getComfyUiStatus().workflowAvailable, false);
}));

test("固定 workflow 会覆盖提示词并读取 ComfyUI 图片", async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "comfyui-workflow-"));
    const workflowPath = path.join(workspace, "workflow.json");
    await fs.writeFile(workflowPath, JSON.stringify({ "6": { class_type: "CLIPTextEncode", inputs: { text: "旧提示词" } }, "9": { class_type: "SaveImage", inputs: {} } }), "utf8");
    const requests: Array<{ method: string; url: string; body?: string }> = [];
    try {
        await withServer(async (baseUrl) => withComfyEnv({ COMFYUI_BASE_URL: baseUrl, COMFYUI_WORKFLOW_PATH: workflowPath, COMFYUI_TIMEOUT_MS: "2000" }, async () => {
            serverHandler = async (request, response) => {
                const body = await readBody(request);
                requests.push({ method: request.method || "", url: request.url || "", body });
                response.setHeader("content-type", "application/json");
                if (request.method === "POST") response.end(JSON.stringify({ prompt_id: "prompt-1" }));
                else if (request.url === "/history/prompt-1") response.end(JSON.stringify({ "prompt-1": { outputs: { "9": { images: [{ filename: "result.png", subfolder: "", type: "output" }] } } } }));
                else if (request.url?.startsWith("/view?")) {
                    response.setHeader("content-type", "image/png");
                    response.end(Buffer.from("png-test"));
                } else response.end(JSON.stringify({}));
            };
            const result = await runComfyUiTask({ prompt: "新提示词", count: 1 });
            assert.equal(result.mode, "comfyui");
            assert.equal(result.promptId, "prompt-1");
            assert.equal(result.images[0], "data:image/png;base64,cG5nLXRlc3Q=");
        }));
    } finally {
        await fs.rm(workspace, { recursive: true, force: true });
    }
    assert.equal(requests[0]?.url, "/prompt");
    assert.equal(JSON.parse(requests[0]?.body || "{}").prompt["6"].inputs.text, "新提示词");
    assert.equal(requests[1]?.url, "/history/prompt-1");
    assert.match(requests[2]?.url || "", /^\/view\?/);
});

test("ComfyUI 服务不可用时保留模拟降级", async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "comfyui-workflow-"));
    const workflowPath = path.join(workspace, "workflow.json");
    await fs.writeFile(workflowPath, JSON.stringify({ "6": { inputs: { text: "旧提示词" } } }), "utf8");
    try {
        const result = await withComfyEnv({ COMFYUI_BASE_URL: "http://127.0.0.1:1", COMFYUI_WORKFLOW_PATH: workflowPath, COMFYUI_TIMEOUT_MS: "1000" }, () => runComfyUiTask({ prompt: "服务离线" }));
        assert.equal(result.mode, "simulated");
        assert.match(result.fallbackReason || "", /ComfyUI 不可用/);
    } finally {
        await fs.rm(workspace, { recursive: true, force: true });
    }
});

let serverHandler: (request: http.IncomingMessage, response: http.ServerResponse) => Promise<void> = async (_request, response) => response.end();

async function withServer(run: (baseUrl: string) => Promise<void>) {
    const server = http.createServer((request, response) => void serverHandler(request, response));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    assert.ok(address && typeof address === "object");
    try {
        await run(`http://127.0.0.1:${address.port}`);
    } finally {
        await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
}

async function withComfyEnv(values: Partial<Record<(typeof ENV_KEYS)[number], string>>, run: () => Promise<unknown>) {
    const previous = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
    for (const key of ENV_KEYS) delete process.env[key];
    Object.assign(process.env, values);
    try {
        return await run();
    } finally {
        for (const key of ENV_KEYS) previous[key] === undefined ? delete process.env[key] : process.env[key] = previous[key];
    }
}

async function readBody(request: http.IncomingMessage) {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    return Buffer.concat(chunks).toString("utf8");
}
