#!/usr/bin/env node
import os from 'node:os';
import path from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import * as z from 'zod/v4';
import { DurableJobStore } from '../jobs/durable-store.mjs';
import { JobManager } from '../jobs/job-manager.mjs';
import { WebGptOrchestrationService } from './service.mjs';
import { createGoalLedgerService } from '../goals/service.mjs';

export const WEB_GPT_ORCHESTRATOR_TOOLS = [
  'plan_run',
  'start_role',
  'wait_role',
  'submit_result',
  'request_writer',
  'status',
  'cancel_run',
  'cleanup_run'
];

function response(value, isError = false) {
  return {
    content: [{ type: 'text', text: JSON.stringify(value) }],
    structuredContent: value,
    ...(isError ? { isError: true } : {})
  };
}

function safeError(error) {
  return response({ ok: false, error: error?.code ?? 'orchestration_failed', detail: error instanceof Error ? error.message : String(error) }, true);
}

function invoke(service, method) {
  return async input => {
    try { return response(await service[method](input)); }
    catch (error) { return safeError(error); }
  };
}

const requestId = z.string().min(8).max(200);
const runId = z.string().min(1).max(200);
const roleId = z.string().min(1).max(200);
const snapshotHash = z.string().regex(/^[a-f0-9]{64}$/);

export function createWebGptOrchestratorMcpServer(service) {
  const server = new McpServer({ name: 'web-gpt-orchestrator', version: '0.1.0' });

  server.registerTool('plan_run', {
    title: 'Web GPT 역할 run 계획',
    description: '현재 turn이 실제 광고한 tool ID와 surface를 고정하고 bounded role DAG를 내구 상태에 계획합니다. prompt나 transcript는 받지 않습니다.',
    inputSchema: {
      requestId,
      runId: runId.optional(),
      rootTaskId: z.string().min(1).max(200),
      parentGoal: z.object({
        goalId: z.string().min(1).max(200),
        sourceUpdatedAt: z.string().min(1).max(300),
        goalSnapshotHash: snapshotHash.optional().describe('선택적 사전 관측 목표 hash. 생략해도 새 run은 실제 목표 내용 hash를 고정합니다.'),
        authorityMode: z.enum(['COOPERATIVE', 'NATIVE']).optional(),
        ownerThreadId: z.string().min(1).max(300).optional(),
        stopEpoch: z.union([z.string().min(1).max(300), z.number().int().nonnegative()]).optional()
      }).strict().optional().describe('tracked 결속만 지원합니다. NATIVE/ownerThreadId/stopEpoch 요구는 실제 native owner reader 미등록으로 거절하며 COOPERATIVE로 격하하지 않습니다.'),
      workspaceId: z.string().min(1).max(300),
      routeId: z.string().min(1).max(200),
      identityBinding: z.string().min(1).max(300),
      surface: z.enum(['full', 'browser-only']),
      capabilityTtlSeconds: z.number().int().min(30).max(600).default(300),
      tools: z.array(z.object({ id: z.string().min(1).max(200), classes: z.array(z.enum(['read', 'write', 'browser', 'computer-use', 'network'])).min(1) })).min(1).max(100),
      roles: z.array(z.object({
        roleId,
        kind: z.enum(['coordinator', 'researcher', 'critic', 'solver', 'merger', 'writer', 'verifier']),
        mode: z.enum(['read-only', 'write']).optional(),
        dependencies: z.array(roleId).default([]),
        requiredToolIds: z.array(z.string().min(1).max(200)).default([]),
        requestRef: z.string().min(1).max(500).optional(),
        requestHash: snapshotHash.optional()
      })).min(1).max(100),
      budgets: z.object({
        defaultFanOut: z.number().int().min(1).max(64).optional(),
        hardActiveCap: z.number().int().min(1).max(64).optional()
      }).optional()
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  }, invoke(service, 'planRun'));

  const startSchema = { requestId, runId, roleId, capabilitySnapshotHash: snapshotHash };
  server.registerTool('start_role', {
    title: '읽기 역할 시작',
    description: '의존성, snapshot, cadence와 fan-out budget을 확인하고 read-only 역할 하나를 host-mediated dispatch로 시작합니다.',
    inputSchema: startSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  }, invoke(service, 'startRole'));

  server.registerTool('request_writer', {
    title: '단일 writer 요청',
    description: 'full surface의 선언된 writer 역할 하나만 exclusive workspace writer lease로 시작합니다.',
    inputSchema: startSchema,
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false }
  }, invoke(service, 'requestWriter'));

  server.registerTool('wait_role', {
    title: '역할 상태 확인',
    description: '역할의 job, attempt, terminal 상태와 검증 산출물 수를 prompt 본문 없이 조회합니다.',
    inputSchema: { runId, roleId },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  }, invoke(service, 'waitRole'));

  server.registerTool('submit_result', {
    title: '구조화 결과 제출',
    description: '활성 역할 결과는 기존 산출물 흐름으로 처리합니다. exact 원 attempt의 recordOnly/늦은 결과는 보존만 합니다. consume은 부모 관측 근거를 영수증에 저장하는 별도 ACK이며, 같은 소비 중복은 기존 ACK만 회수합니다. 부모 goal 완료는 추정하지 않습니다.',
    inputSchema: {
      requestId,
      runId,
      roleId,
      capabilitySnapshotHash: snapshotHash,
      resultId: z.string().min(1).max(200).optional(),
      action: z.enum(['record', 'consume']).default('record'),
      attemptId: z.string().min(1).max(200).optional(),
      operationId: z.string().min(1).max(200).optional(),
      requestHash: snapshotHash.optional(),
      recordOnly: z.boolean().optional(),
      adoption: z.object({
        resultHash: snapshotHash,
        consumerId: z.string().min(1).max(300),
        destination: z.string().min(1).max(500),
        effectKey: z.string().min(1).max(300),
        goalRevision: z.string().min(1).max(300),
        identityBinding: z.string().min(1).max(300),
        expectedRunUpdatedAt: z.string().datetime()
      }).optional(),
      claim: z.string().min(1).max(4000).optional(),
      evidence: z.array(z.object({ ref: z.string().min(1).max(1000), sha256: snapshotHash })).max(100).default([]),
      counterexample: z.string().max(4000).optional(),
      unknown: z.string().max(4000).optional(),
      recommendation: z.string().max(4000).optional(),
      validatorStatus: z.enum(['pending', 'pass', 'fail', 'unknown']).default('pending')
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  }, invoke(service, 'submitResult'));

  server.registerTool('status', {
    title: '오케스트레이션 상태',
    description: 'run metadata 또는 exact 원 소비 ACK를 읽기 전용으로 조정합니다. 만료·중지 뒤에도 기존 ACK만 회수하며 영수증 부재는 UNKNOWN이고 재전송 허가가 아닙니다.',
    inputSchema: { runId: runId.optional(), consumption: z.object({
      roleId, capabilitySnapshotHash: snapshotHash,
      resultId: z.string().min(1).max(200), attemptId: z.string().min(1).max(200),
      operationId: z.string().min(1).max(200), requestHash: snapshotHash,
      adoption: z.object({ resultHash: snapshotHash, consumerId: z.string().min(1).max(300),
        destination: z.string().min(1).max(500), effectKey: z.string().min(1).max(300),
        goalRevision: z.string().min(1).max(300), identityBinding: z.string().min(1).max(300) })
    }).optional() },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  }, invoke(service, 'status'));

  server.registerTool('cancel_run', {
    title: '소유 run 취소',
    description: '현재 run의 비종료 job만 취소하고 owned target cleanup을 요청합니다. 사용자나 foreign target은 범위 밖입니다.',
    inputSchema: { requestId, runId, reason: z.string().min(1).max(500).optional() },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false }
  }, invoke(service, 'cancelRun'));

  server.registerTool('cleanup_run', {
    title: '종료 run 정리',
    description: '모든 역할이 terminal일 때 snapshot을 revoke하고 run이 소유한 lease record만 정리합니다. 감사 job/artifact는 보존합니다.',
    inputSchema: { requestId, runId },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false }
  }, invoke(service, 'cleanupRun'));

  return server;
}

export function createDefaultOrchestrationService(options = {}) {
  const stateRoot = options.stateRoot ?? process.env.AICC_STATE_ROOT?.trim() ?? path.join(os.homedir(), '.ai-control-center');
  const store = options.store ?? new DurableJobStore({ root: path.join(stateRoot, 'jobs') });
  const manager = options.manager ?? new JobManager({ store });
  return new WebGptOrchestrationService({
    store,
    manager,
    goalLedger: options.goalLedger ?? createGoalLedgerService({ ownerRoot: stateRoot }),
    artifactRoot: options.artifactRoot ?? path.join(stateRoot, 'jobs', 'orchestration-results'),
    now: options.now
  });
}

export async function startWebGptOrchestratorMcp(options = {}) {
  const service = options.service ?? createDefaultOrchestrationService(options);
  const server = createWebGptOrchestratorMcpServer(service);
  const transport = options.transport ?? new StdioServerTransport();
  await server.connect(transport);
  if (!options.transport) console.error('[web-gpt-orchestrator] ready tools=8');
  return server;
}
