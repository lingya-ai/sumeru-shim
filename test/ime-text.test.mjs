import { test } from "node:test";
import assert from "node:assert/strict";

import { imeCommitText } from "../src/ime-text.mjs";

test("ASCII 原样保留，不做拼音映射", () => {
  assert.equal(imeCommitText(["nihao"]), "nihao");
  assert.equal(imeCommitText(["shijie"]), "shijie");
});

test("中文原样保留", () => {
  assert.equal(imeCommitText(["你好"]), "你好");
  assert.equal(imeCommitText(["你好", "世界"]), "你好 世界");
});

test("参数间空格与空字符串不被改写", () => {
  assert.equal(imeCommitText(["hello", "world"]), "hello world");
  assert.equal(imeCommitText(["hello", "", "world"]), "hello  world");
  assert.equal(imeCommitText([]), "");
});

test("混合文本与前后空格不被 trim", () => {
  assert.equal(imeCommitText(["  nihao  "]), "  nihao  ");
  assert.equal(imeCommitText(["abc", "你好", "xyz"]), "abc 你好 xyz");
});

test("undefined 参数被忽略，null 由 join 转为空字符串", () => {
  assert.equal(imeCommitText(["abc", undefined, "def"]), "abc def");
  assert.equal(imeCommitText([null]), "");
});

test("非数组输入明确失败", () => {
  assert.throws(() => imeCommitText("nihao"), TypeError);
});
