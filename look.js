// Realtime look for the tour: materials restyled by colour rule (viewer/look.json, ported from tools/blender_interior.py),
// texture tiles box-projected in world space (the model's generated meshes have no usable UVs), image-based light from a
// room environment, a few unshadowed point lights for the ceiling panels' falloff, and AgX tone mapping (as the renders).
import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';

const ELEMENT = /^(slab_|wall_|ceiling_|imesh_|item_|stair_|window_|door_|fence_|roof|rseg_|site_)/;
const rgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
const close = (a, b, tol) => { const p = rgb(a), q = rgb(b); return p.every((v, i) => Math.abs(v - q[i]) <= tol); };

export async function loadLook(url) {
  try { const r = await fetch(url); return r.ok ? await r.json() : null; } catch { return null; }
}

export function setupLighting(renderer, scene, cfg, { hemi, ambient, sun }) {
  const R = cfg.renderer;
  renderer.toneMapping = THREE[`${R.toneMapping}ToneMapping`] ?? THREE.AgXToneMapping;
  renderer.toneMappingExposure = R.exposure;
  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture; pmrem.dispose();
  scene.environmentIntensity = R.environmentIntensity;
  hemi.intensity = R.hemisphere; ambient.intensity = R.ambient; sun.intensity = R.sun;
  const L = cfg.lights;
  for (const [x, y, z, cd] of L.points) { const l = new THREE.PointLight(L.colour, cd, L.distance, L.decay); l.position.set(x, y, z); scene.add(l); }
}

// World-space (or, for moving door leaves, object-space) box projection of a tile onto any mesh.
function boxProject(mat, tex, size, objectSpace) {
  mat.onBeforeCompile = (sh) => {
    sh.uniforms.triMap = { value: tex }; sh.uniforms.triScale = { value: 1 / size };
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vTriP;\nvarying vec3 vTriN;')
      .replace('#include <begin_vertex>', `#include <begin_vertex>\n${objectSpace
        ? 'vTriP = position; vTriN = normal;'
        : 'vTriP = (modelMatrix * vec4(position, 1.0)).xyz; vTriN = mat3(modelMatrix) * normal;'}`);
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform sampler2D triMap;\nuniform float triScale;\nvarying vec3 vTriP;\nvarying vec3 vTriN;')
      .replace('#include <map_fragment>', `
        vec3 tw = pow(abs(normalize(vTriN) + 1e-5), vec3(6.0)); tw /= (tw.x + tw.y + tw.z);
        vec3 tp = vTriP * triScale;
        diffuseColor *= texture2D(triMap, tp.zy) * tw.x + texture2D(triMap, tp.xz) * tw.y + texture2D(triMap, tp.xy) * tw.z;`);
  };
  mat.customProgramCacheKey = () => `tri-${objectSpace ? 'obj' : 'world'}`;
}

// Post-processing: N8AO ambient occlusion (renders the scene itself), bloom, then OutputPass (AgX + sRGB).
export async function setupPost(renderer, scene, camera, cfg) {
  const P = cfg.post; if (!P) return null;
  const [{ EffectComposer }, { OutputPass }, { UnrealBloomPass }, { N8AOPass }] = await Promise.all([
    import('three/addons/postprocessing/EffectComposer.js'), import('three/addons/postprocessing/OutputPass.js'),
    import('three/addons/postprocessing/UnrealBloomPass.js'), import('n8ao')]);
  const size = renderer.getSize(new THREE.Vector2()), composer = new EffectComposer(renderer);
  const ao = new N8AOPass(scene, camera, size.x, size.y); ao.setQualityMode(P.aoQuality ?? 'Medium'); Object.assign(ao.configuration, P.ao);
  composer.addPass(ao);
  if (P.bloom) composer.addPass(new UnrealBloomPass(new THREE.Vector2(size.x, size.y), P.bloom.strength, P.bloom.radius, P.bloom.threshold));
  composer.addPass(new OutputPass());
  return composer;
}

export function applyLook(root, cfg, renderer, texBase = 'tex/') {
  const loader = new THREE.TextureLoader(), tiles = new Map(), made = new Map(), aniso = renderer.capabilities.getMaxAnisotropy();
  const tile = (name) => {
    if (!tiles.has(name)) { const t = loader.load(`${texBase}${name}.jpg`); t.wrapS = t.wrapT = THREE.RepeatWrapping; t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = aniso; tiles.set(name, t); }
    return tiles.get(name);
  };
  const ruleFor = (hex, el) => cfg.rules.find((r) => (!r.only || (el && new RegExp(r.only).test(el))) && r.colours.some((c) => close(hex, c, r.tolerance ?? cfg.tolerance)));
  const carpetKind = (img) => {        // the model's saff tiles are 480 x 280: red (hall) or navy (upstairs)
    if (!img || img.width !== 480 || img.height !== 280) return null;
    const c = document.createElement('canvas'); c.width = 48; c.height = 28; const g = c.getContext('2d'); g.drawImage(img, 0, 0, 48, 28);
    const d = g.getImageData(0, 0, 48, 28).data; let r = 0, b = 0; for (let i = 0; i < d.length; i += 4) { r += d[i]; b += d[i + 2]; }
    return r > b ? 'red' : 'navy';
  };
  const restyle = (m, el, objectSpace) => {
    if (!m || m.type !== 'MeshStandardMaterial') return m;          // baked (unlit) and special materials are left alone
    const key = `${m.uuid}|${el}|${objectSpace}`; if (made.has(key)) return made.get(key);
    let out = m;
    const kind = m.map && carpetKind(m.map.image);
    if (kind) {
      const t = loader.load(`${texBase}${cfg.carpets[kind]}.jpg`);          // own instance: keeps this material's UV transform
      t.wrapS = t.wrapT = THREE.RepeatWrapping; t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = aniso;
      for (const k of ['repeat', 'offset', 'center']) t[k].copy(m.map[k]); t.rotation = m.map.rotation; t.channel = m.map.channel;
      out = m.clone(); out.map = t; out.color.setScalar(cfg.carpets.value); out.roughness = 1; out.envMapIntensity = 0.25;
    } else if (!m.map) {
      const hex = '#' + m.color.getHexString(), r = ruleFor(hex, el);
      if (r) {
        const base = { side: THREE.DoubleSide, roughness: r.roughness ?? m.roughness, metalness: r.metalness ?? 0, envMapIntensity: r.envMapIntensity ?? 0.6 };
        if (r.glass) out = new THREE.MeshStandardMaterial({ ...base, color: '#dfeef5', transparent: true, opacity: 0.18, roughness: 0.05, depthWrite: false, envMapIntensity: 1 });
        else if (r.emissive) out = new THREE.MeshStandardMaterial({ ...base, color: hex, emissive: r.emissive, emissiveIntensity: r.intensity, roughness: 0.4 });
        else {
          out = new THREE.MeshStandardMaterial({ ...base, color: r.tinted ? '#ffffff' : (r.colour ?? hex) });
          if (r.tile) boxProject(out, tile(r.tile), r.size ?? 1, objectSpace);
        }
        out.name = m.name;
      }
    }
    made.set(key, out); return out;
  };
  root.traverse((o) => {
    if (!o.isMesh || !o.material) return;
    let el = null, objectSpace = false;
    for (let p = o; p; p = p.parent) { if (!el && ELEMENT.test(p.name || '')) el = p.name; if (p.userData?.dynamicLook) objectSpace = true; }
    o.material = Array.isArray(o.material) ? o.material.map((m) => restyle(m, el, objectSpace)) : restyle(o.material, el, objectSpace);
  });
}
