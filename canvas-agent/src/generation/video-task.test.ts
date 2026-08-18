import assert from "node:assert/strict";
import test from "node:test";

import { createSimulatedVideoTask, getSimulatedVideoTask } from "./video-task.js";

test("本地视频模拟任务可创建并返回可播放 MP4", () => {
    const task = createSimulatedVideoTask({ prompt: "产品镜头从左至右平移" });
    assert.equal(task.mode, "simulated");
    assert.equal(task.status, "queued");
    const completed = getSimulatedVideoTask(task.taskId);
    assert.equal(completed?.status, "succeeded");
    assert.match(completed?.videoDataUrl || "", /^data:video\/mp4;base64,/);
});

test("未知视频模拟任务不会伪造结果", () => {
    assert.equal(getSimulatedVideoTask("unknown-task"), null);
});
