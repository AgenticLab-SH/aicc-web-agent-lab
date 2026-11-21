import { apps, filterApps, states, updatedAt } from './data.mjs';

const get = (id) => document.getElementById(id);
const search = get('search');
const filter = get('filter');
const list = get('apps-list');
const detail = get('app-detail');
const timestamp = get('updated');

timestamp.dateTime = updatedAt;
timestamp.textContent = new Intl.DateTimeFormat('ko-KR', {
  dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Seoul',
}).format(new Date(updatedAt)) + ' KST';

for (const [key, state] of Object.entries(states)) filter.add(new Option(state.label, key));

function render() {
  const rows = filterApps(apps, search.value, filter.value);
  get('count').textContent = rows.length ? `${rows.length}개 앱` : '조건과 맞는 앱이 없습니다.';
  list.replaceChildren();

  for (const app of rows) {
    const state = states[app.state];
    const card = document.createElement('article');
    const status = document.createElement('p');
    const title = document.createElement('h3');
    const description = document.createElement('p');
    status.className = 'state';
    status.textContent = state.label;
    title.textContent = app.title;
    description.textContent = app.description;
    card.append(status, title, description);

    if (state.action) {
      const button = document.createElement('button');
      button.textContent = state.action;
      button.setAttribute('aria-label', `${app.title} ${state.action}`);
      button.addEventListener('click', () => {
        get('detail-title').textContent = app.title;
        get('detail-message').textContent = `${state.label} 상태의 예시입니다.`;
        detail.showModal();
      });
      card.append(button);
    }
    list.append(card);
  }
}

search.addEventListener('input', render);
filter.addEventListener('change', render);
render();
