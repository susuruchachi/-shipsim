// ========================================================
//  全パラメーターへの微調整ボタン自動付与
// ========================================================

function fireInputEvents(el) {
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
}

function stepDecimals(step) {
    const s = String(step);
    return s.includes('.') ? s.split('.')[1].length : 0;
}

function adjustNumberInput(input, delta) {
    let v = parseFloat(input.value);
    if (!Number.isFinite(v)) v = 0;
    v += delta;
    const min = input.min !== '' ? parseFloat(input.min) : -Infinity;
    const max = input.max !== '' ? parseFloat(input.max) : Infinity;
    v = Math.max(min, Math.min(max, v));
    const dec = stepDecimals(input.step || delta);
    v = Number(v.toFixed(dec));
    input.value = v;
    fireInputEvents(input);
}

function makeMiniBtn(label, onClick) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'sp-mini-btn';
    btn.textContent = label;
    btn.tabIndex = -1;
    btn.addEventListener('click', (e) => {
        e.preventDefault();
        onClick();
    });
    return btn;
}

// .sp-slider + .sp-num-input の組み合わせに、ステップ刻みの微調整ボタンを両側に追加
function addFineTuneToSliderRow(slider) {
    if (slider.dataset.fineTuned) return;
    const row = slider.closest('.sp-row');
    if (!row) return;
    // 既に専用の +/- ボタン (spAdj等) を持つ行はスキップ
    if (row.querySelector('.sp-btn')) { slider.dataset.fineTuned = '1'; return; }

    const step = parseFloat(slider.step) || 1;
    const numInput = row.querySelector('.sp-num-input');

    const decBtn = makeMiniBtn('−', () => {
        adjustNumberInput(slider, -step);
        if (numInput) { numInput.value = slider.value; fireInputEvents(numInput); }
    });
    const incBtn = makeMiniBtn('＋', () => {
        adjustNumberInput(slider, step);
        if (numInput) { numInput.value = slider.value; fireInputEvents(numInput); }
    });
    slider.parentNode.insertBefore(decBtn, slider);
    slider.parentNode.insertBefore(incBtn, slider.nextSibling);
    slider.dataset.fineTuned = '1';
}

// スライダーを持たない単独の .sp-num-input（funnelの下径/高さ、推進器サイズなど）に微調整ボタンを追加
function addFineTuneToStandaloneNumInput(input) {
    if (input.dataset.fineTuned) return;
    if (input.previousElementSibling && input.previousElementSibling.classList && input.previousElementSibling.classList.contains('sp-mini-btn')) {
        input.dataset.fineTuned = '1'; return;
    }
    // sp-row内にrange(スライダー)が既にある場合はスライダー側で処理済み
    const row = input.closest('.sp-row');
    if (row && row.querySelector('input[type="range"]')) { input.dataset.fineTuned = '1'; return; }
    if (row && row.querySelector('.sp-btn')) { input.dataset.fineTuned = '1'; return; }

    const step = parseFloat(input.step) || 1;
    const wrap = document.createElement('span');
    wrap.className = 'sp-num-wrap';
    const decBtn = makeMiniBtn('−', () => adjustNumberInput(input, -step));
    const incBtn = makeMiniBtn('＋', () => adjustNumberInput(input, step));
    input.parentNode.insertBefore(wrap, input);
    wrap.appendChild(decBtn);
    wrap.appendChild(input);
    wrap.appendChild(incBtn);
    input.dataset.fineTuned = '1';
}

// .sp-xyz-row 内の各 .sp-xyz-input に微調整ボタンを追加
function addFineTuneToXyzInput(input) {
    if (input.dataset.fineTuned) return;
    const step = parseFloat(input.step) || 0.1;
    const wrap = document.createElement('span');
    wrap.className = 'sp-xyz-wrap';
    const decBtn = makeMiniBtn('−', () => adjustNumberInput(input, -step));
    const incBtn = makeMiniBtn('＋', () => adjustNumberInput(input, step));
    input.parentNode.insertBefore(wrap, input);
    wrap.appendChild(decBtn);
    wrap.appendChild(input);
    wrap.appendChild(incBtn);
    input.dataset.fineTuned = '1';
}

// 設定パネル全体（または指定範囲）に微調整ボタンを付与する
function addFineTuneButtons(root) {
    root = root || document;
    root.querySelectorAll('.sp-slider[type="range"]').forEach(addFineTuneToSliderRow);
    root.querySelectorAll('.sp-num-input').forEach(addFineTuneToStandaloneNumInput);
    root.querySelectorAll('.sp-xyz-input').forEach(addFineTuneToXyzInput);
}

