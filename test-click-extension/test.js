// Click Tester — tries 3 different click mechanisms on whatever button is found.
// Open the console (F12) for extra detail on each attempt.

const panel = document.createElement('div');
panel.style.cssText = `
  position: fixed; top: 12px; right: 12px; z-index: 999999;
  background: #1a365d; color: white;
  padding: 10px 14px; border-radius: 8px;
  font-family: sans-serif; font-size: 13px;
  box-shadow: 0 4px 16px rgba(0,0,0,0.4);
  min-width: 240px;
`;
panel.innerHTML = `
  <div style="font-weight:700;margin-bottom:8px;">🔧 Click Tester</div>
  <button id="ct-find" style="width:100%;padding:6px;margin-bottom:4px;background:#3182ce;color:white;border:none;border-radius:5px;cursor:pointer;font-size:12px;">
    1. Find Login Button
  </button>
  <div style="font-size:10px;color:#a0aec0;margin-bottom:8px;padding:0 2px;">
    — then try each method below —
  </div>

  <button id="ct-m1" disabled style="width:100%;padding:6px;margin-bottom:4px;background:#2d6a4f;color:white;border:none;border-radius:5px;cursor:pointer;font-size:12px;">
    Method 1 · .click()
  </button>
  <button id="ct-m2" disabled style="width:100%;padding:6px;margin-bottom:4px;background:#2d6a4f;color:white;border:none;border-radius:5px;cursor:pointer;font-size:12px;">
    Method 2 · MouseEvent dispatch
  </button>
  <button id="ct-m3" disabled style="width:100%;padding:6px;margin-bottom:8px;background:#2d6a4f;color:white;border:none;border-radius:5px;cursor:pointer;font-size:12px;">
    Method 3 · Script injection (page context)
  </button>

  <div id="ct-log" style="font-size:11px;background:#2d3748;padding:6px;border-radius:4px;min-height:50px;white-space:pre-wrap;word-break:break-all;color:#fff;">
    Waiting…
  </div>
`;
document.body.appendChild(panel);

const log    = panel.querySelector('#ct-log');
const findBtn = panel.querySelector('#ct-find');
const m1 = panel.querySelector('#ct-m1');
const m2 = panel.querySelector('#ct-m2');
const m3 = panel.querySelector('#ct-m3');
let target = null;

function print(msg, color) {
  log.style.color = color || '#fff';
  log.textContent = msg;
  console.log('[ClickTest]', msg);
}

function enableMethods() {
  [m1, m2, m3].forEach(b => b.disabled = false);
}

// ── Find ──────────────────────────────────────────────────────
findBtn.addEventListener('click', () => {
  target = null;
  [m1, m2, m3].forEach(b => b.disabled = true);

  const candidates = document.querySelectorAll(
    'button, input[type="button"], input[type="submit"], a, [role="button"]'
  );

  console.log('[ClickTest] All elements:', Array.from(candidates).map(el =>
    `<${el.tagName.toLowerCase()} id="${el.id}" value="${el.value||''}" text="${(el.textContent||'').trim().slice(0,40)}">`
  ));

  for (const el of candidates) {
    const text = (el.textContent || el.value || '').toLowerCase().trim();
    if (text.includes('login') || text === 'log in') { target = el; break; }
  }

  if (target) {
    print(`✅ Found: <${target.tagName.toLowerCase()}> id="${target.id}" value="${target.value}"`, '#68d391');
    enableMethods();
  } else {
    print('❌ Not found. Check console for full element list.', '#fc8181');
  }
});

// ── Method 1: plain .click() ─────────────────────────────────
m1.addEventListener('click', () => {
  if (!target) return;
  print('Method 1: calling target.click()…', '#fbd38d');
  try {
    target.click();
    print('Method 1: .click() called.\nWatch the page — did it respond?', '#90cdf4');
  } catch(e) {
    print('Method 1 error: ' + e.message, '#fc8181');
  }
});

// ── Method 2: full MouseEvent ────────────────────────────────
m2.addEventListener('click', () => {
  if (!target) return;
  print('Method 2: dispatching MouseEvent…', '#fbd38d');
  try {
    const evt = new MouseEvent('click', {
      bubbles: true,
      cancelable: true,
      view: window,
      isTrusted: false,
    });
    const result = target.dispatchEvent(evt);
    print(`Method 2: dispatched. defaultPrevented=${!result}\nWatch the page — did it respond?`, '#90cdf4');
  } catch(e) {
    print('Method 2 error: ' + e.message, '#fc8181');
  }
});

// ── Method 3: script injection (runs in page's JS context) ───
// Content scripts live in an isolated world — page functions like
// __doPostBack() are invisible to them. Injecting a <script> tag
// executes code directly in the page context where those functions exist.
m3.addEventListener('click', () => {
  if (!target) return;
  print('Method 3: injecting script into page context…', '#fbd38d');
  try {
    const id = target.id;
    const name = target.name || target.id;

    const script = document.createElement('script');
    script.textContent = `
      (function() {
        var el = document.getElementById('${id}');
        if (!el) { console.warn('[ClickTest] Method 3: element not found by id'); return; }
        // Try calling __doPostBack directly (ASP.NET WebForms standard mechanism)
        if (typeof __doPostBack === 'function') {
          console.log('[ClickTest] Method 3: calling __doPostBack("${name}", "")');
          __doPostBack('${name}', '');
        } else {
          // Fallback: native click in page context
          console.log('[ClickTest] Method 3: __doPostBack not found, calling el.click()');
          el.click();
        }
      })();
    `;
    document.documentElement.appendChild(script);
    script.remove();
    print('Method 3: script injected.\nWatch the page — did it respond?', '#90cdf4');
  } catch(e) {
    print('Method 3 error: ' + e.message, '#fc8181');
  }
});
