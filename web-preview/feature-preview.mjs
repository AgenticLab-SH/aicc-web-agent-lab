const get = (id) => document.getElementById(id);

const focusDuration = 25 * 60;
let remaining = focusDuration;
let timerId = null;
let sessions = 2;
try {
  const saved = Number(localStorage.getItem('miru-demo-focus-sessions') ?? 2);
  if (Number.isSafeInteger(saved) && saved >= 0) sessions = saved;
} catch {
  // The demo still works for this page when browser storage is unavailable.
}
const streak = 4;
let lightOn = false;

function clockText(seconds) {
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return `${String(minutes).padStart(2, '0')}:${String(rest).padStart(2, '0')}`;
}

function setStatus(message) {
  const status = get('feature-status');
  if (status) status.textContent = message;
}

function renderFocus() {
  const clock = get('focus-clock');
  const count = get('focus-count');
  const streakLabel = get('streak-count');
  if (clock) clock.textContent = clockText(remaining);
  if (count) count.textContent = `${sessions}회`;
  if (streakLabel) streakLabel.textContent = `${streak}일째`;
}

function completeSession() {
  window.clearInterval(timerId);
  timerId = null;
  sessions += 1;

  try { localStorage.setItem('miru-demo-focus-sessions', String(sessions)); } catch {}

  remaining = focusDuration;
  renderFocus();
  get('focus-start').textContent = '다음 집중 시작';
  setStatus('집중 한 세션을 기록했어요. 작은 진전도 오늘의 성취예요.');
}

get('focus-start')?.addEventListener('click', () => {
  if (timerId) {
    window.clearInterval(timerId);
    timerId = null;
    get('focus-start').textContent = '집중 계속하기';
    setStatus('집중 타이머를 잠시 멈췄어요.');
    return;
  }
  get('focus-start').textContent = '잠시 멈추기';
  setStatus('25분 집중을 시작했어요. 끝나면 짧게 쉬어 주세요.');
  timerId = window.setInterval(() => {
    remaining -= 1;
    renderFocus();
    if (remaining <= 0) completeSession();
  }, 1000);
});

get('focus-finish')?.addEventListener('click', completeSession);

get('light-toggle')?.addEventListener('click', () => {
  lightOn = !lightOn;
  const button = get('light-toggle');
  const glow = get('light-glow');
  button.setAttribute('aria-pressed', String(lightOn));
  button.textContent = lightOn ? '조명 끄기' : '조명 켜기';
  glow.classList.toggle('is-on', lightOn);
  setStatus(lightOn
    ? '조명 미리보기를 켰어요. 실제 WiZ 전구 제어는 Android 앱에서 연결합니다.'
    : '조명 미리보기를 껐어요.');
});

get('light-preview')?.addEventListener('click', () => {
  lightOn = true;
  get('light-toggle').setAttribute('aria-pressed', 'true');
  get('light-toggle').textContent = '조명 끄기';
  get('light-glow').classList.add('is-on');
  setStatus('일출 색을 미리 보고 있어요. 실제 기기 연결은 Android에서 지원합니다.');
});

renderFocus();
