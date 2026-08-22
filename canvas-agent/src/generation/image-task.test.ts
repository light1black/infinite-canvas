import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";

import { runImageTask } from "./image-task.js";

const ENV_KEYS = ["OPENAI_COMPATIBLE_IMAGE_API_KEY", "OPENAI_API_KEY", "OPENAI_COMPATIBLE_IMAGE_BASE_URL", "OPENAI_BASE_URL", "OPENAI_COMPATIBLE_IMAGE_MODEL"] as const;

test("未配置密钥时返回指定数量的模拟图片", async () => withImageEnv({}, async () => {
    const result = await runImageTask({ prompt: "蓝色几何海报", count: 2 });
    assert.equal(result.mode, "simulated");
    assert.equal(result.fallbackReason, "未配置 OPENAI_COMPATIBLE_IMAGE_API_KEY，当前返回模拟图片");
    assert.equal(result.model, "gpt-image-2");
    assert.equal(result.images.length, 2);
    assert.ok(result.images.every((image) => image.startsWith("data:image/svg+xml;base64,")));
}));

test("网页渠道配置可通过本地 Agent 调用 OpenAI 兼容图片接口", async () => {
    let authorization = "";
    await withServer(async (baseUrl) => withImageEnv({}, async () => {
        serverHandler = async (request, response) => {
            authorization = String(request.headers.authorization || "");
            response.setHeader("content-type", "application/json");
            response.end(JSON.stringify({ data: [{ b64_json: "aGVsbG8=" }] }));
        };
        const result = await runImageTask({ prompt: "网页渠道测试", baseUrl, apiKey: "browser-channel-key", model: "gpt-image-2" });
        assert.equal(result.mode, "openai-compatible");
        assert.equal(result.fallbackReason, undefined);
    }));
    assert.equal(authorization, "Bearer browser-channel-key");
});

test("OpenAI 兼容文生图只使用 Agent 本地地址和配置", async () => {
    const requests: Array<{ url: string; authorization: string; body: string }> = [];
    await withServer(async (baseUrl) => withImageEnv({
        OPENAI_COMPATIBLE_IMAGE_API_KEY: "local-test-key",
        OPENAI_COMPATIBLE_IMAGE_BASE_URL: `${baseUrl}/v1`,
        OPENAI_COMPATIBLE_IMAGE_MODEL: "local-image-model",
    }, async () => {
        serverHandler = async (request, response) => {
            requests.push({ url: request.url || "", authorization: String(request.headers.authorization || ""), body: await readBody(request) });
            response.setHeader("content-type", "application/json");
            response.end(JSON.stringify({ data: [{ b64_json: "aGVsbG8=" }] }));
        };
        const result = await runImageTask({ prompt: "测试", count: 2, size: "1024x1024", quality: "high", background: "transparent" });
        assert.equal(result.mode, "openai-compatible");
        assert.deepEqual(result.images, ["data:image/png;base64,aGVsbG8="]);
    }));
    assert.equal(requests[0]?.url, "/v1/images/generations");
    assert.equal(requests[0]?.authorization, "Bearer local-test-key");
    assert.deepEqual(JSON.parse(requests[0]?.body || "{}"), { model: "local-image-model", prompt: "测试", n: 2, response_format: "b64_json", size: "1024x1024", quality: "high", background: "transparent" });
});

test("gpt-image 模型不发送不兼容的 response_format", async () => {
    let body = "";
    await withServer(async (baseUrl) => withImageEnv({ OPENAI_COMPATIBLE_IMAGE_API_KEY: "test-key", OPENAI_COMPATIBLE_IMAGE_BASE_URL: baseUrl }, async () => {
        serverHandler = async (request, response) => {
            body = await readBody(request);
            response.setHeader("content-type", "application/json");
            response.end(JSON.stringify({ data: [{ b64_json: "aGVsbG8=" }] }));
        };
        await runImageTask({ prompt: "严格协议测试", model: "gpt-image-2" });
    }));
    assert.equal(JSON.parse(body).response_format, undefined);
});

test("包含参考图时调用 OpenAI 兼容图生图接口", async () => {
    let requestUrl = "";
    let contentType = "";
    let body = "";
    await withServer(async (baseUrl) => withImageEnv({ OPENAI_COMPATIBLE_IMAGE_API_KEY: "test-key", OPENAI_COMPATIBLE_IMAGE_BASE_URL: baseUrl }, async () => {
        serverHandler = async (request, response) => {
            requestUrl = request.url || "";
            contentType = String(request.headers["content-type"] || "");
            body = await readBody(request);
            response.setHeader("content-type", "application/json");
            response.end(JSON.stringify({ data: [{ url: "https://example.invalid/result.png" }] }));
        };
        const result = await runImageTask({ prompt: "修改参考图", images: ["data:image/png;base64,aGVsbG8="] });
        assert.deepEqual(result.images, ["https://example.invalid/result.png"]);
    }));
    assert.equal(requestUrl, "/v1/images/edits");
    assert.match(contentType, /^multipart\/form-data; boundary=/);
    assert.match(body, /name="prompt"\r\n\r\n修改参考图/);
    assert.match(body, /name="image"; filename="reference-1.png"/);
});

test("图生图上传时按真实文件头修正参考图 MIME 和扩展名", async () => {
    let body = "";
    await withServer(async (baseUrl) => withImageEnv({ OPENAI_COMPATIBLE_IMAGE_API_KEY: "test-key", OPENAI_COMPATIBLE_IMAGE_BASE_URL: baseUrl }, async () => {
        serverHandler = async (request, response) => {
            body = await readBody(request);
            response.setHeader("content-type", "application/json");
            response.end(JSON.stringify({ data: [{ b64_json: "aGVsbG8=" }] }));
        };
        await runImageTask({ prompt: "真实 JPEG 参考图", images: ["data:image/png;base64,/9j/2Q=="] });
    }));
    assert.match(body, /filename="reference-1\.jpg"/);
    assert.match(body, /Content-Type: image\/jpeg/);
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

async function withImageEnv(values: Partial<Record<(typeof ENV_KEYS)[number], string>>, run: () => Promise<void>) {
    const previous = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
    for (const key of ENV_KEYS) delete process.env[key];
    Object.assign(process.env, values);
    try {
        await run();
    } finally {
        for (const key of ENV_KEYS) previous[key] === undefined ? delete process.env[key] : process.env[key] = previous[key];
    }
}

async function readBody(request: http.IncomingMessage) {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    return Buffer.concat(chunks).toString("utf8");
}
