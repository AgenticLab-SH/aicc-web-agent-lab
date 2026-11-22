# WinForms text transport and paint boundaries

Use for corrupted non-ASCII text or scroll trails in Windows utilities. Do not replace fonts or remove an accepted visual theme before tracing the failing boundary.

## AICC incident, 2026-10-18

The source registration titles contained no U+FFFD replacement characters. A hidden PowerShell 7.6.6 child, started with redirected output under this Korean Windows environment, reported output code page 949. The known text `한글` produced bytes `C7D1B1DB`; UTF-8 requires `ED959CEAB880`. The C# caller already requested UTF-8 decoding. JSON syntax survived because it is ASCII, while Korean title bytes were decoded incorrectly. Setting only ProcessStartInfo.StandardOutputEncoding was insufficient.

The same screenshot contained unrelated text trails under fixed navigation and footer. Shared TextRenderer helpers preserved translation but omitted PreserveGraphicsClipping. GDI text drawing must preserve the Graphics clip as well as translation, especially with double-buffered scrolling and child controls. This code defect is established from source and the documented flag contract; the visual fix was not independently exercised. Treat these as two distinct causes, not a font-family failure.

## Implementation choices

- For machine JSON from a PowerShell child, set that child's `[Console]::OutputEncoding` and `$OutputEncoding` to UTF-8 before invoking the existing script. Set both redirected readers to UTF-8 too. Use strict decoding so invalid bytes become a labelled read failure rather than accepted corrupted text. Scope changes to the child, not global console/code-page/profile settings.
- Preserve existing script identity/pins, exact arguments, timeouts and mutation boundaries. A transport wrapper can configure output before calling a pinned helper without editing that helper or repinning an active worker. Quote each PowerShell argument as a literal and reject command-line-breaking characters; never interpolate titles or terminal text as code.
- Distinguish transport corruption from already-damaged storage with bounded, read-only comparisons. Keep private titles out of diagnostic logs. Do not guess a reversible mojibake conversion or overwrite registration titles; recover only from an authoritative title matched by exact ID if storage itself is damaged.
- In shared TextRenderer helpers, use PreserveGraphicsClipping and PreserveGraphicsTranslateTransform together when both apply. EndEllipsis limits a string's rectangle; it does not preserve the Graphics update region. Apply clipping to owner-drawn navigation/buttons/list rows too.
- An Opaque custom surface skips the framework's normal background erase. Fill its invalidated area before raising Paint, preserve/intersect the existing clip, and restore Graphics state afterward. Invalidate the viewport/content on scroll and page changes. Keep a single scrolling content plane; avoid timer repaint loops or global WS_EX_COMPOSITED as a substitute for correct clipping.
- Truncate display text at grapheme boundaries so surrogate pairs and combining sequences survive. Keep Korean font fallback and shared Font lifetime separate from byte decoding.

## Evidence and completion language

Before edits, a bounded non-ASCII diagnostic can establish the producer's actual bytes and source-data condition. After edits, follow current model policy and the user's explicitly requested checks; this reference does not authorize extra tests. When visual verification is authorized, cover page switching, top/bottom scroll, refresh, scaling and hidden/show states. Report source repair, build/install receipt and actual visual acceptance separately. Never promise that recurrence is impossible.

Source: [Microsoft TextFormatFlags](https://learn.microsoft.com/en-us/dotnet/api/system.windows.forms.textformatflags), especially PreserveGraphicsClipping and PreserveGraphicsTranslateTransform. The producer-byte evidence and preserved preimages belong in the owner's private incident backup, not the public repository.
