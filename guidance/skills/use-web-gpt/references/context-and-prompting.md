# Web GPT 컨텍스트 패킷

여러 파일이나 큰 handoff가 필요한 작업에서만 사용한다. 다음을 짧게 구분한다.

- **Goal**: 결과 하나와 사용처
- **Evidence**: 직접 확인한 사실·공식 출처·기준일
- **Inputs**: 각 첨부의 역할과 핵심 구간
- **Boundaries**: 보존할 상태, 금지 작업, 범위
- **Output**: 필요한 형식과 완료 조건
- **Unknowns**: 추측하면 안 되는 항목

관련 파일만 첨부한다. 선택한 surface가 제공하는 일반 file input을 우선 사용해 prompt와 첨부를
같은 composer에 준비하고 한 번에 제출한다. 이미지 전용 input에 PDF·문서·ZIP을 넣지 않는다.
사용자가 묶음을 요청했거나 surface의 실제 파일 수 제한을 넘을 때만 아래 도구가 만든 ZIP과
manifest를 사용한다.

```powershell
python .\scripts\prepare_context_bundle.py --output-dir <task-owned-temp-dir> -- <absolute-file>...
```

Codex Web GPT 앱은 Responses `input_file`의 실제 bytes가 있는 경우에만 일반 파일로 전달하며,
`file_id`나 이름만 있는 참조를 첨부 성공으로 보고하지 않는다. 현재 선택한 브라우저의 지원 첨부 기능으로 파일 bytes와 실제 composer 항목을 결속한다. 옛 일반 Chrome 확장의 exact tab-bound
watch bytes 자동 주입 경로는 폐기됐으므로 현재 전송 기능으로 사용하지 않는다.
여기서 native file chooser나 창 focus를 요구하면 구식 경로이므로 중단한다. 인앱 Browser·CDP는 현재
composer의 일반 file input과 exact visible attachment tile을 확인한다.

동일 계정의 ChatGPT Library에 정확히 같은 파일이 있으면 재업로드보다 `라이브러리에서 가져오기`를
우선할 수 있다. 재사용 조건은 현재 account identity, 로컬 SHA-256, byte 수와 이름, live Library의
`libfile`/`file` ID와 `ready` 상태가 모두 일치하는 경우뿐이다. 파일명만 같거나 계정이 불명확하면
재사용하지 않는다. 기존 cache가 없을 때는 exact filename query의 후보만 확인하고, 기본적으로
32 MB 이하·최대 3개 후보만 직렬 download/hash 검증한다. 전체 Library scan, 광범위한 polling,
동시 hash download는 하지 않는다. 검증·UI mapping·Library API 중 하나라도 불확실하면 묻거나
재시도하지 말고 즉시 일반 file upload로 되돌아간다. Temporary Chat의 업로드는 Library를 채우지
않으므로 재사용을 위해 대화 privacy mode를 바꾸지 않는다.

민감 파일·symlink·중복·크기 제한 거부를 우회하지 않는다. 첨부 전후 파일명과 개수를
확인하고, 원본 경로·비밀·인증·브라우저 프로필·세션 DB·런타임 캐시는 보내지 않는다.
발췌만 보낼 때는 출처와 생략 범위를 적는다.

큰 작업은 필요한 경우 `explore → critique → synthesize → verify`로 나누되, 앞 단계의
채택 결과만 다음 단계에 전달한다. 전체 응답이나 공통 문서를 반복 복사하지 않는다.
회수할 것은 결정, 근거, 거절한 대안, 미확인, 로컬에서 검증할 항목뿐이다.
