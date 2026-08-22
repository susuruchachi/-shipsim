// ===================================================================
//  Blender エリアライト → Empty変換スクリプト生成
// ===================================================================

const AREA_LIGHT_BLENDER_SCRIPT = `\
import bpy
import math

# すするCoder用 エリアライト変換スクリプト
# Blenderのエリアライトを、カスタムプロパティ付きのEmptyオブジェクトに変換します。
# 変換後に glTF 2.0 でエクスポートする際、
#   Include > Custom Properties にチェックを入れてください。

converted = 0

for obj in list(bpy.data.objects):
    if obj.type != 'LIGHT':
        continue
    light = obj.data
    if light.type != 'AREA':
        continue

    # 空オブジェクトを元のライトと同じ位置・回転で作成
    empty = bpy.data.objects.new("AreaLight_" + obj.name, None)
    empty.empty_display_type = 'PLAIN_AXES'
    empty.empty_display_size = 0.5

    # 位置・回転・スケールをコピー
    empty.location = obj.location.copy()
    empty.rotation_euler = obj.rotation_euler.copy()
    empty.scale = obj.scale.copy()

    # 同じコレクションに追加
    for col in obj.users_collection:
        col.objects.link(empty)

    # カスタムプロパティを設定（すするCoderが読み込む形式）
    empty["type"]      = "area"
    empty["width"]     = light.size        # X方向サイズ
    empty["height"]    = light.size_y if light.shape in ('RECTANGLE','ELLIPSE') else light.size
    empty["intensity"] = light.energy
    r, g, b = light.color
    empty["color"]     = "#{:02x}{:02x}{:02x}".format(
        int(r * 255), int(g * 255), int(b * 255)
    )

    converted += 1
    print(f"  変換: {obj.name} → {empty.name}")
    print(f"    size={empty['width']:.2f}x{empty['height']:.2f}  "
          f"intensity={empty['intensity']:.1f}  color={empty['color']}")

print(f"\\n完了: {converted} 個のエリアライトを変換しました。")
print("次のステップ: File > Export > glTF 2.0")
print("  ✓ Include > Custom Properties にチェックを入れてください。")
`;

function initAreaLightScript() {
    const ta = $('area-light-script');
    if (ta) ta.value = AREA_LIGHT_BLENDER_SCRIPT.trim();
}

function copyAreaLightScript(btn) {
    const script = AREA_LIGHT_BLENDER_SCRIPT.trim();
    if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(script).then(() => {
            const orig = btn.textContent;
            btn.textContent = '✅ コピー完了！';
            setTimeout(() => { btn.textContent = orig; }, 2000);
        });
    } else {
        // フォールバック
        const ta = $('area-light-script');
        if (ta) { ta.select(); document.execCommand('copy'); }
        const orig = btn.textContent;
        btn.textContent = '✅ コピー完了！';
        setTimeout(() => { btn.textContent = orig; }, 2000);
    }
}

// ===== RectAreaLight ギズモ・シンメトリー =====

function setAreaLightPos(i, axis, val) {
    const light = glbLights[i];
    if (!light || (!light.isRectAreaLight && !light.userData.isAreaLight)) return;
    light.position[axis] = val;
    // areaNode も同期（glowシェーダーの位置計算に使う）
    if (light.userData.areaNode) light.userData.areaNode.position[axis] = val;
    // シンメトリーミラーも追従
    if (light.userData.symmetry && light.userData.mirrorLight) {
        light.userData.mirrorLight.position[axis] = axis === 'x' ? -val : val;
        if (light.userData.mirrorLight.userData.areaNode) {
            light.userData.mirrorLight.userData.areaNode.position[axis] = axis === 'x' ? -val : val;
        }
    }
}
// エリアライトのサイズ変更（areaNodeのscaleを変更）
// updateHullGlowUniformsの軸定義: X=幅方向, Z=高さ方向, Y=法線
function setAreaLightSize(i, axis, val) {
    const light = glbLights[i];
    if (!light) return;
    val = Math.max(0.01, parseFloat(val) || 1);
    if (light.isRectAreaLight) {
        if (axis === 'w') light.width  = val;
        if (axis === 'h') light.height = val;
    } else if (light.userData.areaNode) {
        const node = light.userData.areaNode;
        if (axis === 'w') node.scale.x = val; // X=幅
        if (axis === 'h') node.scale.z = val; // Z=高さ（シェーダーと一致）
    }
}

// エリアライトの向き変更（areaNodeのrotationを変更）
function setAreaLightRotation(i, axis, val) {
    const light = glbLights[i];
    if (!light) return;
    const rad = THREE.MathUtils.degToRad(parseFloat(val) || 0);
    if (light.isRectAreaLight) {
        light.rotation[axis] = rad;
    } else if (light.userData.areaNode) {
        light.userData.areaNode.rotation[axis] = rad;
    }
}

function toggleAreaLightSymmetry(i, enabled) {
    const light = glbLights[i];
    if (!light || (!light.isRectAreaLight && !light.userData.isAreaLight)) return;
    light.userData.symmetry = enabled;

    if (enabled) {
        // ミラーライトがなければ生成
        if (!light.userData.mirrorLight) {
            const mirror = new THREE.RectAreaLight(
                light.color.getHex(), light.intensity, light.width, light.height
            );
            mirror.position.set(-light.position.x, light.position.y, light.position.z);
            mirror.quaternion.copy(light.quaternion);
            // X軸周りに反転（左右反転）
            mirror.scale.set(-1, 1, 1);
            mirror.userData.isMirrorLight = true;
            mirror.userData.mirrorOf = i;
            // 元のライトと同じ親に追加
            const parent = light.parent || (importedModelGroup || shipGroup);
            parent.add(mirror);
            // ミラーライトにも面発光ヘルパーを追加（設定中のみ表示）
            if (THREE.RectAreaLightHelper) {
                const mirrorHelper = new THREE.RectAreaLightHelper(mirror);
                mirrorHelper.visible = $('settings-panel') && $('settings-panel').classList.contains('open');
                mirror.add(mirrorHelper);
                mirror.userData.helper = mirrorHelper;
            }
            light.userData.mirrorLight = mirror;
            glbLights.push(mirror); // UIには表示しない（mirrorOfで判定）
        }
        light.userData.mirrorLight.visible = light.visible;
    } else {
        // ミラーライトを削除
        if (light.userData.mirrorLight) {
            const ml = light.userData.mirrorLight;
            if (ml.parent) ml.parent.remove(ml);
            const idx = glbLights.indexOf(ml);
            if (idx !== -1) glbLights.splice(idx, 1);
            light.userData.mirrorLight = null;
        }
    }
}

