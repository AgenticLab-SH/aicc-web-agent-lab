// aicc supervise <status|plan|logs|start|add-group|end-group|close-tab|confirm> [--run <이름|폴더>] [--json]
// 변경 명령(start·add-group·end-group·close-tab)은 미리보기와 확인 토큰만 만든다.
// 실제 실행은 `aicc supervise confirm --confirmation <토큰>` 한 번뿐이다.
import { ACTIONS, STATE_LABELS, createSupervisedRunService } from './service.mjs';

export const SUPERVISE_HELP = `aicc supervise status [--run <이름|폴더>] [--json]
                       관제 실행 목록과 그룹별 상태(차례 진행/대기/종료)·마지막 PROGRESS 시각
  aicc supervise plan --json < start.json
                       새 실행 준비 내용 확인(쓰지 않음)
  aicc supervise logs --run <이름> [--lines 30] [--json]
                       깨우기 기록·S0 기록·그룹 PROGRESS 끝부분
  aicc supervise start|add-group|end-group|close-tab|wake-group --json < 입력.json
                       변경 미리보기와 일회용 확인 토큰 발급
  aicc supervise confirm --confirmation <토큰> [--json]
                       미리 본 변경을 한 번 실행하고 전후 상태 확인`;

function option(argv, name) {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
}

function printStatus(result, out) {
  if (!result.runs.length) { out(`관제 실행 없음 (${result.runsRoot})`); return; }
  for (const run of result.runs) {
    if (run.error) { out(`! ${run.runName}: ${run.error.message}`); continue; }
    out(`${run.runName} · 기한 ${run.deadline ?? '-'}${run.deadlinePassed ? ' (지남)' : ''} · 마지막 깨우기 ${run.lastWakeAt ?? '-'}`);
    for (const group of [...(run.s0 ? [run.s0] : []), ...run.groups, ...run.endedGroups]) {
      out(`  ${group.name.padEnd(4)} ${group.runner.padEnd(5)} ${(STATE_LABELS[group.state] ?? group.state).padEnd(8)} PROGRESS ${group.lastProgressAt ?? '-'}`);
    }
  }
}

export async function runSuperviseCommand(argv, { readJsonStdin, log = console.log, service } = {}) {
  const sub = argv[0] || 'status';
  const json = argv.includes('--json');
  const svc = service ?? createSupervisedRunService();
  const emit = result => { if (json) log(JSON.stringify(result, null, 2)); return result; };
  if (sub === 'status') {
    const result = await svc.status({ run: option(argv, '--run') });
    if (json) emit(result); else printStatus(result, log);
    return result;
  }
  if (sub === 'plan') {
    const result = svc.plan(await readJsonStdin(65_536, 'supervise plan'));
    if (json) emit(result); else log(`${result.ok ? '준비 가능' : '충돌'} · 정본 ${result.canonicalState}\n${[...result.conflicts, ...result.wouldCreate.map(file => `생성: ${file}`)].join('\n')}`);
    return result;
  }
  if (sub === 'logs') {
    const result = svc.logs({ run: option(argv, '--run'), lines: Number(option(argv, '--lines') ?? 30) });
    if (json) emit(result);
    else {
      log('# wake-log'); result.wakeLog.forEach(line => log(line));
      log('# SUPERVISOR-LOG'); result.supervisorLog.forEach(line => log(line));
      for (const group of result.groups) { log(`# ${group.name} PROGRESS`); group.lines.forEach(line => log(line)); }
    }
    return result;
  }
  if (ACTIONS.includes(sub)) {
    const input = await readJsonStdin(65_536, `supervise ${sub}`);
    const result = await svc.preview(sub, input);
    if (json) emit(result); else log(`${result.impact}\n복구: ${result.rollback}\n확인 토큰: ${result.confirmationToken}\n유효 시각: ${result.expiresAt}`);
    return result;
  }
  if (sub === 'confirm') {
    const token = option(argv, '--confirmation');
    if (!token) throw new Error('--confirmation 토큰이 필요합니다.');
    const result = await svc.confirm(token);
    if (json) emit(result); else log(`${result.ok ? '✓' : '!'} ${result.action} · 확인 ${result.verified ? '통과' : '실패'}${result.rollback?.attempted ? ` · 되돌리기 ${result.rollback.restored ? '완료' : '불완전'}` : ''}`);
    if (!result.ok) process.exitCode = 1;
    return result;
  }
  throw new Error(`알 수 없는 supervise 명령: ${sub}\n${SUPERVISE_HELP}`);
}
