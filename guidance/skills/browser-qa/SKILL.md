---
name: browser-qa
description: 구현 후 실행 가능한 로컬·배포 페이지를 Browser/Chrome으로 검증한다. UI 구현·조사·경로 변경 제외.
---

# 브라우저 QA

실제 페이지의 동작과 화면을 관찰해 증거를 남긴다. 코드를 구현하거나 QA 전용 harness,
extension, plugin을 설치하지 않는다.

한영 텍스트가 관련되면 [한영 UI 품질](../korean-ui-quality/SKILL.md)의 화면 시나리오를 변경 범위에 적용한다. 200% 글자 확대·320 CSS px 재배치·폰트 대체·전체 값 접근은 구분한다. 아래 실행은 현재 모델 정책과 사용자의 명시 검증 범위가 허용할 때만 수행한다.

## 실행

1. 로그인이 필요 없으면 격리된 Browser를 쓴다. 기존 로그인·확장·사용자 Chrome 상태가
   필요할 때만 Chrome을 쓰고 사용자 탭은 보존한다.
   등록 CDP를 사용하라는 요청이 있거나 그 경로가 현재 작업에 결속돼 있으면 기존 등록 launcher·소유 target lease로 해당 CDP를 사용한다. CUA native pipe/확장 host 실패만으로 CDP까지 미지원이라고 결론내리지 않는다. Playwright 전체 브라우저 연결이 멈춰도 등록 broker의 상태와 exact target의 지원되는 CDP 연결을 구분해 진단한다. 사용자 탭의 일괄 attach·종료는 하지 않는다.
2. API·connector·CLI가 같은 사실을 더 직접 검증하면 그것을 우선한다.
3. URL과 초기 상태를 관찰하고 critical flow를 최소 동작으로 수행한다. 이동·submit·reload
   뒤에는 화면을 다시 읽고 이전 element ref나 고정 좌표에 의존하지 않는다.
   `data-ready`가 사용자 데이터 선택·업로드 뒤에만 생기는 앱은 먼저 정상 UI로 승인된
   입력을 선택한다. 선택 전 준비 상태만 기다려 timeout을 제품 장애로 판정하지 않는다.
   기존 합성 fixture는 정상 파일 업로드로 사용할 수 있으며 실데이터 성공과 구분한다.
4. 변경 범위에 관련되면 desktop·mobile layout, overflow, keyboard/focus, loading/error,
   console과 실패 network 요청을 확인한다.
5. 스크린샷은 차이·오류·최종 상태를 설명하는 경우에만 남긴다. console/network를 현재
   호스트가 제공하지 않으면 설치로 우회하지 않고 미확인으로 표시한다.

기대 결과, 실제 결과, 재현 경로와 미확인 항목을 짧게 보고한다. QA가 만든 탭·target만
정리한다. 웹 AI 조사와 route 문제는 `use-web-gpt`가 소유한다.

내보내기는 버튼의 성공 문구, 실제 생성된 PNG/ZIP bytes, OS 다운로드 완료를 구분한다.
지원되는 소유 target에서 생성 Blob을 회수했다면 signature·크기·해시와 ZIP 항목을
확인하고 OS 저장은 별도 미확인으로 남긴다. 소스에 있는 저장·재열기 제어가 운영
화면에 없으면 source/deployed revision 차이를 먼저 확인하고 숨은 제어를 만들어 쓰지 않는다.

## 실행 위치와 관찰 범위

Web 컨테이너의 localhost는 사용자 PC의 localhost가 아니다. PC 페이지는 승인된 해당 호스트의 브라우저 도구나 실제 접근 가능한 미리보기 주소로 관찰한다. URL fetch·검색 HTML만 얻었다면 렌더·상호작용 검증으로 보고하지 않는다. 지원 브라우저가 없으면 관찰 시나리오는 준비할 수 있고 실제 UI 확인만 미실행으로 남긴다.

보호된 서비스의 401이나 로그인 화면은 현재 서비스 세션이 없다는 뜻이며 브라우저 전체의 로그인 상실을 뜻하지 않는다. 서비스 사용·점검 요청에 포함된 기존 계정의 일반 로그인을 `complete-site-login`으로 확인한다. 사용자가 명시적으로 금지하지 않은 한, 하위 작업자가 자체로 붙인 '새 로그인 금지'를 사용자 제약으로 올리지 않는다. 계정 선택은 검증된 신원으로 하고 새 권한·보안 거절은 별도 경계를 지킨다.
