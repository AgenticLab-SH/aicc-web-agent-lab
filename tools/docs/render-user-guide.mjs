import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// The Markdown is the source. Use an existing marked installation; no install or network fetch.
const root = fileURLToPath(new URL('../../', import.meta.url));
const markedModule = process.argv[2];
if (!markedModule || !path.isAbsolute(markedModule)) throw new Error('Pass an absolute path to marked/lib/marked.esm.js');
const { marked } = await import(pathToFileURL(markedModule).href);
const source = fs.readFileSync(path.join(root, 'docs/user-guide.md'), 'utf8');
const headings = [];
let body = marked.parse(source, { gfm: true });
body = body.replace(/<h2>(.*?)<\/h2>/g, (_, label) => {
  const id = `section-${headings.length + 1}`;
  headings.push({ id, label });
  return `<h2 id="${id}">${label}</h2>`;
}).replace(/<table>/g, '<div class="table-scroll" tabindex="0" aria-label="표: 가로로 스크롤할 수 있습니다"><table>').replace(/<\/table>/g, '</table></div>');
const html = `<!doctype html>
<html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="description" content="AICC, OCX, Codex의 쉬운 사용법과 Windows 복구 안내"><title>AICC · OCX · Codex 사용 설명서</title>
<style>
:root{color-scheme:light;--ink:#26302d;--sub:#59635f;--green:#22584a;--line:#d9ded7;--paper:#fffefb;--bg:#f2f3ec}
*{box-sizing:border-box}html{scroll-behavior:smooth;scroll-padding-top:24px}body{margin:0;background:var(--bg);color:var(--ink);font-family:"Malgun Gothic",system-ui,sans-serif;line-height:1.85;font-size:16px}
.top{background:var(--green);color:white;padding:28px max(24px,calc((100vw - 1230px)/2))}.top p{margin:0;font-size:14px;opacity:.9}.top strong{display:block;font-size:23px;letter-spacing:-.8px;margin-top:4px}
.layout{max-width:1230px;margin:32px auto;display:grid;grid-template-columns:245px minmax(0,1fr);gap:28px;padding:0 24px}
nav{position:sticky;top:24px;align-self:start;max-height:calc(100vh - 48px);overflow:auto;padding:16px;background:var(--paper);border:1px solid var(--line);border-radius:10px}nav p{margin:0 0 12px;font-weight:700}nav a{display:block;padding:7px 5px;text-decoration:none;font-size:14px;line-height:1.6;color:var(--sub)}nav a:hover{background:#eaf0e9;color:var(--green)}
main{background:var(--paper);border:1px solid var(--line);border-radius:10px;padding:35px 42px;min-width:0}h1{font-size:30px;line-height:1.5;letter-spacing:-1.2px;margin:0 0 14px}h2{font-size:23px;line-height:1.5;margin:46px 0 18px;padding-top:26px;border-top:1px solid var(--line);letter-spacing:-.6px}h3{font-size:18px;margin:26px 0 12px}p{margin:12px 0}a{color:var(--green);text-underline-offset:4px}a:hover{color:#143d32}a:focus-visible,.table-scroll:focus-visible{outline:3px solid #986328;outline-offset:3px}li{margin:8px 0}ul,ol{padding-left:25px}
pre{background:#edf1eb;border-left:4px solid var(--green);padding:16px 20px;border-radius:4px;overflow:auto;line-height:1.65;font-size:17px}code{font-family:Consolas,"Malgun Gothic",monospace;background:#edf1eb;padding:2px 5px;border-radius:4px;overflow-wrap:anywhere}pre code{padding:0;background:none;overflow-wrap:normal}strong{font-weight:700}.table-scroll{overflow-x:auto;margin:18px 0}table{border-collapse:collapse;min-width:560px;width:100%;font-size:14px}th,td{padding:12px 14px;text-align:left;vertical-align:top;border-bottom:1px solid var(--line)}th{background:#edf1eb;color:var(--green)}tr:nth-child(even) td{background:#f8f9f4}footer{max-width:1230px;margin:25px auto 45px;padding:0 24px;color:var(--sub);font-size:13px}
@media(max-width:900px){.layout{grid-template-columns:1fr;gap:16px;margin:18px auto}nav{position:static;max-height:none}nav a{display:inline-block;margin-right:12px}main{padding:24px}h1{font-size:25px}h2{font-size:21px}}
@media(max-width:480px){.layout{padding:0 12px}main{padding:22px 18px}nav a{display:block}pre{font-size:15px;padding:13px}body{font-size:15px}}
@media print{body{background:white}.top,nav{display:none}.layout{display:block;max-width:none;margin:0;padding:0}main{border:0;padding:0}h2,h3{break-after:avoid}pre,table{break-inside:avoid}footer{margin:20px 0;padding:0}a{color:inherit}}
</style></head><body>
<header class="top"><p>내 컴퓨터에서 읽는 운영 안내</p><strong>사용법은 쉽게, 복구는 한 단계씩</strong></header>
<div class="layout"><nav aria-label="사용 설명서 목차"><p>필요한 부분으로 이동</p>${headings.map(({id,label}) => `<a href="#${id}">${label}</a>`).join('\n')}</nav>
<main>${body}</main></div><footer>문서 원본: user-guide.md · 이 페이지는 실시간 상태판이 아닙니다. 현재 상태는 aicc doctor와 작업 기록을 확인하세요. 명령은 자동 실행되지 않습니다.</footer></body></html>\n`;
fs.writeFileSync(path.join(root, 'docs/user-guide.html'), html, 'utf8');
console.log(JSON.stringify({ sections: headings.length, output: 'docs/user-guide.html', source: 'docs/user-guide.md' }));
