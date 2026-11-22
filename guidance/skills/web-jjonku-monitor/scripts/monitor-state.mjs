import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  EXPECTED_GPT_GROUP_TABS,
  EXPECTED_GPT_GROUP_TAB_COUNT,
  GPT_GROUP_NAME,
  MONITOR_TARGET_SET_ID,
  normalizeGptGroupIdentity
} from './monitor-targets.mjs';

const STATE_SCHEMA_VERSION = 7;
const ACTIONS = new Set(['none', 'reloaded', 'continued', 'timeout-resumed', 'stopped-and-continued', 'complexity-resumed', 'held']);
const TARGET_STATES = new Set(['working', 'completed', 'error', 'unknown', 'idle']);
const FINGERPRINT = /^[0-9a-f]{64}$/;
const DEFAULT_CONFIG = {
  enabled: false,
  targetSetId: MONITOR_TARGET_SET_ID,
  groupName: GPT_GROUP_NAME,
  expectedTabCount: EXPECTED_GPT_GROUP_TAB_COUNT,
  tabConversationTitles: EXPECTED_GPT_GROUP_TABS.map(item => item.title),
  tabConversationIds: EXPECTED_GPT_GROUP_TABS.map(item => item.conversationId),
  checkIntervalMinutes: 5,
  stalledMinutes: 30,
  messages: {
    continue: '작업을 계속하면 돼.\n\n작업 단위는 중간 보고 단위 5개마다 최종 보고를 하여 대화를 종료해.\n\n그 다음 사용자 지시를 받으면 작업을 지속하면 돼.',
    timeout: "'메시지 전송 시간이 초과되었습니다. 다시 시도해주세요'라는 문구가 떴어. 주의하면서 작업을 계속하면 돼.\n\n작업 단위는 중간 보고 단위 5개마다 최종 보고를 하여 대화를 종료해.\n\n그 다음 사용자 지시를 받으면 작업을 지속하면 돼.",
    complexity: '명칭들을 다 개선하자. 명확하고 지속가능한 명칭으로 모든 문서와 코드의 명칭을 개선하고 시작하자. 복잡성을 개선하고, 정리를 잘 해두고 재개하자. 삭제하지말고 보관처리를 하도록 해. 너무 큰 용량은 판단해보고 삭제해도 돼. 삭제 실수를 하면 안되니까 정확하게 그 파일을 해.'
  }
};

function stateFile() {
  const root = process.env.AICC_STATE_ROOT?.trim() || path.join(os.homedir(), '.ai-control-center');
  const directory = path.join(root, 'control-plane');
  return {
    directory,
    file: path.join(directory, 'web-jjonku-monitor-state.json'),
    configFile: path.join(directory, 'web-jjonku-monitor.json')
  };
}

function validDate(value, allowNull = false) {
  return allowNull && value === null || typeof value === 'string' && Number.isFinite(Date.parse(value));
}

function validFingerprint(value) {
  return value === null || typeof value === 'string' && FINGERPRINT.test(value);
}

function validateConfig(config) {
  const integerInRange = (value, min, max) => Number.isInteger(value) && value >= min && value <= max && value % 5 === 0;
  if (!config || typeof config !== 'object' || typeof config.enabled !== 'boolean'
    || config.targetSetId !== MONITOR_TARGET_SET_ID
    || config.groupName !== GPT_GROUP_NAME
    || config.expectedTabCount !== EXPECTED_GPT_GROUP_TAB_COUNT
    || !Array.isArray(config.tabConversationTitles)
    || config.tabConversationTitles.length !== EXPECTED_GPT_GROUP_TAB_COUNT
    || EXPECTED_GPT_GROUP_TABS.some((item, index) => config.tabConversationTitles[index] !== item.title)
    || !Array.isArray(config.tabConversationIds)
    || config.tabConversationIds.length !== EXPECTED_GPT_GROUP_TAB_COUNT
    || EXPECTED_GPT_GROUP_TABS.some((item, index) => config.tabConversationIds[index] !== item.conversationId)
    || !integerInRange(config.checkIntervalMinutes, 5, 60)
    || !integerInRange(config.stalledMinutes, 10, 180) || config.stalledMinutes < config.checkIntervalMinutes
    || !config.messages || ['continue', 'timeout', 'complexity'].some(key => typeof config.messages[key] !== 'string'
      || !config.messages[key].trim() || config.messages[key].length > 2_000)) {
    throw new Error('saved monitor config is invalid; stop without replacing it with defaults');
  }
  return {
    enabled: config.enabled,
    targetSetId: MONITOR_TARGET_SET_ID,
    groupName: GPT_GROUP_NAME,
    expectedTabCount: EXPECTED_GPT_GROUP_TAB_COUNT,
    tabConversationTitles: EXPECTED_GPT_GROUP_TABS.map(item => item.title),
    tabConversationIds: EXPECTED_GPT_GROUP_TABS.map(item => item.conversationId),
    checkIntervalMinutes: config.checkIntervalMinutes,
    stalledMinutes: config.stalledMinutes,
    messages: Object.fromEntries(['continue', 'timeout', 'complexity'].map(key => [key, config.messages[key]]))
  };
}

function migrateLegacyConfig(config) {
  const knownOldTabGroup = config?.groupName === GPT_GROUP_NAME
    && config?.expectedTabCount === EXPECTED_GPT_GROUP_TAB_COUNT
    && ['chatgpt-chrome-group-gpt-7-v3', 'chatgpt-chrome-tab-group-gpt-7-v4', undefined].includes(config?.targetSetId);
  const oldIds = config?.tabConversationIds;
  const oldTitles = config?.tabConversationTitles;
  const rosterMatches = Array.isArray(oldIds) && oldIds.length === EXPECTED_GPT_GROUP_TAB_COUNT
    && EXPECTED_GPT_GROUP_TABS.every((item, index) => oldIds[index] === item.conversationId)
    && (!oldTitles || Array.isArray(oldTitles) && oldTitles.length === EXPECTED_GPT_GROUP_TAB_COUNT
      && EXPECTED_GPT_GROUP_TABS.every((item, index) => oldTitles[index] === item.title));
  if (!knownOldTabGroup || !rosterMatches) {
    throw new Error('saved settings do not prove the seven designated conversations; preserve them and stop');
  }
  return validateConfig({
    enabled: config.enabled,
    targetSetId: MONITOR_TARGET_SET_ID,
    groupName: GPT_GROUP_NAME,
    expectedTabCount: EXPECTED_GPT_GROUP_TAB_COUNT,
    tabConversationTitles: EXPECTED_GPT_GROUP_TABS.map(item => item.title),
    tabConversationIds: EXPECTED_GPT_GROUP_TABS.map(item => item.conversationId),
    checkIntervalMinutes: config.checkIntervalMinutes,
    stalledMinutes: config.stalledMinutes,
    messages: config.messages
  });
}

export function normalizeMonitorState(value) {
  if (!value || typeof value !== 'object' || value.schemaVersion !== STATE_SCHEMA_VERSION
    || value.targetSetId !== MONITOR_TARGET_SET_ID || value.groupName !== GPT_GROUP_NAME || !validDate(value.lastCheckedAt)
    || !ACTIONS.has(value.lastAction) || typeof value.anchorTabConversationId !== 'string'
    || !Array.isArray(value.targets) || value.targets.length !== EXPECTED_GPT_GROUP_TAB_COUNT) {
    throw new Error('monitor receipt must identify the seven designated tabs in Chrome group GPT');
  }

  const identities = normalizeGptGroupIdentity({
    groupName: value.groupName,
    anchorTabConversationId: value.anchorTabConversationId,
    groupTabs: value.targets.map(target => ({ title: target?.title, conversationId: target?.conversationId }))
  });
  const byId = new Map(value.targets.map(target => [target.conversationId.toLowerCase(), target]));
  const targets = identities.tabs.map(identity => {
    const target = byId.get(identity.conversationId);
    if (!target || !TARGET_STATES.has(target.state) || !validDate(target.lastObservedAt)
      || !validDate(target.lastProgressAt, true) || !validDate(target.workingSinceAt, true)
      || (target.state === 'working') !== (target.workingSinceAt !== null)
      || !validFingerprint(target.progressFingerprint) || !validFingerprint(target.handledSignalFingerprint)) {
      throw new Error('monitor receipt contains an invalid GPT group tab state or timestamp');
    }
    return {
      tabIndex: identity.tabIndex,
      title: identity.title,
      conversationId: identity.conversationId,
      state: target.state,
      lastObservedAt: target.lastObservedAt,
      lastProgressAt: target.lastProgressAt,
      workingSinceAt: target.workingSinceAt,
      progressFingerprint: target.progressFingerprint,
      handledSignalFingerprint: target.handledSignalFingerprint
    };
  });

  return {
    schemaVersion: STATE_SCHEMA_VERSION,
    targetSetId: MONITOR_TARGET_SET_ID,
    groupName: GPT_GROUP_NAME,
    anchorTabConversationId: identities.anchorTabConversationId,
    lastCheckedAt: value.lastCheckedAt,
    lastAction: value.lastAction,
    targets
  };
}

export function readMonitorConfig(options = {}) {
  const { configFile } = options.configFile ? { configFile: options.configFile } : stateFile();
  if (!fs.existsSync(configFile)) return { config: structuredClone(DEFAULT_CONFIG), isDefault: true, savedAt: null };
  const stat = fs.lstatSync(configFile);
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error('monitor config must be a regular file');
  const stored = JSON.parse(fs.readFileSync(configFile, 'utf8'));
  if (![1, 2, 3, 4, 5, 6, STATE_SCHEMA_VERSION].includes(stored.schemaVersion)) throw new Error('saved monitor config version is invalid; preserve it and stop');
  const config = stored.schemaVersion === STATE_SCHEMA_VERSION
    ? validateConfig(stored.config)
    : migrateLegacyConfig(stored.config);
  return { config, isDefault: false, savedAt: typeof stored.savedAt === 'string' ? stored.savedAt : null };
}

export function readMonitorState(options = {}) {
  const paths = options.file ? { file: options.file, configFile: options.configFile } : stateFile();
  const { file } = paths;
  const { config } = readMonitorConfig(paths);
  if (!fs.existsSync(file)) return {
    schemaVersion: STATE_SCHEMA_VERSION, targetSetId: MONITOR_TARGET_SET_ID, groupName: GPT_GROUP_NAME, anchorTabConversationId: null,
    lastCheckedAt: null, lastAction: null, targets: [], legacyReceipt: false,
    effectiveIntervalMinutes: config.checkIntervalMinutes, nextCheckDueAt: null
  };
  const stat = fs.lstatSync(file);
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error('monitor receipt must be a regular file');
  const stored = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (stored.schemaVersion !== STATE_SCHEMA_VERSION) return {
    schemaVersion: STATE_SCHEMA_VERSION, targetSetId: MONITOR_TARGET_SET_ID, groupName: GPT_GROUP_NAME, anchorTabConversationId: null,
    lastCheckedAt: null, lastAction: null, targets: [], legacyReceipt: true,
    effectiveIntervalMinutes: config.checkIntervalMinutes, nextCheckDueAt: null
  };
  const state = normalizeMonitorState(stored);
  return {
    ...state,
    legacyReceipt: false,
    effectiveIntervalMinutes: config.checkIntervalMinutes,
    nextCheckDueAt: new Date(Date.parse(state.lastCheckedAt) + config.checkIntervalMinutes * 60_000).toISOString()
  };
}

export function recordMonitorState(value, options = {}) {
  if (!value || typeof value !== 'object' || !validDate(value.lastCheckedAt)
    || !ACTIONS.has(value.lastAction) || !Array.isArray(value.observations)) {
    throw new Error('record input needs the exact GPT tab group identity and seven conversation observations');
  }
  const gptGroupIdentity = normalizeGptGroupIdentity(value.gptGroupIdentity);
  if (value.observations.length !== EXPECTED_GPT_GROUP_TAB_COUNT) throw new Error('record input needs exactly seven GPT group tab observations');
  const byId = new Map();
  for (const observation of value.observations) {
    const id = observation?.conversationId?.toLowerCase();
    if (typeof id !== 'string' || byId.has(id)) throw new Error('GPT group tab observations must use unique exact conversation IDs');
    byId.set(id, observation);
  }
  const targets = gptGroupIdentity.tabs.map(identity => {
    const observation = byId.get(identity.conversationId);
    if (!observation || (observation.title && observation.title !== identity.title)) throw new Error('every GPT group tab needs one matching observation');
    return {
      ...identity,
      state: observation.state,
      lastObservedAt: observation.lastObservedAt,
      lastProgressAt: observation.lastProgressAt,
      workingSinceAt: observation.workingSinceAt,
      progressFingerprint: observation.progressFingerprint ?? null,
      handledSignalFingerprint: observation.handledSignalFingerprint ?? null
    };
  });
  if (byId.size !== gptGroupIdentity.tabs.length) throw new Error('record input contains a conversation outside the GPT group roster');
  const state = normalizeMonitorState({
    schemaVersion: STATE_SCHEMA_VERSION,
    targetSetId: gptGroupIdentity.targetSetId,
    groupName: gptGroupIdentity.groupName,
    anchorTabConversationId: gptGroupIdentity.anchorTabConversationId,
    lastCheckedAt: value.lastCheckedAt,
    lastAction: value.lastAction,
    targets
  });
  const { directory, file } = options.file ? { directory: path.dirname(options.file), file: options.file } : stateFile();
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const dirStat = fs.lstatSync(directory);
  if (dirStat.isSymbolicLink() || !dirStat.isDirectory()) throw new Error('monitor state directory must be a regular directory');
  const temp = path.join(directory, `.web-jjonku-monitor-state.${process.pid}.${Date.now()}.tmp`);
  try {
    fs.writeFileSync(temp, `${JSON.stringify(state, null, 2)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    try { fs.chmodSync(temp, 0o600); } catch { /* Windows ACLs are inherited from the owner-local parent. */ }
    fs.renameSync(temp, file);
  } catch (error) {
    try { fs.rmSync(temp, { force: true }); } catch { /* preserve the previous receipt */ }
    throw error;
  }
  return state;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  try {
    const command = process.argv[2] || 'read';
    if (command === 'read') {
      console.log(JSON.stringify({ ...readMonitorState(), config: readMonitorConfig().config }));
    } else if (command === 'record') {
      let input = '';
      for await (const chunk of process.stdin) input += chunk;
      if (Buffer.byteLength(input, 'utf8') > 16_384) throw new Error('monitor receipt input is too large');
      console.log(JSON.stringify(recordMonitorState(JSON.parse(input))));
    } else {
      throw new Error('use read or record');
    }
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
