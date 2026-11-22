---
name: present-agent-terminal-status
description: 에이전트 소유 Windows 상태·대기 터미널을 관리한다. 백그라운드는 숨기고 전경에 목적을 표시한다.
---

# Present agent terminal status

Use this skill whenever an agent would start, reuse, diagnose, or leave open a terminal for a hook, wait, callback, MCP server, plugin helper, watcher, or long-running local operation.

## Choose the terminal mode

- Treat hooks, MCP stdio servers, plugin protocol processes, scheduled services, and unattended watchers as background work. Run them without a console window. On Windows use the host's no-window option such as `windowsHide: true`, `CREATE_NO_WINDOW`, or an owned WScript/task wrapper. Preserve protocol stdout; never print human banners into MCP or hook stdout.
- Use a visible terminal only when the computer user may need to observe, interrupt, authenticate, or recover a foreground operation. Do not open a raw `pwsh`, `cmd`, or Windows Terminal window merely to sleep or poll.
- Do not take over or rename a terminal the user opened. Reuse only an agent-owned terminal whose purpose and operation identity are already verified.

## Visible-terminal contract

Before the first wait, show all of the following in Korean:

- a bounded terminal title and purpose without secrets, account identifiers, raw arguments, or private payloads;
- the owning system or agent operation;
- start time in KST and continuously updated elapsed time;
- the current step and the last fresh progress signal;
- a real percentage or ETA only when the worker supplies it; otherwise say `진행률 산정 불가` or `예상 시간 산정 불가`;
- terminal outcomes as `완료`, `보류`, `실패`, or `상태 확인 필요`, with the next safe action.

If a progress signal becomes stale, keep the elapsed clock moving and say how long no new signal has arrived. A live process with an expired estimate is still waiting; never display zero remaining as if it were complete.

## Use the maintained launcher

For an AICC foreground wait on Windows, write progress, result, and worker PID to owner-controlled regular JSON files and open the maintained launcher instead of composing a shell polling loop:

```powershell
& 'C:/demo/open-AICC/tools/platform/aicc/Open-AiccProgressTerminal.ps1' `
  -Title 'AICC 작업 진행' `
  -Purpose '현재 작업의 안전한 완료 대기' `
  -Progress 'C:/absolute/owner/progress.json' `
  -Result 'C:/absolute/owner/result.json' `
  -Processes 'C:/absolute/owner/processes.json'
```

The launcher is for human presentation only. Keep the actual hook or MCP process hidden and keep its machine protocol on its original pipes. If the maintained launcher cannot represent the operation, extend it and its tests rather than opening an unlabeled terminal.

## Before finishing

- Inspect current agent-owned visible windows and scheduled-task actions without printing full command lines or secrets.
- Verify every background path has a no-window mechanism and every intended visible path has a Korean title, purpose, step, and elapsed clock.
- Run the focused terminal, hook, or task tests for the changed path. A source-only claim is insufficient when the local task or plugin is installed; also verify the installed state.

## 웹에서 상태와 제어 제공

사용자가 자동화·서비스·트레이를 PC·폰 웹에서 보고 조작하도록 요청하면 build-web-service-control을 함께 사용한다. 상태·제어는 기존 백엔드로 연결하고 백그라운드 실행은 계속 창 없이 유지한다.
