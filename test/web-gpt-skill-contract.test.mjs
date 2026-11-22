import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = path => {
  const text = readFileSync(new URL(`../${path}`, import.meta.url), "utf8").replace(/\r\n?/g, "\n");
  return path === "guidance/skills/use-web-gpt/SKILL.md"
    ? text + "\n" + read("guidance/skills/use-web-gpt/references/account-tab-ownership.md")
    : text;
};

test("ordinary Web GPT submission and attachments proceed autonomously without redundant confirmation", () => {
  const webGpt = read("guidance/skills/use-web-gpt/SKILL.md");
  const execution = read("guidance/skills/use-web-gpt/references/execution-contract.md");
  const highRisk = read("guidance/skills/high-risk-change/SKILL.md");

  assert.match(webGpt, /관련 파일 첨부, 전송, 같은 대화의 후속 전송을 승인한다/);
  assert.match(webGpt, /`보내도 될까요\?`를 묻거나 확인을 기다리지 않는다/);
  assert.match(execution, /전송 직전 사용자 승인을 다시\n묻거나 기다리지 않는다/);
  assert.match(highRisk, /별도의 반복 승인 게이트가 아니다/);
});

test("the default surface preserves the bound connection and tab budget is chosen dynamically", () => {
  const webGpt = read("guidance/skills/use-web-gpt/SKILL.md");
  const surface = read("guidance/skills/use-web-gpt/references/surface-selection.md");

  assert.match(webGpt, /지정이 없으면 현재 작업에 결속된 기존 연결을 우선한다/);
  assert.match(webGpt, /독립 작업 수, 목표의 긴급성, 예상 소요시간/);
  assert.match(surface, /실행 중 응답시간·오류·resource 변화를 관찰해\n  예산을 늘리거나 줄일 수 있다/);
  assert.match(webGpt, /root agent는 종료 전에 하위\s+agent의 소유 탭까지 같은 기준으로 판단한다/);
});

test("an explicit registered CDP port cannot fall back to a connector or in-app Browser", () => {
  const webGpt = read("guidance/skills/use-web-gpt/SKILL.md");
  const surface = read("guidance/skills/use-web-gpt/references/surface-selection.md");

  assert.match(webGpt, /명시된 CDP 포트는 account 별칭보다도 강한 실행 제약/);
  assert.match(surface, /HOLD_SURFACE_UNAVAILABLE/);
  assert.match(surface, /Chrome connector나 인앱 Browser로 우회하지 않는다/);
  assert.match(surface, /requested\/selected 값이 다르면 send는 0회다/);
});

test("response monitoring is event-driven and never wakes recurring agent heartbeats", () => {
  const webGpt = read("guidance/skills/use-web-gpt/SKILL.md");
  const execution = read("guidance/skills/use-web-gpt/references/execution-contract.md");

  assert.match(webGpt, /정확한 응답 감시[\s\S]*references\/execution-contract\.md/);
  assert.match(execution, /watch를 묶고 새 user\/assistant turn을\s+response-scoped로 증명한다/);
  assert.match(execution, /observer 실패를 재전송이나 surface 변경 사유로 삼지 않는다/);
  assert.match(execution, /장시간 응답은 Observer와 exact task callback one-shot으로\s+기다린다/);
  assert.match(execution, /장기 대기는 `execution-contract\.md`를 따른다/);
  assert.match(execution, /정확한 prompt SHA-256과 첨부 identity가\s+일치한 새 user-turn ID/);
  assert.match(execution, /assistant-turn ID만 추적한다/);
  assert.match(execution, /`notGenerating=true`, response-scoped completion action,\s+안정된 full content/);
  assert.match(execution, /옛 Observer 확장 첨부 주입과 `web_gpt_followup_enqueue` 자동 발신 dispatcher는\s+2026-10-11 폐기/);
  assert.match(execution, /watch와 exact task callback을 먼저 결합한 owner-only one-shot worker가 Observer의\s+terminal event를 기다리고/);
  assert.match(execution, /idle일 때 `turn\/start`를 정확히 한 번 호출한다/);
  assert.match(execution, /5분마다 UI를\s+조회하지 않는다/);
  assert.match(execution, /반복 heartbeat·recurring automation·DOM polling은\s+금지하며/);
  assert.match(execution, /observer\/callback을 묶을 수 없으면 `RESPONSE_HOLD`와 exact watch·conversation identity만\s+남기고 재전송하지 않는다/);
  assert.doesNotMatch(execution, /5분 주기로 관찰한다/);
});
