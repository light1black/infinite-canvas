import crypto from "node:crypto";
import fs from "node:fs";

export type ImageTaskInput = {
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

export type ImageTaskResult = {
    taskId: string;
    status: "succeeded";
    mode: "simulated" | "openai-compatible";
    fallbackReason?: string;
    model: string;
    images: string[];
};

const SIMULATION_FALLBACK_REASON = "未配置 OPENAI_COMPATIBLE_IMAGE_API_KEY，当前返回模拟图片";

type ImageApiPayload = { data?: Array<{ b64_json?: string; url?: string }>; error?: { message?: string }; message?: string };

/** Run one OpenAI-compatible image task, using a deterministic mock when neither the request nor local settings provide a key. */
export async function runImageTask(input: ImageTaskInput, signal?: AbortSignal): Promise<ImageTaskResult> {
    const settings = loadImageSettings(input);
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
            fallbackReason: SIMULATION_FALLBACK_REASON,
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

function loadImageSettings(input: Pick<ImageTaskInput, "apiKey" | "baseUrl"> = {}) {
    const file = new URL("../../.env.local", import.meta.url);
    const values = fs.existsSync(file) ? parseEnv(fs.readFileSync(file, "utf8")) : {};
    const requestApiKey = input.apiKey?.trim() || "";
    return {
        apiKey: requestApiKey || process.env.OPENAI_COMPATIBLE_IMAGE_API_KEY || process.env.OPENAI_API_KEY || values.OPENAI_COMPATIBLE_IMAGE_API_KEY || values.OPENAI_API_KEY || "",
        baseUrl: requestApiKey && input.baseUrl?.trim() || process.env.OPENAI_COMPATIBLE_IMAGE_BASE_URL || process.env.OPENAI_BASE_URL || values.OPENAI_COMPATIBLE_IMAGE_BASE_URL || values.OPENAI_BASE_URL || "https://api.openai.com",
        model: process.env.OPENAI_COMPATIBLE_IMAGE_MODEL || values.OPENAI_COMPATIBLE_IMAGE_MODEL || "gpt-image-2",
    };
}

async function requestImageGeneration(settings: ReturnType<typeof loadImageSettings>, input: Required<Pick<ImageTaskInput, "prompt" | "model" | "count">> & ImageTaskInput, signal?: AbortSignal) {
    return requestJson(settings, imageUrl(settings.baseUrl, "/images/generations"), {
        model: input.model,
        prompt: input.prompt,
        n: input.count,
        ...responseFormat(input.model),
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
    if (supportsResponseFormat(input.model)) form.set("response_format", "b64_json");
    if (input.size) form.set("size", input.size);
    if (input.quality) form.set("quality", input.quality);
    if (input.background) form.set("background", input.background);
    for (const [index, image] of input.images.entries()) {
        const file = await imageFile(image, signal);
        form.append("image", file.blob, `reference-${index + 1}.${file.extension}`);
    }
    const response = await fetch(imageUrl(settings.baseUrl, "/images/edits"), { method: "POST", headers: { authorization: `Bearer ${settings.apiKey}` }, body: form, signal });
    return readResponse(response);
}

export function supportsResponseFormat(model: string) {
    return !/^gpt-image(?:-|$)/i.test(model.trim());
}

function responseFormat(model: string) {
    return supportsResponseFormat(model) ? { response_format: "b64_json" } : {};
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

async function imageFile(value: string, signal?: AbortSignal) {
    let bytes: Uint8Array;
    let declaredMime = "";
    if (!value.startsWith("data:")) {
        const response = await fetch(value, { signal });
        if (!response.ok) throw new Error(`参考图读取失败 (${response.status})`);
        declaredMime = response.headers.get("content-type") || "";
        bytes = new Uint8Array(await response.arrayBuffer());
    } else {
        const match = /^data:([^;,]+)?(;base64)?,(.*)$/s.exec(value);
        if (!match) throw new Error("参考图 Data URL 无效");
        declaredMime = match[1] || "";
        bytes = new Uint8Array(match[2] ? Buffer.from(match[3], "base64") : Buffer.from(decodeURIComponent(match[3])));
    }
    const mimeType = detectImageMime(bytes) || declaredMime.split(";", 1)[0].trim().toLowerCase() || "image/png";
    const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
    return { blob: new Blob([buffer], { type: mimeType }), extension: imageExtension(mimeType) };
}

function detectImageMime(bytes: Uint8Array) {
    if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 && bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a) return "image/png";
    if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
    const signature = String.fromCharCode(...bytes.slice(0, 12));
    if (signature.startsWith("GIF87a") || signature.startsWith("GIF89a")) return "image/gif";
    if (signature.startsWith("RIFF") && signature.slice(8, 12) === "WEBP") return "image/webp";
    if (signature.slice(4, 8) === "ftyp" && ["avif", "avis"].includes(signature.slice(8, 12))) return "image/avif";
    return "";
}

function imageExtension(mimeType: string) {
    if (mimeType === "image/jpeg") return "jpg";
    const subtype = mimeType.split("/", 2)[1]?.split("+", 1)[0] || "png";
    return /^[a-z0-9]+$/i.test(subtype) ? subtype.toLowerCase() : "png";
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
