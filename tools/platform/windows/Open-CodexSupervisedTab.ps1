# Compatibility entry only. Opening a terminal is not authorization to resend a prompt.
[CmdletBinding()]
param([Parameter(Mandatory)][string]$WorkingDirectory,[Parameter(Mandatory)][string]$PromptFile,[string]$SessionId,[string]$Title='Codex',[switch]$InWindow)
throw 'direct_launch_retired: 기존 mux에서 exact 대화를 선택하세요. 지시는 등록된 일회용 callback으로만 전달합니다. 원요청 재전송 없음.'