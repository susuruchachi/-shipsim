function setupKeyboardControls() {
    window.addEventListener('keydown', (e) => {
        if (document.activeElement && document.activeElement.tagName === 'INPUT') return;
        if (e.key === 'w' || e.key === 'W') changeTelegraph(1);
        if (e.key === 's' || e.key === 'S') changeTelegraph(-1);
        if (e.key === 'a' || e.key === 'A') keys.a = true;
        if (e.key === 'd' || e.key === 'D') keys.d = true;
    });
    window.addEventListener('keyup', (e) => {
        if (e.key === 'a' || e.key === 'A') keys.a = false;
        if (e.key === 'd' || e.key === 'D') keys.d = false;
    });
}

// ── HUD（ボタン・メーター類）の一括表示/非表示 ──────────────
// body.hud-hiddenクラスの有無をCSS側(#menu-toggle等の並び)で判定して
// display:noneに畳む。ダブルタップ・スクショ撮影の両方から使う共通処理。
let hudHiddenByUser = false; // ダブルタップでユーザーが明示的に隠した状態かどうか

function setHudVisible(visible) {
    document.body.classList.toggle('hud-hidden', !visible);
}

function isHudHidden() {
    return document.body.classList.contains('hud-hidden');
}

// ── v137: スクリーンショット撮影 ──────────────────────────
// rendererはpreserveDrawingBuffer未設定のため、requestAnimationFrame後に
// canvas.toBlob()を呼んでも既にバッファがクリアされ真っ黒/透明になり得る。
// そのためここでは「直接キャプチャ」せず、animate()内で実際に
// renderer.render(...)が呼ばれた直後（=画面に描画された直後）を
// window._pendingScreenshotフラグで捕まえてキャプチャする
// （フック本体はjs/17-main-loop.jsのanimate()末尾）。
let _screenshotInProgress = false;

function captureScreenshot() {
    if (_screenshotInProgress) return; // 連打防止
    _screenshotInProgress = true;

    // 現在のHUD状態を保存し、撮影用に一時的に非表示にする
    const wasHidden = isHudHidden();
    setHudVisible(false);

    // 次のanimate()フレームでの描画完了を待つ（HUDのdisplay:none反映と
    // 実際の1フレーム再描画を確実に挟むため、rAFを2回挟んでから撮影する）
    requestAnimationFrame(() => {
        requestAnimationFrame(() => {
            window._pendingScreenshotCallback = (canvas) => {
                try {
                    canvas.toBlob((blob) => {
                        if (blob) downloadScreenshotBlob(blob);
                        flashScreenshotFeedback();
                        finishScreenshot(wasHidden);
                    }, 'image/png');
                } catch (e) {
                    // toBlob非対応など万一の失敗時もHUD状態は必ず元に戻す
                    finishScreenshot(wasHidden);
                }
            };
        });
    });
}

// 画面全体を一瞬白く光らせてフェードアウトする、シャッター的な視覚フィードバック。
// HUD非表示中に発火するため、ボタン自体の見た目を変えるのではなく独立した
// #screenshot-flash要素で行う（HUD復帰前でも確実に見える）。
function flashScreenshotFeedback() {
    const flash = $('screenshot-flash');
    if (!flash) return;
    flash.classList.add('active');
    requestAnimationFrame(() => {
        requestAnimationFrame(() => { flash.classList.remove('active'); });
    });
}

function finishScreenshot(wasHidden) {
    setHudVisible(!wasHidden); // 撮影前の表示状態(HUDが元々見えていたか)へ復元
    _screenshotInProgress = false;
}

function downloadScreenshotBlob(blob) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    const pad = (n) => String(n).padStart(2, '0');
    const d = new Date();
    const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
    a.href = url;
    a.download = `ship_screenshot_${stamp}.png`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 5000);
}

function setupMobileControls() {
    const btnFaster = $('btn-faster'), btnSlower = $('btn-slower'), btnLeft = $('btn-left'), btnRight = $('btn-right');
    const addTouch = (btn, startFn, endFn) => {
        btn.addEventListener('touchstart', (e) => { e.preventDefault(); e.stopPropagation(); startFn(); }, { passive: false });
        if (endFn) btn.addEventListener('touchend', (e) => { e.stopPropagation(); endFn(); });
    };
    addTouch(btnFaster, () => changeTelegraph(1));
    addTouch(btnSlower, () => changeTelegraph(-1));
    addTouch(btnLeft, () => { touchLeft = true; }, () => { touchLeft = false; });
    addTouch(btnRight, () => { touchRight = true; }, () => { touchRight = false; });

    btnFaster.addEventListener('mousedown', () => changeTelegraph(1));
    btnSlower.addEventListener('mousedown', () => changeTelegraph(-1));
    btnLeft.addEventListener('mousedown', () => { touchLeft = true; });
    btnLeft.addEventListener('mouseup', () => { touchLeft = false; });
    btnRight.addEventListener('mousedown', () => { touchRight = true; });
    btnRight.addEventListener('mouseup', () => { touchRight = false; });

    // ── 視点固定モード用2本指パン ──
    // OrbitControlsより先にイベントを処理し、2本指のときだけ横取りする。
    let _panPrev = null; // 前フレームの2本指中心座標
    const canvas = document.querySelector('canvas');
    if (canvas) {
        canvas.addEventListener('touchstart', (e) => {
            if (e.touches.length === 2 && cameraMode === 'chase') {
                const t0 = e.touches[0], t1 = e.touches[1];
                _panPrev = { x: (t0.clientX + t1.clientX) / 2, y: (t0.clientY + t1.clientY) / 2 };
            } else {
                _panPrev = null;
            }
        }, { passive: true });

        canvas.addEventListener('touchmove', (e) => {
            if (e.touches.length === 2 && cameraMode === 'chase' && _panPrev) {
                const t0 = e.touches[0], t1 = e.touches[1];
                const cx = (t0.clientX + t1.clientX) / 2;
                const cy = (t0.clientY + t1.clientY) / 2;
                const dx = cx - _panPrev.x;
                const dy = cy - _panPrev.y;
                _panPrev = { x: cx, y: cy };

                // カメラの右方向（水平）と上方向でパン量をワールド座標に変換
                const panSpeed = controls.target.distanceTo(camera.position) * 0.001;
                const right = new THREE.Vector3();
                const up    = new THREE.Vector3();
                camera.getWorldDirection(up); // 一時変数として使う
                right.crossVectors(up, camera.up).normalize();
                up.set(0, 1, 0); // 画面上方向はワールドY固定（自然なパン）

                // chasePanOffsetを更新（実際のtarget移動はメインループで行う）
                chasePanOffset.addScaledVector(right, -dx * panSpeed);
                chasePanOffset.addScaledVector(up,    dy * panSpeed);
            } else {
                _panPrev = null;
            }
        }, { passive: true });

        canvas.addEventListener('touchend', (e) => {
            if (e.touches.length < 2) _panPrev = null;
        }, { passive: true });

        // ── 見張り台視点モード用: ドラッグで自由見回し(ヨー/ピッチ) ──
        // OrbitControlsはこのモード中enabled=falseになっているため、
        // マウス1ドラッグ/タッチ1本指ドラッグを横取りして見回しに使う。
        let _vpDragPrev = null;
        const vpLook = (dx, dy) => {
            viewpointYaw   += dx * 0.0045;  // カメラが前向き(+Z)になったので符号を反転
            viewpointPitch -= dy * 0.0045;
            viewpointPitch = Math.max(-1.45, Math.min(1.45, viewpointPitch)); // 上下 約±83°
        };

        // Bug1修正: canvas.addEventListenerではなくwindow側で拾う。
        // canvas要素のpointer-eventsやThree.js内部のイベント取得順に依存しないため堅牢。
        // Bug2修正: ギズモ操作中(currentGizmoType != null)は視点ドラッグを開始しない。
        window.addEventListener('mousedown', (e) => {
            if (cameraMode !== 'viewpoint') return;
            if (currentGizmoType) return;           // ギズモ操作中は視点ドラッグしない
            // UI要素クリック時はスキップ（設定パネル・HUDボタン等）
            if (e.target && e.target.closest && e.target.closest(
                '#settings-panel, #hud, #viewpoint-menu, button, input, select, textarea'
            )) return;
            _vpDragPrev = { x: e.clientX, y: e.clientY };
        });
        window.addEventListener('mousemove', (e) => {
            if (cameraMode !== 'viewpoint' || !_vpDragPrev) return;
            if (currentGizmoType) { _vpDragPrev = null; return; } // ギズモ開始時にリセット
            vpLook(e.clientX - _vpDragPrev.x, e.clientY - _vpDragPrev.y);
            _vpDragPrev = { x: e.clientX, y: e.clientY };
        });
        window.addEventListener('mouseup', () => { _vpDragPrev = null; });

        canvas.addEventListener('touchstart', (e) => {
            if (e.touches.length === 1 && cameraMode === 'viewpoint') {
                _vpDragPrev = { x: e.touches[0].clientX, y: e.touches[0].clientY };
            }
        }, { passive: true });
        canvas.addEventListener('touchmove', (e) => {
            if (e.touches.length === 1 && cameraMode === 'viewpoint' && _vpDragPrev) {
                const t0 = e.touches[0];
                vpLook(t0.clientX - _vpDragPrev.x, t0.clientY - _vpDragPrev.y);
                _vpDragPrev = { x: t0.clientX, y: t0.clientY };
            }
        }, { passive: true });
        canvas.addEventListener('touchend', (e) => {
            if (e.touches.length < 1) _vpDragPrev = null;
        }, { passive: true });

        // ── v137: 画面（3Dビュー）ダブルタップでHUD一括非表示 ──
        // 1本指タップ×2回、間隔300ms以内・移動量小(ドラッグやピンチと誤認しない)
        // という条件を満たした時だけトグルする。カメラ回転・視点見回しドラッグ等の
        // 既存タッチ操作とは独立して判定するため、ここではtouchstart/touchendの
        // 座標差と時間差だけを見る（既存リスナーの動作を一切変更しない）。
        let _dtapLastTime = 0;
        let _dtapLastPos = null;
        let _dtapStartPos = null;
        const DTAP_MAX_INTERVAL_MS = 300;
        const DTAP_MAX_MOVE_PX = 24;

        canvas.addEventListener('touchstart', (e) => {
            if (e.touches.length === 1) {
                _dtapStartPos = { x: e.touches[0].clientX, y: e.touches[0].clientY };
            } else {
                _dtapStartPos = null; // 2本指以上が絡んだ場合はダブルタップ判定を打ち切る
            }
        }, { passive: true });

        canvas.addEventListener('touchend', (e) => {
            // 設定パネル操作中(isDesignMode)はHUDごと消えると操作不能に見えるため対象外。
            // 見張り台視点モードの自由見回しドラッグ中も、タップ末尾で暴発しないよう
            // 移動量チェック(DTAP_MAX_MOVE_PX)で自然に弾かれる。
            if (!_dtapStartPos || e.touches.length > 0) { return; }
            const tapPos = _dtapStartPos; // このタップの代表座標(=1本指touchstart時点)
            _dtapStartPos = null;

            const isDesignModeNow = $('settings-panel') && $('settings-panel').classList.contains('open');
            if (isDesignModeNow) { _dtapLastTime = 0; _dtapLastPos = null; return; }

            const now = performance.now();
            if (_dtapLastPos) {
                const dt2 = now - _dtapLastTime;
                const dist = Math.hypot(tapPos.x - _dtapLastPos.x, tapPos.y - _dtapLastPos.y);
                if (dt2 <= DTAP_MAX_INTERVAL_MS && dist <= DTAP_MAX_MOVE_PX) {
                    hudHiddenByUser = !hudHiddenByUser;
                    setHudVisible(!hudHiddenByUser);
                    _dtapLastTime = 0; _dtapLastPos = null; // 3連続タップ等で誤って再トグルしないようリセット
                    return;
                }
            }
            _dtapLastTime = now;
            _dtapLastPos = tapPos;
        }, { passive: true });

        // PC(マウス操作)でのダブルクリックも同じ扱いにする（ブラウザでの動作確認用）
        canvas.addEventListener('dblclick', () => {
            const isDesignModeNow = $('settings-panel') && $('settings-panel').classList.contains('open');
            if (isDesignModeNow) return;
            hudHiddenByUser = !hudHiddenByUser;
            setHudVisible(!hudHiddenByUser);
        });
    }
}

