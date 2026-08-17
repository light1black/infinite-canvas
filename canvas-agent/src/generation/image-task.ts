import crypto from "node:crypto";
import fs from "node:fs";

export type ImageTaskInput = {
    prompt: string;
    images?: string[];
    model?: string;
    size?: string;
    quality?: string;
    background?: string;
    count?: number;
};

export type ImageTaskResult = {
    taskId: string;
    status: "succeeded";
    mode: "simulated" | "openai-compatible";
    model: string;
    images: string[];
};

type ImageApiPayload = { data?: Array<{ b64_json?: string; url?: string }>; error?: { message?: string }; message?: string };

/** Run one OpenAI-compatible image task, using a deterministic mock when no local key is configured. */
export async function runImageTask(input: ImageTaskInput, signal?: AbortSignal): Promise<ImageTaskResult> {
    const settings = loadImageSettings();
    const prompt = input.prompt?.trim();
    if (!prompt) throw new Error("图片任务提示词不能为空");
    const taskId = `image-task-${crypto.randomUUID()}`;
    const model = input.model?.trim() || settings.model;
    const count = Math.max(1, Math.min(10, Math.floor(Number(input.count) || 1)));
    if (!settings.apiKey) {
        return {
            taskId,
            status: "succeeded",
            mode: "simulated",
            model,
            images: Array.from({ length: count }, (_, index) => simulatedImage(prompt, index + 1, count)),
        };
    }

    const images = input.images?.filter(Boolean) || [];
    const payload = images.length
        ? await requestImageEdit(settings, { ...input, prompt, model, count, images }, signal)
        : await requestImageGeneration(settings, { ...input, prompt, model, count }, signal);
    return { taskId, status: "succeeded", mode: "openai-compatible", model, images: parseImages(payload) };
}

function loadImageSettings() {
    const file = new URL("../../.env.local", import.meta.url);
    const values = fs.existsSync(file) ? parseEnv(fs.readFileSync(file, "utf8")) : {};
    return {
        apiKey: process.env.OPENAI_COMPATIBLE_IMAGE_API_KEY || process.env.OPENAI_API_KEY || values.OPENAI_COMPATIBLE_IMAGE_API_KEY || values.OPENAI_API_KEY || "",
        baseUrl: process.env.OPENAI_COMPATIBLE_IMAGE_BASE_URL || process.env.OPENAI_BASE_URL || values.OPENAI_COMPATIBLE_IMAGE_BASE_URL || values.OPENAI_BASE_URL || "https://api.openai.com",
        model: process.env.OPENAI_COMPATIBLE_IMAGE_MODEL || values.OPENAI_COMPATIBLE_IMAGE_MODEL || "gpt-image-2",
    };
}

async function requestImageGeneration(settings: ReturnType<typeof loadImageSettings>, input: Required<Pick<ImageTaskInput, "prompt" | "model" | "count">> & ImageTaskInput, signal?: AbortSignal) {
    return requestJson(settings, imageUrl(settings.baseUrl, "/images/generations"), {
        model: input.model,
        prompt: input.prompt,
        n: input.count,
        response_format: "b64_json",
        ...(input.size ? { size: input.size } : {}),
        ...(input.quality ? { quality: input.quality } : {}),
        ...(input.background ? { background: input.background } : {}),
    }, signal);
}

async function requestImageEdit(settings: ReturnType<typeof loadImageSettings>, input: Required<Pick<ImageTaskInput, "prompt" | "model" | "count" | "images">> & ImageTaskInput, signal?: AbortSignal) {
    const form = new FormData();
    form.set("model", input.model);
    form.set("prompt", input.prompt);
    form.set("n", String(input.count));
    form.set("response_format", "b64_json");
    if (input.size) form.set("size", input.size);
    if (input.quality) form.set("quality", input.quality);
    if (input.background) form.set("background", input.background);
    for (const [index, image] of input.images.entries()) form.append("image", await imageBlob(image, signal), `reference-${index + 1}.png`);
    const response = await fetch(imageUrl(settings.baseUrl, "/images/edits"), { method: "POST", headers: { authorization: `Bearer ${settings.apiKey}` }, body: form, signal });
    return readResponse(response);
}

async function requestJson(settings: ReturnType<typeof loadImageSettings>, url: string, body: unknown, signal?: AbortSignal) {
    const response = await fetch(url, {
        method: "POST",
        headers: { authorization: `Bearer ${settings.apiKey}`, "content-type": "application/json" },
        body: JSON.stringify(body),
        signal,
    });
    return readResponse(response);
}

async function readResponse(response: Response) {
    const payload = (await response.json().catch(() => ({}))) as ImageApiPayload;
    if (!response.ok) throw new Error(payload.error?.message || payload.message || `图片服务请求失败 (${response.status})`);
    return payload;
}

function parseImages(payload: ImageApiPayload) {
    const images = (payload.data || []).map((item) => item.b64_json ? `data:image/png;base64,${item.b64_json}` : item.url || "").filter(Boolean);
    if (!images.length) throw new Error(payload.error?.message || "图片服务没有返回图片");
    return images;
}

async function imageBlob(value: string, signal?: AbortSignal) {
    if (!value.startsWith("data:")) {
        const response = await fetch(value, { signal });
        if (!response.ok) throw new Error(`参考图读取失败 (${response.status})`);
        return response.blob();
    }
    const match = /^data:([^;,]+)?(;base64)?,(.*)$/s.exec(value);
    if (!match) throw new Error("参考图 Data URL 无效");
    const bytes = match[2] ? Buffer.from(match[3], "base64") : Buffer.from(decodeURIComponent(match[3]));
    return new Blob([bytes], { type: match[1] || "image/png" });
}

function imageUrl(baseUrl: string, path: string) {
    const normalized = baseUrl.trim().replace(/\/+$/, "");
    return `${normalized.toLowerCase().endsWith("/v1") ? normalized : `${normalized}/v1`}${path}`;
}

function parseEnv(source: string) {
    return Object.fromEntries(source.split(/\r?\n/).map((line) => line.trim()).filter((line) => line && !line.startsWith("#") && line.includes("=")).map((line) => {
        const index = line.indexOf("=");
        const value = line.slice(index + 1).trim().replace(/^(['"])(.*)\1$/, "$2");
        return [line.slice(0, index).trim(), value];
    }));
}

function simulatedImage(prompt: string, index: number, count: number) {
    const label = escapeXml(prompt).slice(0, 120);
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024"><rect width="1024" height="1024" fill="#171717"/><rect x="96" y="96" width="832" height="832" rx="24" fill="#262626" stroke="#525252" stroke-width="2"/><text x="512" y="420" text-anchor="middle" fill="#fafafa" font-family="Arial,sans-serif" font-size="42">OpenAI 兼容图片任务</text><text x="512" y="486" text-anchor="middle" fill="#a3a3a3" font-family="Arial,sans-serif" font-size="28">模拟结果 ${index}/${count}</text><foreignObject x="170" y="540" width="684" height="240"><div xmlns="http://www.w3.org/1999/xhtml" style="color:#d4d4d4;font:24px Arial,sans-serif;text-align:center;line-height:1.5;word-break:break-word">${label}</div></foreignObject></svg>`;
    return `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;
}

function escapeXml(value: string) {
    return value.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[char] || char);
}
