# AICC Chrome Identity Badge

Minimal Manifest V3 identity extension for the normal `상훈` Chrome profile and
configured AICC CDP slots. It uses
only `chrome.storage.local`; it has no host, tab, history, cookie, content-script,
or remote-code permission.

Install it once through **Load unpacked** on the verified profile's
`chrome://extensions` page. AICC may prepare that exact page and then configure
the selected slot over verified CDP, but it never treats session-scoped
`Extensions.loadUnpacked` as a persistent install. The slot value is local to
the browser profile.
