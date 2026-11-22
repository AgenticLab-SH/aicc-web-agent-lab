---
name: complete-site-login
description: 승인된 기존 계정 로그인 1건을 인증·메일·SMS·제한된 CAPTCHA 지원으로 완료한다.
---

# Complete site login

Finish one explicitly authorized login without changing credentials, saved
passwords, recovery methods, permissions, or unrelated browser state. This
skill owns the login challenge only. `choose-browser-session` owns browser and
account selection; the selected Browser or Chrome control skill owns normal DOM
interaction; Computer Use owns native OS/password-manager UI.

## Intake and preflight

1. Confirm the exact site, intended account identifier, selected browser
   session, and the user's authorization to log in there. A request to use the
   site implies ordinary login authorization, but not password changes,
   recovery changes, new OAuth grants, or unexpected permissions.
2. If no verified browser session exists, run `choose-browser-session` first
   and retain its browser, account, profile, and task-tab boundary.
3. Read [references/verification-flow.md](references/verification-flow.md)
   before any email or SMS challenge. If the page unexpectedly asks to alter
   authentication, recovery, or persistent access, state the target and
   recovery path before mutation.
4. Treat credentials, native-auth values, email codes, SMS codes, magic links,
   and recovery data as ephemeral secrets. Never place them in source, config,
   prompts, screenshots, reports, test fixtures, shell history, or Git. Use a
   value only when supplied for this task or returned by an authorized
   credential/mail/Telegram path.
5. Keep independent task work moving while a login redirect, email, or SMS
   challenge is pending. A login blocker does not authorize switching accounts,
   bypassing access control, or replacing production evidence with a claim.

## Login workflow

1. Inspect the fresh page state before typing. If the login control is disabled
   during provider initialization, wait for the same control to become enabled
   and read its adjacent status before treating it as a blocker. Do not click a
   different account or login surface merely because initialization is slow.
2. Verify the visible site origin and intended account. On an OAuth account
   chooser, select a previously signed-in account only when its visible identity
   matches the task or verified project context. If multiple accounts remain
   plausible, ask rather than guessing. An ordinary existing-account selection
   needs no extra confirmation once login is authorized.
3. Saved autofill may already have populated the identifier, password, or both.
   Do not clear or retype a populated field. For an empty ordinary field, focus
   it once and allow the browser's saved-login UI to appear before manual input.
   Fill only what remains missing and submit only to the verified origin.
4. If focus or submit opens a native password-manager or OS authentication
   sheet, stop DOM automation and use the `computer-use` skill. Select password
   authentication only when it is the expected route and enter the
   task-provided native-auth value directly into that verified native UI.
   Reinspect the browser afterward and let saved autofill populate the website.
   Never type a native-auth value into a webpage or move it through files,
   clipboard helpers, logs, shell commands, screenshots, or task notes.
5. After OAuth returns, wait for the provider result and verify the final
   authenticated destination or account UI. A redirect back to the login page,
   `redirect_result_missing`, a provider-network warning, or a vanished button
   is not proof of success. For a transient redirect failure only, retry the same authorized flow at most once after a
   fresh page inspection; then report the redacted failure and continue any
   independent implementation or local QA work.
6. Continue according to the observed challenge: email, SMS, CAPTCHA,
   recovery, or an unexpected permission. Never guess a challenge type from a
   previous run.

## Provider security refusal

An explicit provider security refusal stops authentication retries. Preserve the session; do not change account, browser, profile, flags or cookies to evade it.

이 단계는 [상세 절차](references/verification-flow.md)의 같은 절을 읽고 수행한다.

## CAPTCHA

Keep action-time confirmation. Make at most one clear automatic entry after confirmation; then use the correlated owner-response procedure. Never retain challenge secrets or run a guessing loop.

이 단계는 [상세 절차](references/verification-flow.md)의 같은 절을 읽고 수행한다.

## Stop and verify

- Account recovery, password change, recovery-method change, new persistent
  grant, legal acceptance, payment, or unexpected permission is outside this
  workflow. Stop and apply the relevant authorization boundary.
- Preserve the browser's existing save-password setting. Do not accept a new
  save-password prompt unless the user explicitly authorized that exact save.
- Verify success from authoritative signed-in UI such as the expected account
  menu or authenticated destination, not merely an account chooser, redirect,
  vanished form, or provider callback.
- Report the site, selected browser/account, verification channel used, and
  success or blocker. Never include a credential or one-time code.

## Autofill presence and pending challenges

이 단계는 [상세 절차](references/verification-flow.md)의 같은 절을 읽고 수행한다.

