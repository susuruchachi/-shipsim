const NAV_COLORS = {
    port:  new THREE.Color(1.0, 0.1, 0.1),
    stbd:  new THREE.Color(0.1, 1.0, 0.3),
    mast:  new THREE.Color(1.0, 1.0, 1.0),
    stern: new THREE.Color(1.0, 1.0, 0.6)
};

// COLREGS-style visibility arcs (in degrees)
const NAV_LIGHT_REGS = {
    sideArcDefault: 112.5,   // each sidelight: dead ahead to 22.5 deg aft of the beam
    sideArcMax: 112.5,
    sideArcMin: 90,
    mastHalfArc: 90,         // capped by SpotLight engine limit (true reg ~112.5)
    sternHalfArc: 67.5       // true reg: 135 deg total, centered dead astern
};

// Direction (unit vector, XZ-plane) for a sidelight's visibility cone bisector.
// Bow = +Z. signX = +1 for the light mounted on the +X side, -1 for -X side.
function sideLightDir(signX, halfArcRad) {
    return new THREE.Vector3(Math.sin(halfArcRad) * signX, 0, Math.cos(halfArcRad));
}

function makeNavLightObj(color, intensity, angle, sphereRadius) {
    const g = new THREE.Group();
    const sphereMat = new THREE.MeshBasicMaterial({ color });
    const r = Math.max(0.001, (sphereRadius != null && Number.isFinite(sphereRadius)) ? sphereRadius : 0.15);
    const sphere = new THREE.Mesh(new THREE.SphereGeometry(r, 8, 8), sphereMat);
    // グロー球（やや大きめのソフトな発光用）
    const glowMat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.35 });
    const glow = new THREE.Mesh(new THREE.SphereGeometry(r * 3.5, 8, 8), glowMat);
    g.add(glow);
    g.add(sphere);
    // SpotLightのみ使用（GPU上限対策: PointLight廃止で全灯ON可能）
    const navDist = window.navLightDistance != null ? window.navLightDistance : 60;
    const spot = new THREE.SpotLight(color, intensity, navDist, THREE.MathUtils.degToRad(angle), 0.4, 1.5);
    spot.position.set(0, 0, 0);
    g.add(spot);
    g.add(spot.target);
    g.userData.spot = spot;
    g.userData.glow = glow;
    g.userData.sphere = sphere;
    return g;
}

function updateNavLights3D() {
    if (currentGizmoType && currentGizmoType.startsWith('nav_')) return;

    const syncPair = (rangId, numId) => {
        const r = $(rangId), n = $(numId);
        if (r && n) { n.addEventListener('input', () => r.value = n.value); r.addEventListener('input', () => n.value = r.value); }
    };
    syncPair('navlight-side-intensity', 'navlight-side-intensity-num');
    syncPair('navlight-side-angle', 'navlight-side-angle-num');
    syncPair('navlight-mast-intensity', 'navlight-mast-intensity-num');
    syncPair('navlight-sphere-radius', 'navlight-sphere-radius-num');

    Object.values(navLightMeshes).forEach(m => { if (m && m.parent) m.parent.remove(m); });
    navLightMeshes = {};
    if (!shipGroup) return;

    const sideX  = spVal('navlight-side-x');
    const sideY  = spVal('navlight-side-y');
    const sideZ  = spVal('navlight-side-z');
    const sideI  = spVal('navlight-side-intensity') || 1.5;
    let sideArc  = spVal('navlight-side-angle');
    if (!Number.isFinite(sideArc) || sideArc <= 0) sideArc = NAV_LIGHT_REGS.sideArcDefault;
    sideArc = THREE.MathUtils.clamp(sideArc, NAV_LIGHT_REGS.sideArcMin, NAV_LIGHT_REGS.sideArcMax);
    const sideHalfArcDeg = sideArc / 2;
    const sideHalfArcRad = THREE.MathUtils.degToRad(sideHalfArcDeg);
    const mastI  = spVal('navlight-mast-intensity') || 2.0;
    const sphereR = Math.max(0.001, spVal('navlight-sphere-radius'));

    // Port (red) is mounted on the +X side, Starboard (green) on the -X side,
    // matching this model's bow-forward (+Z) orientation.
    const port = makeNavLightObj(NAV_COLORS.port, sideI, sideHalfArcDeg, sphereR);
    port.position.set(sideX, sideY, sideZ);
    {
        const dir = sideLightDir(1, sideHalfArcRad);
        port.userData.spot.target.position.set(sideX + dir.x * 3, sideY, sideZ + dir.z * 3);
    }
    shipGroup.add(port); navLightMeshes.port = port;

    const stbd = makeNavLightObj(NAV_COLORS.stbd, sideI, sideHalfArcDeg, sphereR);
    stbd.position.set(-sideX, sideY, sideZ);
    {
        const dir = sideLightDir(-1, sideHalfArcRad);
        stbd.userData.spot.target.position.set(-sideX + dir.x * 3, sideY, sideZ + dir.z * 3);
    }
    shipGroup.add(stbd); navLightMeshes.stbd = stbd;

    const fore = makeNavLightObj(NAV_COLORS.mast, mastI, NAV_LIGHT_REGS.mastHalfArc, sphereR);
    fore.position.set(spVal('mast-fore-x'), spVal('mast-fore-y'), spVal('mast-fore-z'));
    fore.userData.spot.target.position.set(spVal('mast-fore-x'), spVal('mast-fore-y') - 3, spVal('mast-fore-z') + 10);
    shipGroup.add(fore); navLightMeshes.mastFore = fore;

    const aft = makeNavLightObj(NAV_COLORS.mast, mastI * 0.7, NAV_LIGHT_REGS.mastHalfArc, sphereR);
    aft.position.set(spVal('mast-aft-x'), spVal('mast-aft-y'), spVal('mast-aft-z'));
    aft.userData.spot.target.position.set(spVal('mast-aft-x'), spVal('mast-aft-y') - 3, spVal('mast-aft-z') + 10);
    shipGroup.add(aft); navLightMeshes.mastAft = aft;

    const stern = makeNavLightObj(NAV_COLORS.stern, 1.0, NAV_LIGHT_REGS.sternHalfArc, sphereR);
    stern.position.set(spVal('sternlight-x'), spVal('sternlight-y'), spVal('sternlight-z'));
    stern.userData.spot.target.position.set(spVal('sternlight-x'), spVal('sternlight-y') - 1, spVal('sternlight-z') - 5);
    shipGroup.add(stern); navLightMeshes.stern = stern;
}

function updateNavLightsVisibility() {
    const isNight = physics.dayProgress > 0.78 || physics.dayProgress < 0.22;
    Object.values(navLightMeshes).forEach(lg => {
        if (!lg) return;
        lg.visible = navLightsEnabled;
        if (lg.userData.spot) lg.userData.spot.visible = navLightsEnabled && isNight;
        if (lg.userData.sphere) {
            lg.userData.sphere.visible = true;
            lg.userData.sphere.material.opacity = isNight ? 1.0 : 0.25;
            lg.userData.sphere.material.transparent = !isNight;
        }
        if (lg.userData.glow) {
            lg.userData.glow.visible = navLightsEnabled && isNight;
        }
    });
}

function addFunnel() {
    funnels.push({ x: 0, y: 3.5, z: 0.5, rx: 0.4, ry: 1.2 });
    renderFunnelList();
    buildFunnelMeshes();
}
function removeFunnel(i) {
    disableGizmo();
    funnels.splice(i, 1);
    renderFunnelList();
    buildFunnelMeshes();
}
function copyFunnel(i) {
    const src = funnels[i];
    funnels.push({ x: src.x, y: src.y, z: src.z, rx: src.rx, ry: src.ry });
    renderFunnelList();
    buildFunnelMeshes();
}

function renderFunnelList() {
    const list = $('funnel-list'); if (!list) return;
    const sym = $('funnel-symmetry') && $('funnel-symmetry').checked;
    list.innerHTML = '';
    funnels.forEach((f, i) => {
        const card = document.createElement('div');
        card.className = 'sp-item-card';
        card.innerHTML = `
            <div class="sp-item-header">
                <span class="sp-item-title">
                    <span class="smoke-preview" style="animation-delay:${i*0.4}s"></span>煙突 #${i+1}${sym && f.x !== 0 ? ' (対称)' : ''}
                    <button class="sp-gizmo-btn" id="gizmo-funnel-${i}" onclick="toggleGizmo('funnel', ${i})">📍 ギズモ</button>
                    <button class="sp-gizmo-btn" id="gizmo-funnel-uplight-${i}_L" onclick="toggleGizmo('funnel_uplight','${i}_L','rotate')">💡L 角度</button>
                    <button class="sp-gizmo-btn" id="gizmo-funnel-uplight-${i}_R" onclick="toggleGizmo('funnel_uplight','${i}_R','rotate')">💡R 角度</button>
                    <button class="sp-gizmo-btn" onclick="copyFunnel(${i})">⧉ コピー</button>
                </span>
                <button class="sp-remove-btn" onclick="removeFunnel(${i})">✕</button>
            </div>
            <div class="sp-xyz-row">
                <span class="sp-axis-label">X:</span>
                <input type="number" id="funnel-x-${i}" class="sp-xyz-input" value="${f.x}" step="0.1"
                    oninput="funnels[${i}].x=parseFloat(this.value)||0;buildFunnelMeshes();">
                <span class="sp-axis-label">Y:</span>
                <input type="number" id="funnel-y-${i}" class="sp-xyz-input" value="${f.y}" step="0.1"
                    oninput="funnels[${i}].y=parseFloat(this.value)||0;buildFunnelMeshes();">
                <span class="sp-axis-label">Z:</span>
                <input type="number" id="funnel-z-${i}" class="sp-xyz-input" value="${f.z}" step="0.1"
                    oninput="funnels[${i}].z=parseFloat(this.value)||0;buildFunnelMeshes();">
            </div>
            <div class="sp-row" style="gap:8px;flex-wrap:wrap;">
                <span class="sp-label" style="min-width:0;">下径:</span>
                <input type="number" class="sp-num-input" value="${f.rx}" step="0.05" min="0.1" max="3"
                    oninput="funnels[${i}].rx=parseFloat(this.value)||0.4;buildFunnelMeshes();">
                <span class="sp-label" style="min-width:0;">高さ:</span>
                <input type="number" class="sp-num-input" value="${f.ry}" step="0.1" min="0.2" max="6"
                    oninput="funnels[${i}].ry=parseFloat(this.value)||1.2;buildFunnelMeshes();">
            </div>`;
        list.appendChild(card);
    });
    addFineTuneButtons(list);
}

let funnelMeshes3D = [];

function buildFunnelMeshes() {
    let oldType = currentGizmoType;
    let oldIndex = currentGizmoIndex;

    funnelMeshes3D.forEach(m => { if (m.parent) m.parent.remove(m); });
    funnelMeshes3D = [];
    if (!shipGroup) return;

    const sym = $('funnel-symmetry') && $('funnel-symmetry').checked;
    const funnelMat = new THREE.MeshStandardMaterial({ color: 0x222222, roughness: 0.7 });
    const bandMat   = new THREE.MeshStandardMaterial({ color: 0xcc2222, roughness: 0.5 });

    function spawnFunnel(x, y, z, rx, ry, funnelIndex, isMirror) {
        const g = new THREE.Group();
        const body = new THREE.Mesh(new THREE.CylinderGeometry(rx * 0.85, rx, ry, 16), funnelMat);
        body.position.y = ry / 2;
        g.add(body);
        const band = new THREE.Mesh(new THREE.CylinderGeometry(rx * 0.88, rx * 0.88, 0.12, 16), bandMat);
        band.position.y = ry * 0.75;
        g.add(band);
        const cap = new THREE.Mesh(new THREE.TorusGeometry(rx * 0.87, 0.04, 6, 16), funnelMat);
        cap.rotation.x = Math.PI / 2;
        cap.position.y = ry;
        g.add(cap);
        g.position.set(x, y, z);
        g.userData.funnelIndex = funnelIndex;
        g.userData.isMirror = !!isMirror;
        shipGroup.add(g);
        funnelMeshes3D.push(g);
    }

    funnels.forEach((f, i) => {
        spawnFunnel(f.x, f.y, f.z, f.rx, f.ry, i, false);
        if (sym && Math.abs(f.x) > 0.05) spawnFunnel(-f.x, f.y, f.z, f.rx, f.ry, i, true);
    });

    // 煙突アップライト（両脇）も再生成（buildFunnelMeshes と連動）
    clearFunnelUplights();
    funnels.forEach((f, i) => {
        createFunnelUplight(f.x, f.y, f.z, f.rx, f.ry, i, false);
        if (sym && Math.abs(f.x) > 0.05) {
            createFunnelUplight(-f.x, f.y, f.z, f.rx, f.ry, i, true);
        }
    });

    if (oldType === 'funnel') {
        const target = funnelMeshes3D.find(m => m.userData.funnelIndex === oldIndex && !m.userData.isMirror);
        if (target) {
            transformControl.attach(target);
            currentGizmoTarget = target;
        } else {
            disableGizmo();
        }
    } else if (oldType === 'funnel_uplight') {
        const entry = funnelUplights.find(u => u.funnelIndex === parseInt(String(oldIndex).split('_')[0]) && !u.isMirror);
        const side = String(oldIndex).split('_')[1];
        const target = entry ? (side === 'L' ? entry.markerL : entry.markerR) : null;
        if (target) {
            transformControl.setMode('rotate');
            transformControl.attach(target);
            currentGizmoTarget = target;
        } else {
            disableGizmo();
        }
    }
    syncSettingsVisibility();
}

