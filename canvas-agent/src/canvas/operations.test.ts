import assert from "node:assert/strict";
import test from "node:test";

import { buildCanvasToolRequest } from "./operations.js";

test("纯引用提示词复用已有节点，不创建包装文本节点", () => {
    const request = buildCanvasToolRequest("canvas_create_generation_flow", { mode: "image", prompt: "@[node:prompt-1] @[node:reference-1]", referenceNodeIds: ["prompt-1", "reference-1"] }, null);
    const ops = request.input.ops as Array<Record<string, unknown>>;
    assert.equal(ops.filter((op) => op.type === "add_node").length, 1);
    assert.deepEqual(ops.filter((op) => op.type === "connect_nodes").map((op) => op.fromNodeId), ["prompt-1", "reference-1"]);
});

test("带有正文的提示词保留包装文本节点", () => {
    const request = buildCanvasToolRequest("canvas_create_generation_flow", { mode: "image", prompt: "@[node:prompt-1] 请生成三种方案", referenceNodeIds: ["prompt-1"] }, null);
    const ops = request.input.ops as Array<Record<string, unknown>>;
    assert.equal(ops.filter((op) => op.type === "add_node").length, 2);
    assert.equal(ops.filter((op) => op.type === "connect_nodes").length, 2);
});
