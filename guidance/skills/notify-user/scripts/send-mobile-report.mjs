import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {fileURLToPath} from 'node:url';

// Resolve the installed AICC package; do not embed an owner's repository path.
const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const deploymentManifest = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../.aicc-guidance-deployment.json');
const deployedRoot = fs.existsSync(deploymentManifest)
  ? JSON.parse(fs.readFileSync(deploymentManifest,'utf8')).aicc_root : null;
const root = process.env.AICC_ROOT || deployedRoot || sourceRoot;
if (!fs.existsSync(path.join(root,'src/notification-policy.mjs'))) throw Error('AICC_ROOT_required_for_deployed_skill');
const load = relative => import(pathToFileURL(path.join(root, relative)).href);
const [{planNotification}, {armNotification, loadNotificationPolicyConfig},
  {NotificationOutboxService}, {createSlackBotTransport, loadSlackBotConfig}, {redactText}] = await Promise.all([
  load('src/notification-policy.mjs'), load('src/notification-command.mjs'),
  load('src/notifications/outbox-service.mjs'), load('src/slack-bot-transport.mjs'), load('src/lib/redact.mjs')
]);
if (process.argv.length !== 4 || process.argv[2] !== '--input') throw Error('usage: --input report.json');
const input = JSON.parse(fs.readFileSync(process.argv[3], 'utf8'));
for (const key of ['eventId', 'taskId', 'projectKey', 'title', 'body']) {
  if (typeof input[key] !== 'string' || !input[key].trim()) throw Error(`required_${key}`);
}
if (input.type && input.type !== 'report_ready') throw Error('report_only');
if (input.sensitivity && input.sensitivity !== 'internal') throw Error('internal_report_only');
const urgency = input.urgency ?? 2;
if (![2, 3, 4].includes(urgency)) throw Error('invalid_report_urgency');
const maxChars = input.maxChars ?? 2900;
if (!Number.isInteger(maxChars) || maxChars < 1 || maxChars > 2900) throw Error('invalid_max_chars');
const text = `${urgency} ${{2:'일반',3:'확인',4:'중요'}[urgency]} | ${redactText(input.title)}\n${redactText(input.body)}`;
if (text.length > maxChars) throw Error('report_too_long');
if (/xox[baprs]-|sk-[A-Za-z0-9]{16,}|Bearer\s+\S{10,}/i.test(text)) throw Error('secret_like_content');
const event = {eventId:input.eventId,dedupeKey:input.eventId,type:'report_ready',urgency,
  sensitivity:'internal',source:'requested-mobile-report',projectKey:input.projectKey,
  owner:'central-controller',taskId:input.taskId,title:input.title,summary:input.body,nextGate:null};
const policy = loadNotificationPolicyConfig();
const transport = createSlackBotTransport({config:loadSlackBotConfig()});
// send() performs a fresh identity verification with its single native secret read.
const service = new NotificationOutboxService({planner:value=>{
  if (value.eventId !== event.eventId || value.type !== 'report_ready' || value.sensitivity !== 'internal') throw Error('exact_report_required');
  const plan = planNotification(value,{slack:policy.slackEnabled,telegram:policy.telegramEnabled},{routingProfile:policy.routingProfile});
  if (plan.primaryChannel !== 'slack') throw Error('slack_route_required');
  return {...plan,deliveries:plan.deliveries.map(d=>d.channel==='slack'?{...d,message:text}:d)};
},deliver:({eventId,message})=>transport.send({eventId,message})});
if (input.recoverCredentialReadFailure === true) {
  const previous=service.status({eventId:event.eventId,projectKey:event.projectKey,taskId:event.taskId});
  service.recoverCredentialReadFailure(event,{expectedVersion:previous.version,dedupeKey:event.dedupeKey});
}
const result = await armNotification(event,{bindingStore:false,outboxService:service});
const delivery = result.dispatch?.results?.find(row=>row.eventId===event.eventId);
const notification = delivery?.notification ?? result.notification;
console.log(JSON.stringify({eventId:event.eventId,state:notification?.state,deliveryRef:notification?.deliveryRef??null,
  sentAt:notification?.sentAt??null,duplicate:result.duplicate,chars:text.length}));
