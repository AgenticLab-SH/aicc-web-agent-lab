# 웹 생성 파일 → AICC → Notion

사용자가 파일 생성과 Notion 저장을 요청한 경우에만 사용한다. 생성 품질은 해당 이미지·문서·슬라이드 스킬이 맡고, 이 절차는 실제 파일 전달과 첨부를 맡는다. 추가 유료 API나 신규 인증 발급을 전제로 삼지 않는다. 모든 형식·무제한 무료·Notion 내 모든 파일의 편집/재생을 보장하지 않는다.

## Notion 목적지 원칙 — 공통 정본

파일 업로드·백업·자산 관리·정리 모두 이 원칙을 따른다. **기존 목적지 또는 부모의 정확한 ID와 실제 connector fetch 결과를 확인하기 전에는 Notion 쓰기를 HOLD한다.** 목적지가 없다는 이유로 creation_mode:draft, root, parent 생략을 사용해 개인 최상위 페이지를 자동 생성하지 않는다. 비공개 초안도 최상위 생성의 대체 승인이 아니다. 사용자가 해당 작업에서 최상위 생성을 명시적으로 요청한 경우에만 그 범위의 예외를 기록한다. 기존 페이지 수정 권한을 새 최상위 생성 권한으로 확대하지 않는다.

기존 페이지에 첨부·추가할 때는 그 page ID를 fetch한다. 새 하위 페이지는 실제 확인한 부모 page ID를 명시한다. 데이터베이스 항목은 fetch에 표시된 실제 data-source ID와 schema를 사용한다. database·data-source·page ID를 서로 치환하지 않는다. 상위 항목·목적지가 불명확하면 로컬 완성본과 이미 성공한 백업을 보존하고 목적지 확인 단계만 기다린다. 같은 이름의 새 페이지·새 draft를 만들지 않는다.

AICC 소유 Send-NotionLocalFile.ps1은 -DestinationReadPath에 실제 fetch 응답 JSON을 요구하며 정확한 page ID·page entity·실제 응답 파일의 저장 시각을 검사한다. -ValidateDestinationOnly는 네트워크 없이 같은 검사를 한다. WebAssetBackup.ps1의 BeginNotion도 같은 검사기를 호출하고 목적지 ID를 영수증에 결속한다. 이것은 입력 일관성 검사이며 인증이나 connector 권한을 대신하지 않는다. AICC 밖에서 직접 호출하는 모든 Notion connector를 가로채는 기능은 아니다. 최상위 생성 예외가 있어도 이 업로드 경로에는 이미 만들어진 실제 목적지 page 확인이 필요하다.

## 업로드 정보는 내부에서 자동 처리

티켓은 공식 Notion notion_create_file_upload가 파일 하나를 위해 발급하는 짧은 유효기간의 업로드 주소·헤더다. 사용자의 재승인이나 별도 수동 발급 절차가 아니다. 기존 Notion 연결로 자동 발급하고 AICC 전송에 바로 사용하며, 사용자에게 티켓 생성·복사·보관을 시키지 않는다. 기존 업로드·첨부를 재사용할 때는 새 티켓을 발급하지 않는다. 영구 Notion 토큰을 로컬에 복제하지 않는다.

## 디스크에 티켓을 남기지 않는 기본 경로

새 전송은 -TicketFromStdin을 우선한다. Windows PowerShell과 현재 AICC AppContainer의 실제 stdin 전달을 확인한 경로다. exec에 -TicketFromStdin을 지정하고 AWAITING_NOTION_UPLOAD_TICKET와 실행 중 session을 회수한 뒤, 같은 session의 aicc_workspace_write_stdin chars로 반환 티켓 JSON 전체를 한 줄과 줄바꿈으로 1회 전달한다. 실행기가 stdin을 읽어 공식 URL 검증과 단회 POST를 수행한다. 헤더는 command 인수·파일·일반 출력에 남기지 않는다. 진행 중 입력 session을 별도 명령으로 다시 시작하지 않는다. 티켓을 받기 전 연결이 끊기면 같은 session부터 조회한다.

TicketPath는 기존 작업 조정을 위한 호환 경로다. 파일 저장 방식에서 부모 폴더가 없거나 통합 diff가 잘못됐을 때는 HTTP 전송 전 준비 오류와 전송 결과 불명을 구분한다. 원 티켓이 유효하면 재사용한다. 기존 attempt와 첨부가 없고 POST가 시작되지 않았다는 증거가 있으며 원 티켓이 만료/미보존인 경우만 ABANDONED_BEFORE_POST를 기록한 뒤 새 단회 티켓으로 최초 POST를 진행할 수 있다. 전송됐거나 결과가 불명인 요청에는 이 예외를 적용하지 않는다.

기존 티켓 삭제가 AppContainer 권한으로 거절되면 다른 도구로 같은 삭제를 시도하지 않는다. 단회 사용/만료 상태와 exact 파일명만 기록하고 원 파일을 보존한다. 앞으로의 독립된 전송은 stdin 방식으로 새 티켓 파일을 만들지 않는다.

## 1. 생성과 실제 파일 회수

- 일반 Chat·xhigh를 유지한다. Web sandbox의 /mnt/data는 사용자 Windows 경로가 아니다. 생성한 파일명·형식·크기와 실제 다운로드/파일 존재를 확인한다.
- Web가 반환한 실제 HTTPS 다운로드 URL이 있으면 그 정확한 URL의 파일만 기존 AICC 연결의 허용 네트워크와 등록 작업공간으로 받는다. 인증된 ChatGPT 링크를 임의 API로 변환하거나 쿠키/브라우저 프로필을 복제하지 않는다.
- sandbox: 링크나 카드형 다운로드만 있으면 지원되는 현재 브라우저 다운로드 기능을 사용한다. 그 기능이 Web에 없으면 승인된 기존 Codex 전달 경로의 실제 발신/완료 응답으로 로컬 회수를 맡긴다. 링크나 큐 등록만으로 파일 회수 완료로 보고하지 않는다. 없는 브라우저 capability를 만들어내거나 RDC를 자동 대체하지 않는다.
- 기존 로컬 ChatGPT reader가 실제 링크를 회수할 수 있으면 재사용한다. HTML 카드 버튼은 a[href] reader에 나오지 않을 수 있다. 정확한 소유 탭의 다운로드 이벤트가 완료된 후, 임시 파일이 사라지기 전에 PowerShell Copy-Item -LiteralPath로 등록 작업공간 안에 저장한다. 전체 ZIP이 실제 생성됐다면 한 번 회수해 좁은 신규 디렉터리에 확장하면 된다.
- 바이너리 전체를 모델 출력/base64 왕복으로 전달하지 않는다. 웹 생성, 로컬 회수, 업로드 실행자가 서로 다르면 각각 기록한다.

## 2. 기존 AICC에서 로컬 파일 전송

0. 쓰기 lease·티켓 발급 전에 exact 목적지 page를 공식 connector로 fetch하고 실제 응답 JSON을 등록 작업공간에 보존한다. 응답 파일 저장 후 15분이 지났으면 새 fetch 결과를 저장한다. 오래된 페이지의 `as of`/`page_last_edited_at`는 조회 시각이 아니므로 오래됐다는 이유로 거절하지 않는다. 과거 응답을 복사하거나 저장 시각만 바꾸어 갱신하지 않는다. 파일 저장 시각은 입력 일관성 근거이며 인증 경계가 아니다. 목적지가 없으면 업로드도 시작하지 않는다.
1. 실제 aicc_workspace_list에서 사용할 좁은 alias를 찾고 write lease를 연다. 파일·실행기·티켓·영수증은 그 작업공간 안의 링크가 아닌 절대 경로를 사용한다. AppContainer와 기존 권한을 유지한다.
2. 이 스킬의 scripts/Send-NotionLocalFile.ps1을 해당 작업공간에 배치하거나 이미 배치된 동일 hash 실행기를 쓴다. 스킬 패키지의 가상 경로를 Windows 실행 경로로 추정하지 않는다. 첫 배치에는 aicc_skill_read로 실제 스크립트 본문을 읽고 apply_patch로 같은 내용을 쓰는 방식을 사용할 수 있다.
3. Windows PowerShell 5.1에서 아래 명령을 -InspectOnly로 먼저 실행한다. ReceiptDirectory는 같은 작업공간에서 계속 재사용할 전송 원장 디렉터리다. 날짜별 원장을 새로 만들어 중복 감지를 피하지 않는다.

```powershell
& 'ABSOLUTE_WORKSPACE_SCRIPT' -FilePath 'ABSOLUTE_LOCAL_FILE' -PageId 'EXACT_NOTION_PAGE_UUID' -ReceiptDirectory 'ABSOLUTE_STABLE_RECEIPT_DIRECTORY' -DestinationReadPath 'ACTUAL_CONNECTOR_FETCH_RESPONSE_JSON' -InspectOnly
```

4. READY_FOR_TICKET일 때만 공식 Notion notion_create_file_upload(filename 정확한 파일명)을 호출한다. 반환한 file_upload_id/upload_url/upload_method/upload_headers/upload_form_field/expires_at은 메모리에서 다음 단계에 전달한다. 새 ticket JSON 파일을 만들지 않는다. 도구가 없으면 부족한 기능을 보고한다.
5. 같은 실행기에 -TicketFromStdin을 추가하고 -InspectOnly를 빼서 aicc_workspace_exec로 실행한다. AWAITING_NOTION_UPLOAD_TICKET와 반환 session을 받은 뒤 같은 session의 aicc_workspace_write_stdin으로 티켓 JSON 한 줄과 줄바꿈을 1회 전달한다. 이후 같은 session에서 완료를 회수한다. 정확한 HTTPS api.notion.com/v1/mcp/file_uploads/ID/send에 리디렉션 없이 field=file multipart POST를 1회 한다. Windows 기본 .NET HttpClient를 사용하므로 Node/AppData 쓰기 권한이 필요하지 않다.
6. UPLOADED 결과의 실제 file_upload_id, bytes, SHA256, suggested_markdown을 사용한다. 같은 page+SHA256 영수증이 UPLOADED/ATTACHED_VERIFIED이면 기존 upload를 재사용한다. DISPATCHING, OUTCOME_UNKNOWN_RECONCILE, 응답 유실은 기존 ID 결과부터 조정한다. 새 티켓/새 이름으로 POST 재시도하지 않는다. REJECTED는 원 오류를 좁힌 뒤 원업로드 상태를 먼저 조정한다.
7. 새 전송은 티켓 파일을 만들지 않으므로 삭제 단계가 없다. 기존 TicketPath 파일은 기존 허용 범위에서 정확한 해당 파일만 정리하고, 삭제 거절은 우회하지 않는다. upload_headers, 서명 URL, lease를 원격 문서·Git·일반 로그에 남기지 않는다.

공식 단회 업로드는 파일당 최대 20 MiB이며 workspace 제한이 추가된다. 지원되지 않는 확장자·MIME은 원 오류를 보고하며 다른 형식으로 속이지 않는다. 더 큰 파일은 사용자와 합의한 압축/분할 또는 실제 노출된 공식 대용량 기능이 필요하다.

## 3. 페이지에 첨부하고 중복 방지

- 먼저 위 공통 목적지 원칙과 Notion Markdown spec을 적용하고 exact 기존 목적지 page를 fetch한다. 목적지가 미지정이면 쓰기를 HOLD한다. 새 하위 페이지는 확인된 부모와 schema를 명시한 별도 승인 작업에서만 만든다.
- 실제 파일 hash와 목적지 pageID로 기존 첨부 기록과 페이지 본문을 대조한다. 이미 같은 내용이 붙었으면 다시 붙이지 않는다. 저장 직전 intent와 file_upload_id를 로컬 영수증 옆에 남기고 불명 응답은 fetch로 조정한다.
- 업로드가 반환한 suggested_markdown을 그대로 create_pages/update_page의 기존 내용을 보존하는 추가 구역에 넣는다. HTML은 embed로 렌더링한다. PNG/GIF는 image, MP4는 video, PDF는 pdf, DOCX/PPTX/ZIP은 file로 첨부된다. 일반 파일 첨부와 Notion 내부 편집/재생 지원은 구분한다.
- 파일명·크기·SHA256을 구역에 기록하고 fetch로 실제 첨부와 대조한다. 페이지 반영 전에는 업로드만 성공한 상태다. binary 다운로드 기능이 있으면 되받은 bytes도 비교하고, 없으면 바이트 왕복 검증은 미실행이라고 기록한다.
- 실제 확인한 pageID·파일명·file_upload_id·hash와 시각만 비밀 없는 receipt에 기록한다. 확인 후 ATTACHED_VERIFIED 상태를 사용할 수 있다. 첨부와 receipt 업데이트 사이의 결과 유실은 새 첨부 전에 page를 조회한다.
- 끝에 이 작업 lease를 닫는다. 생성 파일·복구 원본은 임의 삭제하지 않는다.

공식 문서: https://developers.notion.com/guides/data-apis/uploading-small-files
