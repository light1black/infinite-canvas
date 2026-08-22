import { execFileSync, spawn } from "node:child_process";
import crypto from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { TextDecoder } from "node:util";

import { CONFIG_DIR } from "../config.js";

export type SkillImageExecutor = "general-image-generation" | "aigc-cli";

export type SkillImageTaskInput = {
    executor: SkillImageExecutor;
    prompt: string;
    images?: string[];
    model?: string;
    size?: string;
    quality?: string;
    background?: string;
    count?: number;
};

export type SkillImageTaskResult = {
    taskId: string;
    status: "succeeded";
    mode: SkillImageExecutor;
    model: string;
    images: string[];
    localPaths: string[];
};

type ProcessCommand = { command: string; args: string[] };

const IMAGE_EXTENSIONS = new Set([".avif", ".gif", ".jpeg", ".jpg", ".png", ".webp"]);

/** 通过已安装的 Codex Skill 执行图片任务，并把结果保存在用户本机。 */
export async function runSkillImageTask(input: SkillImageTaskInput, signal?: AbortSignal): Promise<SkillImageTaskResult> {
    const executor = skillExecutor(input.executor);
    const prompt = input.prompt?.trim();
    if (!prompt) throw new Error("Skill 图片任务提示词不能为空");
    const count = Math.max(1, Math.min(10, Math.floor(Number(input.count) || 1)));
    const model = executor === "general-image-generation" ? "gpt-image-2" : aigcModel(input.model);
    const taskId = `skill-image-${crypto.randomUUID()}`;
    const outputDir = path.join(CONFIG_DIR, "generated", taskId);
    const referenceDir = await mkdtemp(path.join(os.tmpdir(), "infinite-canvas-skill-"));
    await mkdir(outputDir, { recursive: true });

    try {
        const references = await writeReferences(input.images || [], referenceDir);
        if (executor === "general-image-generation") {
            for (const command of buildGeneralImageCommands({ ...input, prompt, count, model }, references, outputDir)) await runProcess(command, signal);
        } else {
            const batches = splitPairedAigcReferences(references, count);
            if (batches) {
                // Treat the first image as the shared scene and process each
                // following source image in its own request.
                for (const [index, batch] of batches.entries()) {
                    const batchDir = path.join(outputDir, `pair-${index + 1}`);
                    await mkdir(batchDir, { recursive: true });
                    await runProcess(buildAigcImageCommand({ ...input, prompt, count: 1, model }, batch, batchDir), signal);
                }
            } else {
                await runProcess(buildAigcImageCommand({ ...input, prompt, count, model }, references, outputDir), signal);
            }
        }
        const localPaths = await imageFiles(outputDir);
        if (!localPaths.length) throw new Error(`${skillLabel(executor)} 已完成，但没有找到可用的本机图片结果`);
        return {
            taskId,
            status: "succeeded",
            mode: executor,
            model,
            localPaths,
            images: await Promise.all(localPaths.map(fileDataUrl)),
        };
    } finally {
        await rm(referenceDir, { recursive: true, force: true });
    }
}

function splitPairedAigcReferences(references: string[], count: number) {
    if (references.length !== 3 || count !== 2) return null;
    return [[references[0], references[1]], [references[0], references[2]]];
}

/** 构造通用生图 Skill 的原生命令；图生图多结果逐次执行，避免网关忽略 n。 */
export function buildGeneralImageCommands(input: Required<Pick<SkillImageTaskInput, "prompt" | "count" | "model">> & SkillImageTaskInput, references: string[], outputDir: string): ProcessCommand[] {
    const script = process.env.CANVAS_AGENT_GENERAL_IMAGE_SCRIPT || path.join(os.homedir(), ".codex", "skills", "general-image-generation", "scripts", "generate_image.py");
    const python = process.env.CANVAS_AGENT_PYTHON || "python";
    const runs = references.length ? input.count : 1;
    return Array.from({ length: runs }, (_, index) => {
        const output = path.join(outputDir, runs === 1 ? "result.png" : `result-${index + 1}.png`);
        const args = [script, "--prompt", input.prompt, "--output", output, "--model", "gpt-image-2", "--quality", input.quality || "medium", "--response-format", "b64_json", "--retries", "0"];
        if (!references.length) args.push("--n", String(input.count));
        if (input.size) args.push("--size", input.size);
        if (input.background) args.push("--background", input.background);
        for (const reference of references) args.push("--input", reference);
        return { command: python, args };
    });
}

/** 构造 AIGC CLI Skill 命令，并保持供应商默认值不变。 */
export function buildAigcImageCommand(input: Required<Pick<SkillImageTaskInput, "prompt" | "count" | "model">> & SkillImageTaskInput, references: string[], outputDir: string): ProcessCommand {
    const root = process.env.CANVAS_AGENT_AIGC_SKILL_DIR || path.join(os.homedir(), ".codex", "skills", "aigc-cli");
    const windows = process.platform === "win32";
    const launcher = path.join(root, windows ? "run.ps1" : "run.sh");
    const args = windows
        ? ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", launcher, "scripts/image_generate.py"]
        : [launcher, "scripts/image_generate.py"];
    args.push("--model", input.model);
    if (input.model === "nano-banana-2") {
        args.push("--part", `text:${input.prompt}`);
        for (const reference of references) args.push("--part", `image:${reference}`);
        if (isAigcAspect(input.size)) args.push("--aspect", input.size!);
        args.push("--repeat-count", String(input.count));
    } else {
        args.push("--prompt", input.prompt);
        for (const reference of references) args.push("--image", reference);
        if (input.size) args.push("--size", input.size);
        if (input.quality) args.push("--quality", input.quality);
        if (input.background) args.push("--background", input.background);
        args.push("--n", String(input.count));
    }
    args.push("--wait", "--local-output-dir", outputDir, "--retry-count", "0");
    return { command: windows ? "powershell.exe" : "sh", args };
}

async function writeReferences(images: string[], directory: string) {
    return await Promise.all(images.filter(Boolean).map(async (image, index) => {
        const parsed = parseImageDataUrl(image);
        const filePath = path.join(directory, `reference-${index + 1}.${parsed.extension}`);
        await writeFile(filePath, parsed.bytes);
        return filePath;
    }));
}

function parseImageDataUrl(value: string) {
    const match = /^data:([^;,]+)?(;base64)?,(.*)$/s.exec(value);
    if (!match || !String(match[1] || "").startsWith("image/")) throw new Error("Skill 参考图必须是画布已解析的图片 Data URL");
    const bytes = match[2] ? Buffer.from(match[3], "base64") : Buffer.from(decodeURIComponent(match[3]));
    const mimeType = detectImageMime(bytes) || String(match[1] || "image/png").toLowerCase();
    return { bytes, extension: imageExtension(mimeType) };
}

async function imageFiles(directory: string): Promise<string[]> {
    const entries = await readdir(directory, { withFileTypes: true });
    const files: string[] = (await Promise.all(entries.map(async (entry): Promise<string[]> => {
        const entryPath = path.join(directory, entry.name);
        if (entry.isDirectory()) return imageFiles(entryPath);
        return entry.isFile() && IMAGE_EXTENSIONS.has(path.extname(entry.name).toLowerCase()) ? [entryPath] : [];
    }))).flat().sort();
    return (await Promise.all(files.map(async (filePath) => (await stat(filePath)).size > 0 ? filePath : ""))).filter(Boolean);
}

async function fileDataUrl(filePath: string) {
    const bytes = await readFile(filePath);
    const mimeType = detectImageMime(bytes) || mimeFromExtension(path.extname(filePath));
    return `data:${mimeType};base64,${bytes.toString("base64")}`;
}

function runProcess(processCommand: ProcessCommand, signal?: AbortSignal) {
    return new Promise<void>((resolve, reject) => {
        if (signal?.aborted) return reject(abortError());
        const child = spawn(processCommand.command, processCommand.args, { windowsHide: true, shell: false, env: skillEnvironment() });
        let stdout = Buffer.alloc(0);
        let stderr = Buffer.alloc(0);
        const append = (current: Buffer, chunk: Buffer) => Buffer.concat([current, chunk]).subarray(-16_000);
        child.stdout.on("data", (chunk: Buffer) => (stdout = append(stdout, chunk)));
        child.stderr.on("data", (chunk: Buffer) => (stderr = append(stderr, chunk)));
        const abort = () => child.kill();
        signal?.addEventListener("abort", abort, { once: true });
        child.once("error", (error) => {
            signal?.removeEventListener("abort", abort);
            reject(new Error(`无法启动 Skill：${error.message}`));
        });
        child.once("close", (code) => {
            signal?.removeEventListener("abort", abort);
            if (signal?.aborted) return reject(abortError());
            if (code === 0) return resolve();
            reject(new Error(processError(decodeProcessOutput(stderr.length ? stderr : stdout), code)));
        });
    });
}

function skillEnvironment() {
    const values = localImageEnv();
    const apiKey = process.env.GPT_IMAGE_API_KEY || values.GPT_IMAGE_API_KEY || process.env.OPENAI_COMPATIBLE_IMAGE_API_KEY || values.OPENAI_COMPATIBLE_IMAGE_API_KEY || "";
    const baseUrl = process.env.GPT_IMAGE_BASE_URL || values.GPT_IMAGE_BASE_URL || process.env.OPENAI_COMPATIBLE_IMAGE_BASE_URL || values.OPENAI_COMPATIBLE_IMAGE_BASE_URL || "";
    const pythonVersion = process.platform === "win32" && !process.env.PY_PYTHON3 ? discoverWindowsPythonVersion() : "";
    return {
        ...process.env,
        PYTHONIOENCODING: process.env.PYTHONIOENCODING || "utf-8",
        ...(pythonVersion ? { PY_PYTHON3: pythonVersion } : {}),
        ...(apiKey ? { GPT_IMAGE_API_KEY: apiKey } : {}),
        ...(baseUrl ? { GPT_IMAGE_BASE_URL: baseUrl } : {}),
    };
}

function discoverWindowsPythonVersion() {
    try {
        const listing = execFileSync("py", ["-0p"], { encoding: "utf8", timeout: 3_000, windowsHide: true });
        const versions = [...listing.matchAll(/-V:(\d+\.\d+)/g)].map((match) => match[1]);
        for (const version of versions) {
            try {
                execFileSync("py", [`-${version}`, "--version"], { encoding: "utf8", timeout: 3_000, windowsHide: true, stdio: ["ignore", "pipe", "ignore"] });
                return version;
            } catch {
                // Skip stale Python launcher entries and try the next installed version.
            }
        }
    } catch {
        // Leave the launcher default untouched when Python discovery is unavailable.
    }
    return "";
}

function localImageEnv(): Record<string, string> {
    try {
        const source = requireEnvSource();
        return Object.fromEntries(source.split(/\r?\n/).map((line) => line.trim()).filter((line) => line && !line.startsWith("#") && line.includes("=")).map((line) => {
            const index = line.indexOf("=");
            return [line.slice(0, index).trim(), line.slice(index + 1).trim().replace(/^(['"])(.*)\1$/, "$2")];
        }));
    } catch {
        return {};
    }
}

function requireEnvSource() {
    // Keep the same local-only credential source as the existing image adapter.
    return readFileSync(new URL("../../.env.local", import.meta.url), "utf8");
}

function skillExecutor(value: unknown): SkillImageExecutor {
    if (value === "general-image-generation" || value === "aigc-cli") return value;
    throw new Error("不支持的 Skill 图片执行器");
}

function aigcModel(value: unknown) {
    return value === "nano-banana-2" ? value : "gpt-image-2";
}

function skillLabel(executor: SkillImageExecutor) {
    return executor === "aigc-cli" ? "AIGC CLI Skill" : "通用生图 Skill";
}

export function decodeProcessOutput(bytes: Uint8Array) {
    const utf8 = new TextDecoder("utf-8").decode(bytes);
    if (!utf8.includes("\uFFFD")) return utf8;
    const gb18030 = new TextDecoder("gb18030").decode(bytes);
    return gb18030.includes("\uFFFD") ? utf8 : gb18030;
}

function processError(output: string, code: number | null) {
    const detail = output.trim().split(/\r?\n/).slice(-8).join("\n");
    return detail ? `Skill 执行失败 (${code ?? "unknown"})：${detail}` : `Skill 执行失败 (${code ?? "unknown"})`;
}

function abortError() {
    return Object.assign(new Error("Skill 图片任务已取消"), { name: "AbortError" });
}

function isAigcAspect(value?: string) {
    return Boolean(value && /^(?:1:1|1:4|1:8|2:3|3:2|3:4|4:3|4:1|4:5|5:4|8:1|9:16|16:9|21:9)$/.test(value));
}

function detectImageMime(bytes: Uint8Array) {
    if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 && bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a) return "image/png";
    if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
    const signature = Buffer.from(bytes.slice(0, 12)).toString("latin1");
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

function mimeFromExtension(extension: string) {
    if (/^\.jpe?g$/i.test(extension)) return "image/jpeg";
    if (/^\.gif$/i.test(extension)) return "image/gif";
    if (/^\.webp$/i.test(extension)) return "image/webp";
    if (/^\.avif$/i.test(extension)) return "image/avif";
    return "image/png";
}
