#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";
import { evaluateExtensionPostcondition } from "./extension-postcondition.mjs";

function parseArgs(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--") || value === undefined) {
      throw new Error(`Invalid argument near ${key ?? "<end>"}`);
    }
    parsed[key.slice(2)] = value;
  }
  return parsed;
}

function normalize(value) {
  return path.resolve(value).replaceAll("/", "\\").replace(/\\+$/, "").toLowerCase();
}

function isWithin(child, parent) {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function sortedStrings(values) {
  return [...(values ?? [])].map(String).sort();
}

function assertSameStrings(actual, expected, label, key) {
  const left = sortedStrings(actual);
  const right = sortedStrings(expected);
  if (JSON.stringify(left) !== JSON.stringify(right)) {
    throw new Error(`${label} drift for ${key}: actual=${left.join(",")} expected=${right.join(",")}`);
  }
}

class CdpConnection {
  constructor(url) {
    this.url = url;
    this.nextId = 1;
    this.pending = new Map();
  }

  async connect() {
    this.socket = new WebSocket(this.url);
    this.socket.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data));
      if (!message.id) return;
      const request = this.pending.get(message.id);
      if (!request) return;
      this.pending.delete(message.id);
      clearTimeout(request.timer);
      if (message.error) request.reject(new Error(`${request.method}: ${message.error.message}`));
      else request.resolve(message.result ?? {});
    });
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("CDP browser connection timed out")), 15000);
      this.socket.addEventListener("open", () => { clearTimeout(timer); resolve(); }, { once: true });
      this.socket.addEventListener("error", () => { clearTimeout(timer); reject(new Error("CDP browser connection failed")); }, { once: true });
    });
  }

  send(method, params = {}, sessionId) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method}: timed out`));
      }, 30000);
      this.pending.set(id, { resolve, reject, timer, method });
      const message = { id, method, params };
      if (sessionId) message.sessionId = sessionId;
      this.socket.send(JSON.stringify(message));
    });
  }

  close() {
    this.socket?.close();
  }
}

async function loadRegistry(registryPath, slot, selectedKey) {
  const registry = JSON.parse(await fs.readFile(registryPath, "utf8"));
  if (registry.schema_version !== 1 || !Array.isArray(registry.trusted_roots) || !Array.isArray(registry.extensions)) {
    throw new Error("Unsupported extension registry schema");
  }
  const chosen = registry.extensions.filter((item) =>
    (selectedKey === "all" || item.key === selectedKey) && item.slots.map(String).includes(slot));
  if (chosen.length === 0) throw new Error(`No registered extension matches slot ${slot} and key ${selectedKey}`);

  for (const item of chosen) {
    if (!registry.trusted_roots.some((root) => isWithin(item.path, root))) {
      throw new Error(`Extension path is outside trusted roots: ${item.path}`);
    }
    const manifest = JSON.parse(await fs.readFile(path.join(item.path, "manifest.json"), "utf8"));
    if (manifest.name !== item.manifest_name || manifest.manifest_version !== item.manifest_version) {
      throw new Error(`Manifest identity mismatch for ${item.key}`);
    }
    assertSameStrings(manifest.permissions, item.allowed_permissions, "Permission", item.key);
    if (item.forbid_host_permissions &&
        (manifest.host_permissions || manifest.optional_host_permissions || manifest.content_scripts)) {
      throw new Error(`Host access is forbidden for ${item.key}`);
    }
    if (!item.forbid_host_permissions) {
      assertSameStrings(manifest.host_permissions, item.allowed_host_permissions, "Host permission", item.key);
      assertSameStrings(manifest.optional_host_permissions, item.allowed_optional_host_permissions, "Optional host permission", item.key);
      const contentMatches = (manifest.content_scripts ?? []).flatMap((script) => script.matches ?? []);
      assertSameStrings(contentMatches, item.allowed_content_script_matches, "Content-script match", item.key);
    }
    item.manifest = manifest;
  }
  return chosen;
}

async function createDirectTarget(endpoint, url) {
  // Navigating an owned blank page avoids Chrome 154's unresponsive JS context
  // when /json/new directly creates chrome:// or chrome-extension:// targets.
  const createUrl = new URL(`/json/new?${encodeURIComponent("about:blank#aicc-extension-management")}`, endpoint);
  const response = await fetch(createUrl, { method: "PUT" });
  if (!response.ok) throw new Error(`Creating task-owned target returned HTTP ${response.status}`);
  const target = await response.json();
  if (!target.id || !target.webSocketDebuggerUrl) throw new Error("Chrome did not expose a task-owned target");
  const connection = new CdpConnection(target.webSocketDebuggerUrl);
  try {
    await connection.connect();
    await connection.send("Runtime.enable");
    await connection.send("Page.enable");
    if (!url.startsWith("about:blank")) {
      const navigation = await connection.send("Page.navigate", { url });
      if (navigation.errorText) throw new Error(`Chrome target navigation failed: ${navigation.errorText}`);
    }
    return { targetId: target.id, connection };
  } catch (error) {
    connection.close();
    await fetch(new URL(`/json/close/${encodeURIComponent(target.id)}`, endpoint)).catch(() => {});
    throw error;
  }
}

async function openExtensionsSession(endpoint, foreground = false) {
  // Chrome 154 may not expose an execution context when /json/new directly
  // creates a privileged chrome://extensions target. Navigate an owned blank
  // page instead, then wait for its real extensions UI execution context.
  const direct = await createDirectTarget(endpoint, "about:blank#aicc-extension-manager");
  try {
    await direct.connection.send("Page.enable");
    const navigation = await direct.connection.send("Page.navigate", { url: "chrome://extensions/" });
    if (navigation.errorText) throw new Error(`Chrome extensions navigation failed: ${navigation.errorText}`);
    let ready = false;
    for (let attempt = 0; attempt < 40; attempt += 1) {
      try {
        const result = await direct.connection.send("Runtime.evaluate", {
          expression: "document.readyState === 'complete' && typeof chrome !== 'undefined' && !!chrome.developerPrivate?.getExtensionsInfo",
          awaitPromise: false,
          returnByValue: true
        });
        ready = !result.exceptionDetails && result.result?.value === true;
      } catch (error) {
        if (!/execution context|navigation/i.test(error.message)) throw error;
      }
      if (ready) break;
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    if (!ready) throw new Error("Chrome extensions API did not become ready");
    return { ...direct, foreground };
  } catch (error) {
    direct.connection.close();
    await fetch(new URL(`/json/close/${encodeURIComponent(direct.targetId)}`, endpoint)).catch(() => {});
    throw error;
  }
}

async function evaluate(connection, sessionId, expression) {
  const response = await connection.send("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true
  }, sessionId);
  if (response.exceptionDetails || response.result?.subtype === "error") {
    const detail = response.exceptionDetails?.exception?.description
      ?? response.exceptionDetails?.text
      ?? response.result?.description
      ?? "unknown Chrome extensions error";
    throw new Error(detail);
  }
  return response.result?.value;
}

async function extensionInfo(connection, sessionId) {
  return evaluate(connection, sessionId, `(async () => {
    const items = await chrome.developerPrivate.getExtensionsInfo({
      includeDisabled: true,
      includeTerminated: true
    });
    return items.map((item) => ({
      id: item.id,
      name: item.name,
      path: item.path ?? "",
      state: item.state,
      pinned: item.pinnedToToolbar === true,
      version: item.version,
      incognito_access: item.incognitoAccess?.isActive === true,
      file_access: item.fileAccess?.isActive === true,
      error_collection: item.errorCollection?.isActive === true,
      host_access: item.permissions?.runtimeHostPermissions?.hostAccess ?? null,
      runtime_hosts: (item.permissions?.runtimeHostPermissions?.hosts ?? [])
        .filter((host) => host.granted === true)
        .map((host) => host.host)
        .sort(),
      show_access_requests_in_toolbar: item.showAccessRequestsInToolbar === true
    }));
  })()`);
}

function findMatch(items, entry) {
  const pathMatches = items.filter((item) => item.path && normalize(item.path) === normalize(entry.path));
  const matches = pathMatches.length > 0 ? pathMatches : items.filter((item) => item.name === entry.manifest_name);
  if (matches.length > 1) throw new Error(`Multiple installed extensions match ${entry.key}`);
  return matches[0];
}

function expandStorage(storage, slot) {
  return Object.fromEntries(Object.entries(storage ?? {}).map(([key, value]) => [
    key,
    typeof value === "string" ? value.replaceAll("${slot}", slot) : value
  ]));
}

async function configureStorage(browserConnection, endpoint, extensionId, values, entry) {
  if (Object.keys(values).length === 0) return {};
  const page = entry.manifest?.action?.default_popup ?? entry.manifest?.side_panel?.default_path;
  if (!page) throw new Error(`No registered extension page for local storage verification: ${entry.key}`);
  // The browser-level Extensions storage endpoint lacks a profile context on
  // a CDP port. Open only this extension's actual popup or side-panel page.
  const target = await createDirectTarget(endpoint, `chrome-extension://${extensionId}/${page}`);
  try {
    let ready = false;
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const result = await target.connection.send("Runtime.evaluate", {
        expression: "document.readyState === 'complete' && typeof chrome !== 'undefined' && !!chrome.storage?.local && !!chrome.action",
        awaitPromise: false, returnByValue: true
      });
      if (!result.exceptionDetails && result.result?.value === true) { ready = true; break; }
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    if (!ready) throw new Error("Chrome extension popup APIs did not become ready");
    return await evaluate(target.connection, undefined, `(async () => {
      const values = ${JSON.stringify(values)};
      await chrome.storage.local.set(values);
      await new Promise((resolve) => setTimeout(resolve, 250));
      return {
        stored: await chrome.storage.local.get(Object.keys(values)),
        badge: await chrome.action.getBadgeText({}),
        title: await chrome.action.getTitle({})
      };
    })()`);
  } finally {
    target.connection.close();
    await browserConnection.send("Target.closeTarget", { targetId: target.targetId }).catch(() => {});
  }
}

async function prepareMissing(connection, sessionId, slot) {
  await evaluate(connection, sessionId, `(async () => {
    await chrome.developerPrivate.updateProfileConfiguration({ inDeveloperMode: true });
    document.title = ${JSON.stringify(`AICC CDP ${slot} Extensions`)};
    return (await chrome.developerPrivate.getProfileConfiguration()).inDeveloperMode;
  })()`);
}

async function applyOptions(connection, extensionId, entry) {
  const options = entry.options ?? {};
  const update = { extensionId };
  const mappings = {
    incognito_access: "incognitoAccess",
    file_access: "fileAccess",
    error_collection: "errorCollection",
    show_access_requests_in_toolbar: "showAccessRequestsInToolbar"
  };
  for (const [registryKey, apiKey] of Object.entries(mappings)) {
    if (options[registryKey] !== undefined) update[apiKey] = options[registryKey];
  }
  if (Object.keys(update).length > 1) {
    await evaluate(connection, undefined, `(async () => {
      await chrome.developerPrivate.updateExtensionConfiguration(${JSON.stringify(update)});
      return true;
    })()`);
  }
  if (options.host_access === "ON_SPECIFIC_SITES") {
    const sites = entry.allowed_host_permissions ?? [];
    if (sites.length === 0) throw new Error(`ON_SPECIFIC_SITES requires an explicit non-empty host allowlist for ${entry.key}`);
    await evaluate(connection, undefined, `(async () => {
      const extensionId = ${JSON.stringify(extensionId)};
      const sites = ${JSON.stringify(sites)};
      await chrome.developerPrivate.updateExtensionConfiguration({ extensionId, hostAccess: "ON_CLICK" });
      for (const site of sites) {
        await chrome.developerPrivate.updateSiteAccess(site, [{ id: extensionId, siteAccess: "ON_SPECIFIC_SITES" }]);
      }
      return true;
    })()`);
  } else if (options.host_access !== undefined) {
    await evaluate(connection, undefined, `(async () => {
      await chrome.developerPrivate.updateExtensionConfiguration({
        extensionId: ${JSON.stringify(extensionId)},
        hostAccess: ${JSON.stringify(options.host_access)}
      });
      return true;
    })()`);
  }
  if (typeof entry.pin_to_toolbar === "boolean") {
    await evaluate(connection, undefined, `(async () => {
      for (let attempt = 0; attempt < 40; attempt += 1) {
        try {
          await chrome.developerPrivate.updateExtensionConfiguration({
            extensionId: ${JSON.stringify(extensionId)},
            pinnedToToolbar: ${JSON.stringify(entry.pin_to_toolbar)}
          });
          return true;
        } catch (error) {
          if (!String(error?.message ?? error).includes("no action") || attempt === 39) throw error;
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
      }
    })()`);
  }
  if (typeof options.enabled === "boolean") {
    await evaluate(connection, undefined, `(async () => {
      await chrome.management.setEnabled(${JSON.stringify(extensionId)}, ${JSON.stringify(options.enabled)});
      return true;
    })()`);
  }
}

async function manageEntry(browserConnection, endpoint, session, entry, slot, action) {
  const connection = session.connection;
  let items = await extensionInfo(connection, undefined);
  let match = findMatch(items, entry);
  let loadedNow = false;
  if (action === "remove") {
    if (!match) {
      return { key: entry.key, status: "already_absent", extension_path: entry.path, action };
    }
    await browserConnection.send("Extensions.uninstall", { id: match.id });
    for (let attempt = 0; attempt < 40; attempt += 1) {
      items = await extensionInfo(connection, undefined);
      if (!findMatch(items, entry)) {
        return { key: entry.key, status: "removed_from_session", id: match.id, extension_path: entry.path, action };
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(`Chrome did not remove ${entry.key} from ${slot}`);
  }
  if (!match) {
    if (action === "ensure") {
      try {
        await browserConnection.send("Extensions.loadUnpacked", {
          path: path.resolve(entry.path),
          enableInIncognito: entry.options?.incognito_access === true
        });
        loadedNow = true;
        items = await extensionInfo(connection, undefined);
        match = findMatch(items, entry);
        if (!match) throw new Error(`CDP loaded ${entry.key}, but Chrome extensions UI did not report it`);
      } catch (error) {
        if (!String(error.message).includes("wasn't found") &&
            !String(error.message).includes("Method not available")) throw error;
        await prepareMissing(connection, undefined, slot);
        await browserConnection.send("Target.activateTarget", { targetId: session.targetId });
        return {
          key: entry.key,
          status: "missing_persistent_install",
          extension_path: entry.path,
          user_action: "load_unpacked_once",
          reason: "cdp_extensions_domain_unavailable"
        };
      }
    } else if (action === "reload" || action === "configure") {
      throw new Error(`Cannot ${action} missing extension ${entry.key} on ${slot}`);
    } else {
      return {
        key: entry.key,
        status: "not_loaded",
        extension_path: entry.path,
        user_action: null
      };
    }
  }

  if (action === "reload" || (action === "ensure" && !loadedNow)) {
    await evaluate(connection, undefined, `(async () => {
      await chrome.developerPrivate.reload(${JSON.stringify(match.id)}, {
        failQuietly: false,
        populateErrorForUnpacked: true
      });
      await new Promise((resolve) => setTimeout(resolve, 500));
      return true;
    })()`);
    items = await extensionInfo(connection, undefined);
    match = findMatch(items, entry);
  }

  const values = expandStorage(entry.storage, slot);
  const display = action === "status" ? {} : await configureStorage(browserConnection, endpoint, match.id, values, entry);
  if (action !== "status") await applyOptions(connection, match.id, entry);
  items = await extensionInfo(connection, undefined);
  match = findMatch(items, entry);
  const storageMatches = action === "status"
    ? true
    : JSON.stringify(display.stored ?? {}) === JSON.stringify(values);
  const badgeMatches = action === "status" || !entry.verify?.badge_from_slot_suffix || display.badge === slot.slice(-2);
  const titleMatches = action === "status" || !entry.verify?.title_contains_slot || String(display.title ?? "").includes(slot);
  const postcondition = evaluateExtensionPostcondition({ match, entry, action, storedMatches: storageMatches, badgeMatches, titleMatches });
  const result = {
    key: entry.key,
    status: postcondition.ok ? "ready" : "postcondition_failed",
    id: match.id,
    version: match.version,
    extension_path: match.path,
    enabled: match?.state === "ENABLED",
    pinned: match.pinned,
    options: {
      incognito_access: match.incognito_access,
      file_access: match.file_access,
      error_collection: match.error_collection,
      host_access: match.host_access,
      runtime_hosts: match.runtime_hosts,
      show_access_requests_in_toolbar: match.show_access_requests_in_toolbar
    },
    badge: display.badge ?? null,
    title: display.title ?? null,
    postcondition,
    action,
    deployment: loadedNow
      ? "cdp_session_load"
      : action === "configure" ? "existing_session_configuration" : "existing_session_reload"
  };
  return result;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const slot = String(args.slot ?? "");
  const endpoint = new URL(args.endpoint);
  const action = String(args.action ?? "status").toLowerCase();
  const selectedKey = String(args.extension ?? "all");
  if (!["status", "reload", "ensure", "configure", "remove"].includes(action)) throw new Error(`Unsupported action: ${action}`);
  if (!["9222", "9223", "9224", "9225"].includes(slot)) throw new Error(`Unsupported slot: ${slot}`);
  const entries = await loadRegistry(path.resolve(args.registry), slot, selectedKey);
  const version = await (await fetch(new URL("/json/version", endpoint))).json();
  if (!version.webSocketDebuggerUrl) throw new Error(`No browser WebSocket at ${endpoint.origin}`);
  const connection = new CdpConnection(version.webSocketDebuggerUrl);
  await connection.connect();
  let session;
  try {
    session = await openExtensionsSession(endpoint, action === "ensure");
    const results = [];
    for (const entry of entries) results.push(await manageEntry(connection, endpoint, session, entry, slot, action));
    session.keepOpen = results.some((result) => result.status === "missing_persistent_install");
    const ok = results.every(result => result.status !== "postcondition_failed");
    process.stdout.write(`${JSON.stringify({ ok, endpoint: endpoint.origin, slot, action, results })}\n`);
  } finally {
    if (session?.targetId && !session.keepOpen) {
      await connection.send("Target.closeTarget", { targetId: session.targetId }).catch(() => {});
    }
    session?.connection?.close();
    connection.close();
  }
}

main().catch((error) => {
  process.stderr.write(`${error.stack ?? error.message}\n`);
  process.exitCode = 1;
});
