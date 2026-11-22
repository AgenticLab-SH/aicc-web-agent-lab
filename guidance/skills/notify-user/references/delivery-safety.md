## Optional Slack responses

For pending or requested Slack responses, read [the response procedure](references/slack-responses.md). No live bridge means replies stay in the original task.

## Safety

- Never send a password, token, cookie, native-auth value, email/SMS code,
  secret-bearing URL, or raw private artifact.
- Bound identical delivery retries to two. Then report the channel unavailable.
- Use one stable event per unchanged intervention, not periodic status spam.
  Do not create a new event ID merely because the owner has not answered.
  Acknowledge or cancel a pending event once the owner responds or it no longer applies.
- A successful Slack API response proves bot delivery, not mobile push. Treat
  mobile notification as user-confirmed evidence only.
- Slack has no API field that forces an urgent mobile push. Keep the full action
  and KST expiry in top-level `text`, which Slack uses as the notification fallback.
- This skill does not create Slack channels, configure webhooks, manage bots, or
  own website login. Use `manage-telegram-bots` for bot administration.
