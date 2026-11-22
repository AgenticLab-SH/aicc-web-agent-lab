---
name: evidence-first-web-research
description: 외부 최신 사실·정책·가격·제품을 공개 웹 1차 출처로 조사한다. 저장소·코딩·QA·배포 제외.
---

# Evidence First Web Research

Use this skill when the requested answer depends on public web sources outside the user's workspace. A request to verify local code, a deployed site, an account, or a release is an implementation or operational check; it does not by itself call for general web research. During development, use this skill only if a concrete external fact is needed, such as a changed provider API or current policy. Return to the original task after resolving that fact.

1. Restate the decision or factual question in one sentence.
2. Prefer official documents, first-party product pages, standards, filings, and original research. Use independent reporting to cross-check important claims.
3. Check publication dates and the date the event actually happened.
4. Compare at least two sources when sources may disagree. Explain the disagreement instead of averaging it away.
5. Separate verified facts, reasonable inference, and unknowns.
6. Link each material claim to the page that supports it. Do not cite search-result pages.
7. Give the answer first, then the small amount of evidence needed to judge it.

For recommendations, include the user's constraints, the main tradeoff, and what would change the recommendation. Do not copy long passages from sources or present outdated information as current.
## 검색 실패 뒤 이어가기

승인된 조사에서 검색 도구가 확정 실패하면 실제 반환 코드·설정·지원 경로로 원인을 좁힌다. 복구 가능한 결함은 승인 범위에서 고치고 원래 조사 요청을 재시도한다. 미지원 어댑터의 공통 문구를 실제 보안 거절로 단정하지 않는다. 기존에 승인·노출된 다른 검색 도구로 조사를 이어갈 수 있으면 그 성공과 원래 도구의 복구를 별도 기록한다. 실제 보안 거절은 우회하지 않고, 결과 불명 요청은 조정 전 재전송하지 않는다. 현재 모델의 사후 검증 제한을 일반적으로 해제하지 않는다.
