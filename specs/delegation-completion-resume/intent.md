# 위임 작업 완료 후 원래 대화 자동 재개

- ID: INT-DELEGATION-COMPLETION-RESUME
- Status: draft
- Owner: AICC 통합 담당
- Target: open-AICC 및 기존 비공개 Web GPT 실행 adapter
- Supersedes: none
- 작성: 2026-10-18 KST

## Problem

코덱스나 지피티가 다른 대화에 검수·설계·작업을 맡긴 뒤 결과를 기다리는 동안 원래 대화의 실행이 끝난다. 결과가 나와도 원래 대화가 자동으로 재개되지 않아 사람이 회수하거나 대화마다 예약 작업을 만든다. 대기 중인 실행을 유지하는 기능과, 종료된 실행을 다시 시작하는 기능을 구분해야 한다.

## Evidence

- 사용자가 최근 코덱스·지피티 대화의 결과 회수 지연과 반복 예약을 보고했다.
- 기존 Web 응답 observer, Codex task callback, Codex→Web followup 구현은 있으나 모든 위임 요청 경로에 자동 결속되어 있지는 않다. 상세는 spec.md의 기존 구성요소 표를 따른다.
- 최근 읽은 사례에는 검수 요청과 나중 결과 회수가 별도로 기록되어 있었다. 그 시간 간격만으로 응답 완료 시각이나 지연 원인을 단정하지 않는다.
- 현재 공식 ChatGPT MCP Events의 대상은 Work 대화다. 일반 Chat의 완료 통지를 이것으로 해결했다고 간주할 수 없다.

## Desired outcome

사용자가 승인한 위임 작업을 보내면 원래 대화의 정확한 복귀 목적지가 함께 등록된다. 작업이 완료되거나 실패하면 결과를 보존하고, 원래 대화가 적절한 상태일 때 결과 도착을 알린다. 원래 대화는 최신 사용자 목표와 남은 일을 읽고 계속한다. 사용자가 중지했거나 지시를 바꿨다면 그 의사를 따른다.

## Affected users and systems

- Users: 코덱스 CLI·Desktop 및 지피티 일반 Chat에서 위임 작업을 사용하는 사용자.
- Systems: 기존 AICC 작업 저장소·observer·callback·followup·등록 브라우저 adapter·공식 Codex 제어 연결.

## Constraints

- 일반 Chat 및 요청된 xhigh/Extra High를 유지한다. Work 전환이나 다른 모델 경로로의 묵시적 대체를 하지 않는다.
- 대기 중 모델 호출과 대화별 반복 예약을 만들지 않는다. 기존 서비스의 결정적 worker가 등록된 작업만 관찰한다.
- 원래 대화·계정·workspace·작업·turn을 불변 식별자로 결속한다. 제목으로 목적지를 추측하지 않는다.
- 불명 전송을 재전송하지 않는다. 큐 등록·전송 접수·대화 재개·결과 소비·사용자 목표 완료를 구분한다.
- 기존 저장소·연결·배포기를 확장한다. 독립적인 거대 관제 시스템이나 중복 원장을 만들지 않는다.
- 기존 계정·초안·다른 실행·원본·dirty checkout 및 보안 거절을 보존한다.

## Out of scope

- 모든 개인 대화를 상시 수집하거나 요청하지 않은 대화를 자동으로 재개하는 일.
- 설계만으로 실제 자동 재개가 작동한다고 선언하는 일.
- 이번 설계 작성 중 서비스 설치·상주 worker 기동·다른 대화 전송·새 예약 작업 생성.
- 사용자 중지 무시, 권한 확대, 자동 게시·배포 권한 확대.

## Success signals

- 코덱스→지피티→코덱스, 지피티→코덱스→지피티, 지피티→지피티→지피티와 코덱스→코덱스가 원래 대화로 돌아와 남은 승인 작업을 잇는다.
- 대기 중 모델 호출 0회, 대화별 반복 예약 0개. 실제 재개에 사용한 모델 호출은 별도로 기록한다.
- 실패·재시작·중복 이벤트·목적지 실행 중·사용자 중지·불명 전송 시나리오에서도 잘못된 대화 전송과 확인 없는 재전송이 없다.
- 각 흐름에서 실제 새 turn 및 결과 소비 근거를 남기며 큐 등록만으로 성공 처리하지 않는다.

## Open questions

- 현재 Windows Desktop이 실제 사용하는 공유 제어 endpoint와 지원되는 연결 owner — owner: 기존 Desktop integration 담당 — resolve before: Desktop 재개 구현·실사용 수용.
- 현재 observer/followup의 상주 host와 브라우저 종료 후 복귀 동작 — owner: 기존 Web adapter 담당 — resolve before: 무인 실사용 수용.
- 일반 Chat의 공식 이벤트 지원 확대 여부 — owner: 플랫폼 담당 — resolve before: 해당 공식 adapter 채택. 현재는 AICC 경로로 설계하며 이 지원을 기다리지 않는다.

## Decision

- 사용자가 요청한 설계 초안이다. 구현·설치·실사용 수용은 별도 단계이며 현재 완료로 표시하지 않는다.
