export const updatedAt = '2026-01-01T00:00:00Z';

export const states = Object.freeze({
  WEB: { label: '웹에서 열기', action: '열기' },
  INSTALLABLE: { label: '설치 가능', action: '설치 안내' },
  UPDATE_AVAILABLE: { label: '업데이트 가능', action: '업데이트 안내' },
  PC_ONLY: { label: 'PC 전용' },
  UNAVAILABLE: { label: '주소 미등록' },
  RETIRED: { label: '사용 종료' },
});

export const apps = Object.freeze([
  { id: 'notes-demo', title: '샘플 메모', description: '짧은 체크리스트를 확인합니다.', state: 'WEB' },
  { id: 'reader-demo', title: '샘플 읽기', description: '휴대폰에 설치할 수 있는 예시입니다.', state: 'INSTALLABLE' },
  { id: 'focus-demo', title: '샘플 집중', description: '새 버전 안내가 있는 예시입니다.', state: 'UPDATE_AVAILABLE' },
  { id: 'studio-demo', title: '샘플 작업실', description: 'PC에서 사용하는 예시입니다.', state: 'PC_ONLY' },
  { id: 'archive-demo', title: '샘플 자료실', description: '실행 주소 등록을 기다리는 예시입니다.', state: 'UNAVAILABLE' },
  { id: 'board-demo', title: '샘플 보드', description: '이력만 확인할 수 있는 예시입니다.', state: 'RETIRED' },
]);

export function filterApps(entries, query, state) {
  const search = query.trim().toLocaleLowerCase('ko-KR');
  return entries.filter((app) => (state === 'all' || app.state === state)
    && `${app.title} ${app.description}`.toLocaleLowerCase('ko-KR').includes(search));
}
