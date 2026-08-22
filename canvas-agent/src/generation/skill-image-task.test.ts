import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { buildAigcImageCommand, buildGeneralImageCommands, decodeProcessOutput, runSkillImageTask } from "./skill-image-task.js";

test("通用生图 Skill 可通过本机 mock 完成端到端文件回填而不联网", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "canvas-skill-mock-"));
    const script = path.join(directory, "mock-skill.mjs");
    await writeFile(script, `import fs from "node:fs";
import path from "node:path";
const args = process.argv.slice(2);
const output = args[args.indexOf("--output") + 1];
const count = Number(args[args.indexOf("--n") + 1] || 1);
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
for (let index = 1; index <= count; index += 1) fs.writeFileSync(path.join(path.dirname(output), count === 1 ? path.basename(output) : \`result-\${index}.png\`), png);
`, "utf8");
    const previousScript = process.env.CANVAS_AGENT_GENERAL_IMAGE_SCRIPT;
    const previousPython = process.env.CANVAS_AGENT_PYTHON;
    let result: Awaited<ReturnType<typeof runSkillImageTask>> | undefined;
    process.env.CANVAS_AGENT_GENERAL_IMAGE_SCRIPT = script;
    process.env.CANVAS_AGENT_PYTHON = process.execPath;
    try {
        result = await runSkillImageTask({ executor: "general-image-generation", prompt: "本地模拟", count: 2 });
        assert.equal(result.images.length, 2);
        assert.equal(result.localPaths.length, 2);
        assert.ok(result.images.every((image) => image.startsWith("data:image/png;base64,")));
    } finally {
        if (previousScript === undefined) delete process.env.CANVAS_AGENT_GENERAL_IMAGE_SCRIPT;
        else process.env.CANVAS_AGENT_GENERAL_IMAGE_SCRIPT = previousScript;
        if (previousPython === undefined) delete process.env.CANVAS_AGENT_PYTHON;
        else process.env.CANVAS_AGENT_PYTHON = previousPython;
        if (result?.localPaths[0]) await rm(path.dirname(result.localPaths[0]), { recursive: true, force: true });
        await rm(directory, { recursive: true, force: true });
    }
});

test("通用生图 Skill 文生图使用单次 n 变体并保持快速路径参数", () => {
    const commands = buildGeneralImageCommands({ executor: "general-image-generation", prompt: "蓝色海报", count: 3, model: "gpt-image-2" }, [], "C:\\outputs");
    assert.equal(commands.length, 1);
    assert.deepEqual(argumentValues(commands[0].args, "--n"), ["3"]);
    assert.deepEqual(argumentValues(commands[0].args, "--quality"), ["medium"]);
    assert.deepEqual(argumentValues(commands[0].args, "--response-format"), ["b64_json"]);
    assert.deepEqual(argumentValues(commands[0].args, "--retries"), ["0"]);
});

test("通用生图 Skill 图生图按数量逐次运行并保持参考图顺序", () => {
    const references = ["C:\\refs\\first.png", "C:\\refs\\second.jpg"];
    const commands = buildGeneralImageCommands({ executor: "general-image-generation", prompt: "只改背景", count: 2, model: "gpt-image-2" }, references, "C:\\outputs");
    assert.equal(commands.length, 2);
    assert.deepEqual(argumentValues(commands[0].args, "--input"), references);
    assert.deepEqual(argumentValues(commands[1].args, "--input"), references);
    assert.equal(commands[0].args.includes("--n"), false);
});

test("AIGC CLI GPT Image 命令不擅自指定供应商并下载到独立目录", () => {
    const command = buildAigcImageCommand({ executor: "aigc-cli", prompt: "商品主图", count: 2, model: "gpt-image-2", quality: "high" }, ["C:\\refs\\one.png"], "C:\\outputs");
    assert.deepEqual(argumentValues(command.args, "--model"), ["gpt-image-2"]);
    assert.deepEqual(argumentValues(command.args, "--image"), ["C:\\refs\\one.png"]);
    assert.deepEqual(argumentValues(command.args, "--n"), ["2"]);
    assert.deepEqual(argumentValues(command.args, "--local-output-dir"), ["C:\\outputs"]);
    assert.equal(command.args.includes("--supplier"), false);
});

test("AIGC CLI Nano Banana 使用有序 part 和原生重复参数", () => {
    const command = buildAigcImageCommand({ executor: "aigc-cli", prompt: "保持人物", count: 2, model: "nano-banana-2", size: "4:3" }, ["C:\\refs\\one.png"], "C:\\outputs");
    assert.deepEqual(argumentValues(command.args, "--part"), ["text:保持人物", "image:C:\\refs\\one.png"]);
    assert.deepEqual(argumentValues(command.args, "--aspect"), ["4:3"]);
    assert.deepEqual(argumentValues(command.args, "--repeat-count"), ["2"]);
    assert.equal(command.args.includes("--quality"), false);
});

test("Windows Skill 错误输出兼容 GB18030 编码", () => {
    const bytes = Buffer.from("等待完成后由 CLI 返回", "utf8");
    const gb18030 = Buffer.from("b5c8b4fdcdeab3c9baf3d3c920434c4920b7b5bbd8", "hex");
    assert.equal(decodeProcessOutput(bytes), "等待完成后由 CLI 返回");
    assert.equal(decodeProcessOutput(gb18030), "等待完成后由 CLI 返回");
});

function argumentValues(args: string[], name: string) {
    const values: string[] = [];
    args.forEach((value, index) => {
        if (value === name && args[index + 1]) values.push(args[index + 1]);
    });
    return values;
}
