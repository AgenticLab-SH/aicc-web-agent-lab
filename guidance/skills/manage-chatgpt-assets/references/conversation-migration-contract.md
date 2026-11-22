# 대화 보존과 프로젝트 재구성

프로젝트 재편에 대화 이동 또는 계정 전체 누락 점검이 포함될 때 사용한다. 일반 대화 답변·모델 선택은 범위 밖이다.

## 범위와 보존

- 처음에 실제 account/workspace, 조회 시각, 대상 프로젝트 ID, 프로젝트 소속·프로젝트 밖·보관 대화의 포함 여부를 고정한다. 프로젝트 수나 첫 목록 페이지로 계정 전체 완료를 선언하지 않는다.
- 모든 목록의 pagination을 끝까지 읽고 대화 ID로 중복·누락·소속을 대조한다. 반복 cursor, 미지의 shape, 페이지 한도 초과, 변하는 offset 목록, 요청 실패는 incomplete/UNKNOWN이다. 실패한 목록을 0개로 기록하지 않는다.
- 기본 원장은 본문 없이 ID, 현재 소속, 목적 소속, action(move/retain), 검토 상태와 근거만 가진다. 분류에 본문이 필요하면 허용된 대화만 읽고 본문·원문 로그를 보고서에 복제하지 않는다.
- 보존식은 최초 ID 집합 + 작업 중 발견한 추가 ID 집합 = 최종 이동 ID 집합 + 원본 유지 ID 집합이다. 수량이 같아도 ID 또는 목적 소속이 다르면 완료가 아니다.
- 작업 중 추가된 대화는 별도 incremental plan으로 분류한다. 기존 plan hash를 고쳐 미확인 dispatch를 지우지 않는다. 응답 진행 중인 대화는 완료 또는 사용자 결정까지 원본에 둔다.
- 여러 목적이 섞인 대화는 무리하게 쪼개거나 복제하지 않는다. 사용자가 정한 보관 프로젝트에서 원본 ID와 소스를 유지하고 예외를 결과에 표시한다.

## 실행 순서

1. 최신 원본 자료의 provenance와 각 프로젝트 포함·제외 범위를 확정한다. 변하는 재무 수치·지원 현황은 날짜가 있는 소스에 두고 안정적인 작업 규칙을 지침에 둔다.
2. 승인된 새 프로젝트를 생성한다. 각 새 stable ID, 이름, 비공개·공유 범위, 메모리, 지침 hash, 실제 소스 bytes/크기/hash를 모두 확인하고 binding 영수증을 만든다.
3. 모든 목적 프로젝트의 준비가 끝난 뒤 대화를 이동한다. 선택한 메모리 설정을 Work 제약 때문에 자동으로 바꾸지 않는다. 원본 보관 프로젝트가 다른 메모리 설정이면 그 예외를 명시한다.
4. 이동 후 전체 ID 보존과 source/destination 소속을 대조하고 추가분을 재조정한다.
5. 승인된 기존 프로젝트만 1개씩 정리한다. 직전 대화 수 0, 소스 보존 disposition, ID/이름/권한과 fresh inventory를 요구한다. 하나라도 달라지면 해당 삭제를 멈춘다.

프로젝트 삭제는 대화·작업·파일을 함께 잃을 수 있다. 같은 이름의 프로젝트를 재생성해도 원래 ID·공유 링크·대화 배치는 복구된다고 가정하지 않는다. 승인과 backup 조건은 [execution-contract.md](execution-contract.md)를 따른다.

## UI와 재시도

private adapter의 기존 task-owned page에만 위임한다. Chrome·프로필을 생성하거나 offline slot을 자동 기동하지 않는다. CUA 초기화 장애는 Chrome 기동 권한이 아니다.

- 대화의 점 3개는 stable conversation ID 링크가 있는 정확한 행에서 찾는다. 표시 제목의 공백 정규화는 UI 비교에만 쓰고 원래 제목을 수정하지 않는다.
- 이동 메뉴가 이름만 표시하면 fresh 전체 inventory에서 목적 이름이 유일하며 승인된 remote ID와 일치하는지 확인한다. 메뉴가 완전히 표시되기 전에는 bounded read-only wait만 한다.
- dispatch 전에 원장을 저장하고 1회 클릭한다. 직후 양쪽 ID 집합의 정확한 한 건 변화와 account/workspace를 확인한다. dispatching/submission_uncertain은 read-only reconciliation 전까지 자동 재시도하지 않는다.
- 생성·지침 저장·소스 업로드도 dispatch 불명확 시 추가 실행하지 않는다. 소스 count나 이름만으로 업로드 성공을 선언하지 않는다.

2026-10-10 한국어 UI 관측(드리프트 가능): 새 프로젝트 추가 → 프로젝트 만들기 → 프로젝트 전용 메모리; 프로젝트 액션 → 프로젝트 설정 → 지침을 바꾼 뒤 저장; 소스 → 소스 추가 → 업로드. 대화 행은 채팅 tabpanel, ID 링크, 제목 액션 버튼, 프로젝트로 이동 menu를 사용했다. 날짜 overlay가 클릭을 가릴 때 실제 버튼 focus+Enter가 동작했다. 이 명칭을 미래 UI의 권위자로 삼지 않고 실행 전 authenticated profile을 다시 관측한다.

등록된 같은 Windows 호스트의 CDP 업로드에서 file chooser의 transport 크기 제한이 발생하면 서버 제한과 구분한다. 관측한 file input의 정확한 node와 승인된 local absolute 파일을 사용하는 CDP DOM.setFileInputFiles가 대안이다. 다른 호스트나 소유 불명 탭에는 적용하지 않으며 실제 remote 소스의 bytes/hash를 별도로 대조한다.

## 결과와 제한

프로젝트 membership, active root listing, archived root listing을 독립된 scope 영수증으로 남긴다. 뒤 단계가 실패해도 앞서 완료한 scope의 증거를 버리지 않는다. 429에서는 추가 호출을 중단하고 제한/재개 조건을 남긴다. 일부 목록 실패를 계정 전체 완료로 확대하지 않는다. 임시 소유 target만 반환하고 foreign page ID를 보존한다.

검증된 운영 관측과 새로 수정한 코드의 검증 상태는 분리한다. 구현만 끝났다면 검증 완료라고 쓰지 않는다.