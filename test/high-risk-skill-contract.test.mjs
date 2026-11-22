import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const skill = readFileSync(new URL("../guidance/skills/high-risk-change/SKILL.md", import.meta.url), "utf8");

test("authorized reversible metadata has proportionate recovery", () => {
  assert.match(skill, /별도의 반복 승인 게이트가 아니다/);
  assert.match(skill, /이름 수정에는 대상 ID·원래 이름·공개 범위 보존/);
  assert.match(skill, /순서 수정에는 정확한 기존 순서 보존이면 된다/);
  assert.match(skill, /전체 데이터 백업·서버 접속·새 복구 스크립트를 선행 조건으로 강제하지 않는다/);
});

test("recovery does not require ritual reporting or override tool restrictions", () => {
  assert.match(skill, /선행 보고·네 가지 명령 전달·별도 계획서·반복 체크리스트는 의무가 아니다/);
  assert.match(skill, /도구의 명시적 차단을 우회하거나/);
  assert.match(skill, /사람만 가능한 인증 또는 제품의 필수 확인만 개입을 요청한다/);
  assert.doesNotMatch(skill, /복구 스크립트를 만들고 검증한다\. 이어서 사용자가/);
});
