// Headless Chrome over the DevTools protocol (CDP), with no dependencies: Node's
// own fetch and WebSocket talk to a Chrome that is already installed.
//
// Headless Chrome has no folder picker, so `showDirectoryPicker` is replaced by
// folders in the browser's private storage (OPFS), one per name queued with
// `nextFolder()`. That storage is only the test's stand-in for the user's disk:
// the app itself never keeps books there.

import { spawn, execFileSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Chrome's path: CHROME_PATH, or the usual install places. */
export function findChrome() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  const candidates = {
    win32: [
      'C:/Program Files/Google/Chrome/Application/chrome.exe',
      'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
      `${process.env.LOCALAPPDATA}/Google/Chrome/Application/chrome.exe`,
    ],
    darwin: ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'],
  }[process.platform];
  for (const c of candidates ?? []) if (existsSync(c)) return c;
  for (const name of ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser']) {
    try {
      return execFileSync('which', [name], { encoding: 'utf8' }).trim();
    } catch {
      // try the next name
    }
  }
  throw new Error('Chrome not found: set CHROME_PATH to chrome.exe or google-chrome.');
}

/** Start Chrome with its own profile and connect to its first tab; tries twice. */
export async function launch(profileDir) {
  try {
    return await launchOnce(profileDir);
  } catch {
    // A slow machine can miss the first start; a second one usually works
    return launchOnce(profileDir);
  }
}

async function launchOnce(profileDir) {
  const args = [
    '--headless=new',
    '--remote-debugging-port=0',
    `--user-data-dir=${profileDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--window-size=1280,900',
    'about:blank',
  ];
  // Ubuntu 24.04 (GitHub's runners) blocks Chrome's sandbox for unprivileged users
  if (process.platform === 'linux' && process.env.CI) args.unshift('--no-sandbox');
  // With port 0, Chrome picks a free port and writes it into the profile
  const portFile = join(profileDir, 'DevToolsActivePort');
  rmSync(portFile, { force: true });
  const chrome = spawn(findChrome(), args, { stdio: 'ignore' });
  const stopped = () =>
    new Promise((r) => (chrome.exitCode !== null ? r() : chrome.once('exit', r)));
  try {
    let port;
    for (let i = 0; i < 200 && !port; i++) {
      if (existsSync(portFile)) port = readFileSync(portFile, 'utf8').split('\n')[0];
      else await sleep(100);
    }
    if (!port) throw new Error('Chrome did not start within 20 seconds.');
    let target;
    for (let i = 0; i < 50 && !target; i++) {
      try {
        const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
        target = list.find((t) => t.type === 'page');
      } catch {
        await sleep(100);
      }
    }
    if (!target) throw new Error('Chrome started but has no tab to drive.');
    const page = new Page(target.webSocketDebuggerUrl);
    await page.connect();
    return {
      page,
      close: async () => {
        page.close();
        chrome.kill();
        // Give Chrome a moment to let go of its profile before it is deleted
        await stopped();
      },
    };
  } catch (e) {
    chrome.kill();
    await stopped();
    throw e;
  }
}

const PICKERS = `
  window.__folders = window.__folders || [];
  window.showDirectoryPicker = async () => {
    const name = window.__folders.shift();
    if (!name) throw new DOMException('cancelled', 'AbortError');
    return (await navigator.storage.getDirectory()).getDirectoryHandle(name, { create: true });
  };
  true`;

/** One tab, driven by CDP, with helpers that act on the page like a person would. */
export class Page {
  /** Console errors and uncaught exceptions seen so far */
  problems = [];
  /** Requests that failed or answered 400 or more, while online */
  badRequests = [];
  offline = false;
  #ws;
  #nextId = 1;
  #pending = new Map();

  constructor(url) {
    this.url = url;
  }

  async connect() {
    this.#ws = new WebSocket(this.url);
    await new Promise((r) => this.#ws.addEventListener('open', r, { once: true }));
    this.#ws.addEventListener('message', (ev) => this.#onMessage(JSON.parse(ev.data)));
    for (const d of ['Runtime', 'Page', 'Network', 'DOM']) await this.send(`${d}.enable`);
  }

  close() {
    this.#ws.close();
  }

  #onMessage(m) {
    if (m.id && this.#pending.has(m.id)) {
      this.#pending.get(m.id)(m);
      this.#pending.delete(m.id);
      return;
    }
    const p = m.params;
    if (m.method === 'Runtime.exceptionThrown') {
      this.problems.push(`exception: ${p.exceptionDetails.exception?.description}`);
    } else if (m.method === 'Runtime.consoleAPICalled' && p.type === 'error') {
      this.problems.push(`console.error: ${p.args.map((a) => a.value ?? a.description).join(' ')}`);
    } else if (m.method === 'Page.javascriptDialogOpening') {
      void this.send('Page.handleJavaScriptDialog', { accept: true });
    } else if (
      !this.offline &&
      m.method === 'Network.responseReceived' &&
      p.response.status >= 400
    ) {
      this.badRequests.push(`${p.response.status} ${p.response.url}`);
    } else if (!this.offline && m.method === 'Network.loadingFailed' && !p.canceled) {
      this.badRequests.push(`failed: ${p.errorText}`);
    }
  }

  send(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = this.#nextId++;
      this.#pending.set(id, (msg) =>
        msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result),
      );
      this.#ws.send(JSON.stringify({ id, method, params }));
    });
  }

  /** Evaluate an expression in the page and return its value. */
  async js(expression) {
    const r = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (r.exceptionDetails) {
      throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
    }
    return r.result.value;
  }

  async waitFor(condition, timeoutMs = 20_000) {
    const start = Date.now();
    for (;;) {
      try {
        if (await this.js(condition)) return;
      } catch {
        // the page may be between documents; try again
      }
      if (Date.now() - start > timeoutMs) throw new Error(`Timed out waiting for: ${condition}`);
      await sleep(100);
    }
  }

  /** Open the app and replace its folder picker. */
  async open(url) {
    await this.send('Page.navigate', { url });
    await this.waitFor(`!!document.querySelector('main')`);
    await this.js(PICKERS);
  }

  /** Reload, keeping the folder picker replaced. */
  async reload() {
    await this.send('Page.reload');
    await sleep(300);
    await this.waitFor(`!!document.querySelector('main')`, 30_000);
    await this.js(PICKERS);
  }

  /** The next folder picker returns this folder in the browser's private storage. */
  nextFolder(name) {
    return this.js(`(window.__folders.push(${JSON.stringify(name)}), true)`);
  }

  text() {
    return this.js('document.body.innerText');
  }

  has(s) {
    return this.js(`document.body.innerText.includes(${JSON.stringify(s)})`);
  }

  /** The dialog on top, or the page */
  static SCOPE = `(document.querySelector('.dialog') ?? document)`;

  /** Click a visible, enabled button by its text (exact, or how it starts). */
  async click(label, { exact = false, scope = Page.SCOPE } = {}) {
    const find = `[...${scope}.querySelectorAll('button')].find((b) => b.offsetParent && !b.disabled && (${exact} ? b.textContent.trim() === ${JSON.stringify(label)} : b.textContent.trim().startsWith(${JSON.stringify(label)})))`;
    await this.waitFor(`!!${find}`);
    await this.js(`(${find}).click(), true`);
    await sleep(150);
  }

  /** A sidebar page */
  nav(name) {
    return this.click(name, { exact: true, scope: `document.querySelector('.sidebar')` });
  }

  /** Type into the input or select under a label, as a person would. */
  async fill(label, value, { scope = Page.SCOPE } = {}) {
    const ok = await this.js(`(() => {
      const l = [...${scope}.querySelectorAll('label')].find((l) => l.firstChild?.textContent.trim() === ${JSON.stringify(label)});
      const input = l?.querySelector('input, select, textarea');
      return input ? (${setValue('input', value)}, true) : false;
    })()`);
    if (!ok) throw new Error(`No field labelled ${label}`);
  }

  /** Type into the input with this aria-label. */
  async fillAria(ariaLabel, value) {
    const ok = await this.js(`(() => {
      const input = document.querySelector(${JSON.stringify(`[aria-label="${ariaLabel}"]`)});
      return input ? (${setValue('input', value)}, true) : false;
    })()`);
    if (!ok) throw new Error(`No input ${ariaLabel}`);
  }

  /** Tick or untick the check box whose label includes this text. */
  async check(label, on = true) {
    const ok = await this.js(`(() => {
      const box = [...${Page.SCOPE}.querySelectorAll('label')].find((l) => l.textContent.includes(${JSON.stringify(label)}))?.querySelector('input[type=checkbox]');
      if (!box) return false;
      if (box.checked !== ${on}) box.click();
      return true;
    })()`);
    if (!ok) throw new Error(`No check box ${label}`);
  }

  /**
   * Pick an option in a combo box (account, payee): type to filter, then
   * choose the option whose text is `option`. `input` is an expression for the
   * combo's input element.
   */
  async pick(input, option) {
    await this.js(
      `(() => { const input = ${input}; input.focus(); ${setValue('input', option)}; return true; })()`,
    );
    const li = `[...document.querySelectorAll('.combo-list li[role=option]')].find((li) => li.textContent.trim() === ${JSON.stringify(option)})`;
    await this.waitFor(`!!${li}`, 5_000);
    await this.js(`(${li}).dispatchEvent(new MouseEvent('mousedown', { bubbles: true })), true`);
    await sleep(100);
  }

  /** The combo input under a label */
  static comboUnder(label, scope = Page.SCOPE) {
    return `[...${scope}.querySelectorAll('label')].find((l) => l.firstChild?.textContent.trim() === ${JSON.stringify(label)}).querySelector('.combo input')`;
  }

  /** Choose files in a file input, as if picked in the file dialog. */
  async setFiles(selector, paths) {
    const { result } = await this.send('Runtime.evaluate', {
      expression: `document.querySelector(${JSON.stringify(selector)})`,
    });
    if (!result.objectId) throw new Error(`No file input ${selector}`);
    await this.send('DOM.setFileInputFiles', { objectId: result.objectId, files: paths });
  }

  async screenshot() {
    const { data } = await this.send('Page.captureScreenshot', { format: 'png' });
    return Buffer.from(data, 'base64');
  }
}

/** JS that sets a form control's value the way React notices (the native setter, then an event). */
function setValue(el, value) {
  return `(() => {
    const proto = ${el}.tagName === 'SELECT' ? HTMLSelectElement.prototype : ${el}.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(${el}, ${JSON.stringify(String(value))});
    ${el}.dispatchEvent(new Event(${el}.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true }));
  })()`;
}
