# Browser application identity contract

## Identity tuple

A browser variant is distinct only when these fields agree:

| Field | Purpose |
|---|---|
| Engine | Active Chrome, or an explicitly restored dormant engine |
| OS identity | macOS bundle ID or Windows AppUserModelID |
| Main executable | Process that owns the browser lifetime |
| User-data root | Isolates profile databases and locks |
| Profile directory | Selects the intended profile inside the root |
| CDP port | Identifies the automation endpoint |
| Visible app | Dock/taskbar target and display name |
| Icon | Human-readable visual badge |

An icon-only launcher is not a separate runtime identity. A listener-only check
is also insufficient because it can belong to the wrong browser or profile.
When multiple macOS CDP slots intentionally share an unchanged vendor-signed
engine, the runtime identity is the verified executable plus user-data root,
profile directory, and port; the Dock launcher is only the operator surface.
The live SSOT may prohibit an otherwise supported engine. In this environment,
CDP Chrome 9222/9223 must use official Google Chrome and Chrome for Testing is
not an allowed source, runtime, or fallback.

## Recommended visual vocabulary

Use the live SSOT for actual names and port numbers.

| Role | Base icon | Badge | Suggested color |
|---|---|---|---|
| Normal vendor Chrome | Vendor Chrome | none | vendor |
| Chrome for Testing | Testing Chrome | `T` | slate |
| CDP Chrome primary | Chrome/Testing | port suffix, e.g. `22` | blue |
| CDP Chrome secondary | Chrome/Testing | port suffix, e.g. `23` | orange |

Keep badge text to one or two characters. Use both text and color so identity
does not depend on color perception alone.

## macOS pattern

For a vendor-preserving authenticated profile slot:

```text
Variant.app/
  Contents/
    Info.plist              unique launcher bundle ID, name, icon
    MacOS/
      CDP Slot Launcher     native persistent status/focus controller
    Resources/
      app.icns              distinct icon
```

The launcher must open the unchanged vendor app with the verified user-data
root, profile directory, and CDP port. It may remain resident to show a Dock
running indicator and compact status badge. A second click must focus only an
exact process/profile/port match and must not create an extra window. The
resident launcher exits when its slot stops. The vendor app keeps its original
signature, Keychain access, updater, and version metadata.

On this Mac the signed vendor Google Chrome bundle is both the ordinary Dock tile and HTTP/HTTPS
handler (`com.google.Chrome`). Do not create or register a second ordinary-Chrome wrapper identity.
Dormant browser launchers must remain unregistered.

After building the lightweight launcher, prefer a stable local or distribution
code-signing identity. AICC's macOS installers use
`AICC_MACOS_CODESIGN_IDENTITY` when explicitly configured, otherwise reuse the
local `AgenticLab Local Code Signing` identity when it exists, and fall back to
ad-hoc signing only on machines without either identity. Never export or commit
the private key. A configured-but-missing identity is an error rather than a
silent downgrade.

```bash
codesign --force --sign "${AICC_MACOS_CODESIGN_IDENTITY:-AgenticLab Local Code Signing}" /path/to/Variant.app
lsregister -f /path/to/Variant.app
```

Do not execute a tool embedded inside another `.app` bundle as a general build
runtime. macOS can attribute that cross-bundle read to the calling app and show
an App Data access prompt. Use a standalone system or AICC-owned runtime path.

Back up Dock preferences before replacing a tile. Verify the final tile's path

macOS may group the live browser window under the vendor Dock icon because the
vendor app is the actual runtime. Do not clone and ad-hoc re-sign Chrome solely
to alter that grouping when the profile depends on macOS Keychain encryption.

A toolbar identity extension may supplement the Dock indicator when it uses
only profile-local storage and the action badge API. It must not request host,
tab, history, cookie, or content-script access. The allowed display mapping is
the registered slot identity, not an inferred account or page identity.

## Windows pattern

Use one wrapper and shortcut per role:

```text
CDP Chrome 9222.exe  -> unique AppUserModelID + port/profile arguments
CDP Chrome 9223.exe  -> different AppUserModelID + port/profile arguments
CDP Whale.exe        -> dormant recovery-only source, never installed by default
```

Each `.lnk` owns its display name, `.ico`, target, working directory, and
arguments. A pinned shortcut may cache its previous icon or grouping; recreate
only the exact stale pin after backing it up.

## Failure conditions

Stop rather than repair by inference when:

- The intended port is owned by another browser/profile.
- A normal browser is using the automation user-data root.
- Two simultaneous variants share the same port.
- The target profile path is unknown.
- Changing or copying a profile would be required without explicit approval.
- The Dock/taskbar target cannot be resolved to the intended application.
