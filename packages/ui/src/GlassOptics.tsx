import { useEffect, useId, useRef } from "react";
import { appearanceCommitEvent } from "./theme";
import { atmosphereIntensity, atmosphereTarget, blendAtmosphere, paintAtmosphere, ribbonGeometry } from "./atmosphere";

/** The owner-approved aerift-glass-lab/v1 recipe. These values are live inputs, not a visual reference. */
export const aeRiftGlassRecipe = Object.freeze({
  opacity: 11, warmth: 0, softness: 5, exposure: 100, depth: 10, radius: 26,
  roundness: 81, distortion: 40, dispersion: 61, magnify: 73, shadow: 83,
  reflection: 51, gloss: 100, patches: 56, patchSize: 100, iridescence: 47,
  edging: 71, edge: 26, light: 315, sweep: 70, drift: 72, speed: 76,
  scroll: 44, scene: "ribbons", surface: "all", showLens: true,
});

const orbitGlass = ".ae-orbit[data-radial='true'] .ae-orbit-trigger [data-ae-lens-role='orb']";
const openOrbitGlass = ".ae-orbit[data-radial='true'][data-open='true'] .ae-orbit-choice [data-ae-lens-role='orb']";
const lensSelector = [
  orbitGlass, openOrbitGlass,
  ".ae-nav-brand", ".ae-nav-destinations", ".ae-nav-tools",
  ".ae-spatial-local .ae-spatial-glyph",
  ".ae-spatial-peer[data-selected='true'] .ae-spatial-glyph",
  ".ae-workspace-nav", ".ae-panel", ".ae-file-slot",
  ".ae-surface:is([data-material='content'], [data-material='raised'])",
  ".ae-button:is([data-variant='secondary'], [data-variant='primary']):not(:disabled, [aria-disabled='true'])",
  "[data-ae-lens-role='control']:not(:disabled, [aria-disabled='true'])",
].join(",");

const R = aeRiftGlassRecipe;
type MaterialKey = Exclude<keyof typeof R, "drift" | "scroll" | "scene" | "surface" | "showLens">;
export type GlassAppearanceRecipe = Record<MaterialKey, number>;
export const glassAppearanceRecipes: Readonly<Record<"dark" | "light", GlassAppearanceRecipe>> = Object.freeze({
  dark: R, light: R,
});

const clamp = (n: number, lo = 0, hi = 1) => Math.min(hi, Math.max(lo, n));
const TAU = 2 * Math.PI;
type Surface = { x: number; y: number; width: number; height: number; radius: number; kind: "control" | "panel" | "stage" };

export function opticalViewportScale(width: number, height: number, dpr: number) {
  return Math.min(Math.max(1, dpr), 800 / width, Math.sqrt(390000 / (width * height)));
}

/** Port of the Lab's shade equations. The only sampling differences are live app
 * artwork instead of its diagnostic scene, and screen-pixel clipping and scale. */
export function shadeLens(out: Uint8ClampedArray, source: Uint8ClampedArray, w: number, h: number, box: Surface, resolution: number, t: number,
  s: GlassAppearanceRecipe = R) {
  const { x, y, width, height, radius, kind } = box;
  const scrX = Math.max(0, Math.floor(x)), scrY = Math.max(0, Math.floor(y));
  const endX = Math.min(w, Math.ceil(x + width)), endY = Math.min(h, Math.ceil(y + height));
  const halfW = width / 2, halfH = height / 2, centerX = x + halfW, centerY = y + halfH;
  const orb = kind === "stage", card = kind === "panel", density = 1 / resolution;
  const r = Math.max(0, Math.min(radius + (kind === "control" ? (s.radius - 26) * .43 * resolution : 0), halfW, halfH));
  const tint = s.opacity * .01 * (orb ? .46 : 1);
  const dep = Math.max(1, s.depth * (orb ? 1.32 : card ? 1 : .65));
  const bend = s.distortion * resolution * (orb ? 1.42 : card ? 1 : .70);
  const eref = s.reflection * .01, prism = s.dispersion * .01, film = s.iridescence * .01, warm = s.warmth * .01;
  const glow = s.patches * .01, size = s.patchSize * .01;
  const gloss = s.gloss * .01, sweep = s.sweep * .01, roll = s.roundness * .01, edging = s.edging * .01;
  const hw = .59 + (1 - gloss) * 2.1 + .034 * s.depth, nxWidth = 1.10 + .08 * s.depth + .68 * (1 - gloss);
  const blurRadius = s.softness ? Math.max(1, Math.round(Math.ceil(s.softness * .70) * resolution)) : 0;
  const blurMix = Math.min(.52, s.softness * .037);
  const heading = s.light * Math.PI / 180 + Math.sin(t * .98) * .43 * sweep;
  const lx = Math.cos(heading), ly = Math.sin(heading);
  const u1 = lx * .67 + Math.sin(t * .80 + x * density * .025) * .37 * sweep;
  const v1 = ly * .69 + Math.cos(t * .97 + y * density * .025) * .40 * sweep;
  const u2 = -lx * .49 + Math.cos(t * .67 - y * density * .04) * .49 * sweep;
  const v2 = -ly * .66 + Math.sin(t * .71 + x * density * .03) * .41 * sweep;
  const det = orb ? 1.8 : 1;
  const cu = 1 - 1.07 * r / width, cv = 1 - 1.05 * r / height;
  const cw = .041 + 1.94 * r / width + size * .103, ch = .080 + 1.67 * r / height + size * .081;
  const wander = .045 * Math.sin(t * .96) * sweep;
  const pw = .062 + size * .31, ph = .18 + size * .67;
  const amp = .34 + s.depth * .030;
  const zoom = (s.magnify * .01) * (orb ? .94 : .045);
  const outerPower = 1.13 + roll * 1.4;
  const darkScale = .43 * s.edge * .01;
  const interiorStart = Math.max(dep + 5, 4.6);
  const interiorWhite = clamp(tint);
  const interiorWarmR = warm * 9, interiorWarmG = warm * 2, interiorWarmB = warm * 12;
  for (let py = scrY; py < endY; py++) {
    const iy = py + .5 - centerY, ay = Math.abs(iy) - halfH + r, dy = Math.max(0, ay), v = iy / halfH;
    const signY = Math.sign(iy), vv = v * v;
    for (let px = scrX; px < endX; px++) {
      const ix = px + .5 - centerX, ax = Math.abs(ix) - halfW + r, dx = Math.max(0, ax);
      const hyp = dx || dy ? Math.sqrt(dx * dx + dy * dy) : 0;
      const d = (r - hyp - Math.min(Math.max(ax, ay), 0)) * density;
      if (d <= -.5) continue;
      const j = (py * w + px) * 4, u = ix / halfW;
      // On a flat interior the normal cannot affect the sample or lighting:
      // refraction, rim/edge shading, and the reflective falloff are all zero.
      // Stage/orb reflections can span their interior and stay on the full path.
      const staticInterior = !orb && d >= interiorStart;
      const nx = staticInterior ? 0 : hyp ? Math.sign(ix) * dx / hyp : ax > ay ? Math.sign(ix) : 0;
      const ny = staticInterior ? 0 : hyp ? signY * dy / hyp : ax <= ay ? signY : 0;
      const outer = staticInterior ? 0 : clamp(1 - d / dep), rim = outer * outer;
      const facing = nx * lx + ny * ly, keyside = Math.max(0, facing), backside = Math.max(0, -facing);
      const warp = outer > 0 ? bend * Math.pow(outer, outerPower) : 0;
      const mag = zoom * Math.max(0, 1 - u * u - vv);
      const X = clamp(px + nx * warp - ix * mag, 0, w - 1.001);
      const Y = clamp(py + ny * warp - iy * mag, 0, h - 1.001);
      const p0 = X | 0, p1 = Y | 0, fx = X - p0, fy = Y - p1;
      const i = (p1 * w + p0) * 4, ri = i + w * 4;
      const w00 = (1 - fx) * (1 - fy), w01 = fx * (1 - fy), w10 = (1 - fx) * fy, w11 = fx * fy;
      let R = source[i] * w00 + source[i + 4] * w01 + source[ri] * w10 + source[ri + 4] * w11;
      let G = source[i + 1] * w00 + source[i + 5] * w01 + source[ri + 1] * w10 + source[ri + 5] * w11;
      let B = source[i + 2] * w00 + source[i + 6] * w01 + source[ri + 2] * w10 + source[ri + 6] * w11;
      if (prism > 0 && rim > .035) {
        const spread = 4.25 * prism * rim * resolution, dx = nx * spread, dy = ny * spread;
        const a1 = (Math.round(clamp(Y + dy, 0, h - 1)) * w + Math.round(clamp(X + dx, 0, w - 1))) * 4;
        const b1 = (Math.round(clamp(Y - dy, 0, h - 1)) * w + Math.round(clamp(X - dx, 0, w - 1))) * 4;
        const pr = prism * .48 * rim;
        R += (source[a1] - R) * pr; B += (source[b1 + 2] - B) * pr;
      }
      if (blurRadius) {
        const up = (Math.max(0, p1 - blurRadius) * w + p0) * 4;
        const down = (Math.min(h - 1, p1 + blurRadius) * w + p0) * 4;
        const left = (p1 * w + Math.max(0, p0 - blurRadius)) * 4, right = (p1 * w + Math.min(w - 1, p0 + blurRadius)) * 4;
        R += ((source[up] + source[down] + source[left] + source[right]) * .25 - R) * blurMix;
        G += ((source[up + 1] + source[down + 1] + source[left + 1] + source[right + 1]) * .25 - G) * blurMix;
        B += ((source[up + 2] + source[down + 2] + source[left + 2] + source[right + 2]) * .25 - B) * blurMix;
      }
        if (staticInterior) {
          out[j] += R + (249 - R) * interiorWhite + interiorWarmR - out[j];
          out[j+1] += G + (253 - G) * interiorWhite + interiorWarmG - out[j+1];
          out[j+2] += B + (255 - B) * interiorWhite - interiorWarmB - out[j+2];
          continue;
        }
        let white=tint,red=0,blue=0,dark=darkScale*backside*rim;
        if(d<4.6&&edging>0){
          // Facing side only, with a smooth taper inward. The same directional
          // normal responds to light heading; it is not a white painted stroke.
          const q=clamp(1-d/(1.7+1.8*roll));white+=.53*edging*keyside**3.0*q*q;
        }
        if(eref>0&&(d<dep+5||orb)){
          const narrow=Math.exp(-Math.pow((d-.65)/hw,2));
          const neck=Math.exp(-Math.pow((d-1.25-.7*roll)/nxWidth,2));
          const b1=Math.pow((u-u1)/(pw*(1.30-.50*gloss)),2)+Math.pow((v-v1)/ph,2);
          const b2=Math.pow((u-u2)/(pw*.67),2)+Math.pow((v-v2)/(ph*.75),2);
          const spot=Math.exp(-b1)*(.22+.78*keyside*keyside);
          const spark=Math.exp(-b2)*(.23+.77*backside);
          let front=spot,back=spark;
          if(!orb&&Math.abs(u)>.60&&Math.abs(v)>.62){
            const aSign=lx>=0?1:-1,bSign=ly>=0?1:-1;
            const c1=Math.pow((u-aSign*(cu+wander))/cw,2)+Math.pow((v-bSign*cv)/ch,2);
            const c2=Math.pow((u+aSign*(cu-wander))/(cw*.84),2)+Math.pow((v+bSign*cv)/(ch*.94),2);
            const curved=.45+.55*Math.abs(nx*ny)*2;
            // Gaussian core for a sharp glint and longer, soft skirt. Both
            // remain wrapped around the continuous rounded-corner normal.
            front+=1.54*(.72*Math.exp(-c1)+.28*Math.exp(-c1*.39))*curved*(.40+.60*keyside);
            back+=.98*(.69*Math.exp(-c2)+.31*Math.exp(-c2*.44))*curved*(.37+.63*backside);
          }
          const hot=neck*(front*(orb?.97:1.12)+back*(orb?.70:.72))*glow*amp;
          const tip=narrow*(.07+.24*keyside*keyside*keyside)*(.45+.55*amp);
          white+=eref*(tip+hot);
          dark=darkScale*backside*rim*(1-clamp(hot));
          red=film*eref*glow*neck*(back*.77-front*.19)*.32;
          blue=film*eref*glow*neck*(front*.97-back*.16)*.44;
          if(orb&&glow>0){
            const uu=u*lx+v*ly+0.04,vv=v*lx-u*ly+.09;
            const radial=Math.hypot(uu/.73,vv/.69),theta=Math.atan2(vv/.69,uu/.73);
            const phase=theta<0?theta+TAU:theta;
            const da=Math.abs(phase-.19);
            const delta=Math.min(da,TAU-da);
            if(delta<1.65){
              const arc=Math.exp(-Math.pow((radial-.77)/(.033+size*.009),2)-Math.pow(delta/(.48+size*.66),4));
              const sheen=.32*Math.exp(-Math.pow((radial-.80)/.083,2)-Math.pow(delta/.76,2));
              white+=eref*glow*(arc*det+sheen);blue+=film*arc*.22;
            }
            const dz=Math.pow((uu-.50)/.075,2)+Math.pow((vv+.34)/.067,2);
            white+=1.31*eref*glow*Math.exp(-dz);
          }
        }
        white=clamp(white);
        const alpha = clamp(d + .5);
        out[j] += ((R + (249 - R) * white) * (1 - dark) + 255 * red + warm * (9 + 20 * rim) - out[j]) * alpha;
        out[j+1] += ((G + (253 - G) * white) * (1 - dark) + 48 * (blue + red) + warm * (2 + 5 * rim) - out[j+1]) * alpha;
        out[j+2] += ((B + (255 - B) * white) * (1 - dark) + 255 * blue - warm * (12 + 22 * rim) - out[j+2]) * alpha;
    }
  }
}

function AtmosphereFallback() {
  const id = useId();
  const artwork = ribbonGeometry();
  return <svg className="ae-glass-fallback" aria-hidden="true" viewBox="0 0 1000 640" preserveAspectRatio="none">
    <defs>
      <linearGradient id={`${id}-sheer`} x1="0" x2="35%" y1="0" y2="100%">
        <stop stopColor="var(--ae-static-violet)" stopOpacity=".45" />
        <stop offset="55%" stopColor="var(--ae-static-silk)" stopOpacity=".15" />
        <stop offset="100%" stopColor="var(--ae-static-silk)" stopOpacity=".52" />
      </linearGradient>
      <linearGradient id={`${id}-silk`} x1="0" x2="100%" y1="0" y2="100%">
        <stop stopColor="var(--ae-static-violet)" stopOpacity=".5" />
        <stop offset="50%" stopColor="var(--ae-static-silk)" stopOpacity=".14" />
        <stop offset="100%" stopColor="var(--ae-static-violet)" stopOpacity=".74" />
      </linearGradient>
      <linearGradient id={`${id}-light`}>
        <stop stopColor="var(--ae-static-lip)" stopOpacity="0" />
        <stop offset="57%" stopColor="var(--ae-static-lip)" stopOpacity=".12" />
        <stop offset="86%" stopColor="var(--ae-static-lip)" stopOpacity=".92" />
        <stop offset="100%" stopColor="var(--ae-static-lip)" stopOpacity=".16" />
      </linearGradient>
    </defs>
    <path d={artwork.rear} fill={`url(#${id}-sheer)`} />
    <path d={artwork.lower} fill={`url(#${id}-sheer)`} />
    <path d={artwork.returning} fill={`url(#${id}-silk)`} />
    <path d={artwork.front} fill={`url(#${id}-silk)`} />
    <path d={artwork.cyan} fill="none" stroke={`url(#${id}-light)`} strokeWidth="2.4" />
  </svg>;
}

/**
 * One visible, decorative canvas. Samples only the app-owned optical field.
 * Normal DOM and native dialogs remain the interactive/content/accessibility layer.
 */
export function GlassOptics({ appearanceRecipe }: { appearanceRecipe?: Partial<GlassAppearanceRecipe> } = {}) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = ref.current;
    const shell = canvas?.parentElement;
    const theme = shell?.closest<HTMLElement>(".ae-theme");
    if (!canvas || !shell || !theme || typeof window.matchMedia !== "function") return;
    const ctx = canvas.getContext("2d", { alpha: false });
    const backing = document.createElement("canvas");
    const paint = backing.getContext("2d", { alpha: false, willReadFrequently: true });
    if (!ctx || !paint) return;
    const media = ["(forced-colors: active)", "(prefers-contrast: more)", "(prefers-reduced-transparency: reduce)", "(prefers-reduced-motion: reduce)"].map(query => window.matchMedia(query));
    const marked = new Set<HTMLElement>();
    let frame = 0, timer = 0, lastAdvanced = 0, phase = 0, deadline = 0, faulted = false;
    let atmosphere = atmosphereTarget();
    let output: ImageData | undefined;
    let observedIsland: HTMLElement | null = null;
    const tag = (sampled: Set<HTMLElement>, local: Set<HTMLElement> = new Set()) => {
      for (const element of marked) if (!sampled.has(element) && !local.has(element)) {
        delete element.dataset.aeLens;
        marked.delete(element);
      }
      for (const [elements, mode] of [[sampled, "sampled"], [local, "local"]] as const)
        for (const element of elements) {
          if (element.dataset.aeLens !== mode) element.dataset.aeLens = mode;
          marked.add(element);
        }
    };
    const clear = () => { delete shell.dataset.aeOptics; tag(new Set()); if (!canvas.hidden) canvas.hidden = true; };
    const paintFrame = (now: number) => {
      frame = 0;
      const explicit = theme.dataset;
      if (explicit.aeTheme !== "glass" || explicit.contrast === "increase" || explicit.transparency === "reduce"
        || media[0].matches || media[1].matches || media[2].matches || faulted) { clear(); return; }
      if (document.hidden || !shell.isConnected) return;
      const reduced = explicit.motion === "reduce" || media[3].matches;
      const seconds = lastAdvanced ? Math.min((now - lastAdvanced) / 1000, .25) : .14;
      const appearance = appearanceRecipe ? { ...R, ...appearanceRecipe } : R;
      phase += seconds * appearance.speed / 100;
      lastAdvanced = now;
      const bounds = shell.getBoundingClientRect();
      const top = Math.max(0, -bounds.top), left = Math.max(0, -bounds.left);
      const width = Math.min(bounds.right, window.innerWidth) - Math.max(0, bounds.left);
      const height = Math.min(bounds.bottom, window.innerHeight) - Math.max(0, bounds.top);
      if (width < 12 || height < 12) { clear(); return; }
      const scale = opticalViewportScale(width, height, window.devicePixelRatio || 1);
      const pw = Math.max(2, Math.round(width * scale)), ph = Math.max(2, Math.round(height * scale));
      if (backing.width !== pw || backing.height !== ph) { backing.width = pw; backing.height = ph; }
      if (canvas.width !== pw || canvas.height !== ph) { canvas.width = pw; canvas.height = ph; output = undefined; }
      canvas.style.left = left + "px"; canvas.style.top = top + "px";
      canvas.style.width = width + "px"; canvas.style.height = height + "px";
      const originX = bounds.left + left, originY = bounds.top + top;
      const elements = new Map<HTMLElement, Surface>();
      const local = new Set<HTMLElement>();
      const island = shell.querySelector<HTMLElement>(".ae-transfer-island[data-visible='true']");
      if (observedIsland !== island) {
        if (observedIsland) resize?.unobserve(observedIsland);
        if (island) resize?.observe(island);
        observedIsland = island;
      }
      const pixelBox = (box: DOMRect, corner: number, kind: Surface["kind"]): Surface => ({
        x: (box.left - originX) * scale, y: (box.top - originY) * scale,
        width: box.width * scale, height: box.height * scale,
        radius: Math.min(Number.isFinite(corner) ? corner : R.radius, box.height / 2, box.width / 2) * scale, kind,
      });
      const movingNodes = new Map<Element, boolean>();
      const movingGeometry = (element: Element | null) => {
        if (!element || !element.getAnimations) return false;
        if (!movingNodes.has(element)) movingNodes.set(element, element.getAnimations().some(animation => {
          const property = (animation as Partial<CSSTransition>).transitionProperty;
          return (!property || /^(transform|scale|translate|opacity|clip-path|inline-size|width|grid-template-rows|display)$/.test(property)) &&
            (animation.pending || animation.playState === "running");
        }));
        return movingNodes.get(element);
      };
      for (const element of shell.querySelectorAll<HTMLElement>(lensSelector)) {
        if (elements.size + local.size >= (island ? 31 : 32)) break;
        if (element.closest("dialog, .ae-popover, .ae-toast, .ios-dock, .ae-surface[data-material=overlay]")) continue;
        const bb = element.getBoundingClientRect();
        if (bb.width < 2 || bb.height < 2 || bb.right <= originX || bb.bottom <= originY
          || bb.left >= originX + width || bb.top >= originY + height) continue;
        const style = getComputedStyle(element);
        const fanButton = element.closest<HTMLElement>(".ae-orbit-choice");
        if (style.visibility !== "visible" || style.display === "none" || +style.opacity === 0) continue;
        const movingContainer = element.closest("[data-ae-route-enter], .ae-workspace-view");
        const interactive = element.matches(".ae-orbit-orb, .ae-spatial-glyph, .ae-button");
        // Do not leave a reflected duplicate at a previous screen position.
        // The local WebView material travels with the element until its final
        // geometry can be sampled accurately by the shared fixed raster.
        if (!reduced && (element.closest("[data-morphing='true']") ||
          movingGeometry(movingContainer) || movingGeometry(fanButton) || (interactive && movingGeometry(element)))) {
          local.add(element);
          continue;
        }
        if (fanButton && +getComputedStyle(fanButton).opacity < .98) continue;
        const ordinaryCard = element.matches(".ae-panel, .ae-surface[data-material=content], .ae-surface[data-material=raised]");
        const corner = ordinaryCard ? appearance.radius : Number.parseFloat(style.borderTopLeftRadius);
        const kind = element.matches(".ae-file-slot, [data-ae-lens-role=orb], .ae-spatial-glyph") ? "stage" :
          !element.matches(".ae-button, .ae-nav-indicator, [data-ae-lens-role=control]:not(.ae-surface)") ? "panel" : "control";
        elements.set(element, pixelBox(bb, corner, kind));
      }
      try {
        const light = explicit.appearance === "light";
        const rift = Array.from(shell.querySelectorAll<HTMLElement>(".ae-transfer-space:not([hidden])"))
          .find(space => space.querySelector(".ae-workspace-view:not([hidden])"));
        const status = rift?.dataset;
        const target = atmosphereTarget(status?.experiencePhase, Number(status?.experienceProgress),
          Number(status?.experienceX), Number(status?.experienceY));
        const moving = Math.abs(target.energy - atmosphere.energy) > .01
          || Math.abs(target.bend - atmosphere.bend) > .03 || Math.abs(target.x - atmosphere.x) > .015
          || Math.abs(target.y - atmosphere.y) > .015;
        atmosphere = reduced ? target : blendAtmosphere(atmosphere, target, seconds);
        const t = reduced ? 0 : phase;
        const intensity = atmosphereIntensity(!!rift, atmosphere.energy, light);
        paintAtmosphere(paint, pw, ph, t, light, atmosphere, intensity, light ? 100 : 108);
        const source = paint.getImageData(0, 0, pw, ph).data;
        const exposure = clamp(appearance.exposure, 50, 150) / 100;
        if (exposure !== 1) for (let j = 0; j < source.length; j += 4) {
          source[j] *= exposure; source[j+1] *= exposure; source[j+2] *= exposure;
        }
        if (!output) output = ctx.createImageData(pw, ph);
        output.data.set(source);
        // Do not compound white reflections in nested controls: each surface
        // works against the original scene; later DOM children own their rims.
        for (const box of elements.values()) shadeLens(output.data, source, pw, ph, box, scale, t, appearance);
        ctx.putImageData(output, 0, 0);
        if (island) {
          const islandRaster = island.querySelector<HTMLCanvasElement>(".ae-transfer-island-optical");
          const box = island.getBoundingClientRect();
          const movingIsland = !reduced && (movingGeometry(island?.parentElement) ||
            movingGeometry(island) || movingGeometry(island.querySelector(".ae-transfer-island-details")));
          if (box.width >= 2 && box.height >= 2) {
            if (movingIsland || !islandRaster) local.add(island);
            else {
              const islandBox = pixelBox(box, Number.parseFloat(getComputedStyle(island).borderTopLeftRadius), "panel");
              const x = Math.floor(islandBox.x), y = Math.floor(islandBox.y);
              const width = Math.ceil(islandBox.x + islandBox.width) - x;
              const height = Math.ceil(islandBox.y + islandBox.height) - y;
              const layer = islandRaster.getContext("2d", { alpha: false });
              if (layer && x >= 0 && y >= 0 && x + width <= pw && y + height <= ph) {
                // Same recipe and artwork as the shell. Copy only this bounded sample
                // above the page so underlying type cannot obscure foreground controls.
                shadeLens(output.data, source, pw, ph, islandBox, scale, t, appearance);
                if (islandRaster.width !== width) islandRaster.width = width;
                if (islandRaster.height !== height) islandRaster.height = height;
                layer.putImageData(output, -x, -y, x, y, width, height);
                elements.set(island, islandBox);
              } else local.add(island);
            }
          }
        }
        const shadow = clamp(appearance.shadow / 100);
        shell.style.setProperty("--ae-lab-radius", `${appearance.radius}px`);
        shell.style.setProperty("--ae-lab-shadow-y", `${2 + 4 * shadow}px`);
        shell.style.setProperty("--ae-lab-shadow-blur", `${4 + 5 * shadow}px`);
        shell.style.setProperty("--ae-lab-card-shadow", String(.37 * shadow));
        shell.style.setProperty("--ae-lab-control-shadow", String(.51 * shadow));
        shell.style.setProperty("--ae-lab-local-tint", String(appearance.opacity / 100));
        shell.style.setProperty("--ae-lab-local-blur", `${appearance.softness * .70}px`);
        tag(new Set(elements.keys()), local);
        if (canvas.hidden) canvas.hidden = false;
        shell.dataset.aeOptics = "ready";
        // Schedule only an in-flight interaction/transition, never an idle loop.
        if (!reduced && (moving || deadline > now)) timer = window.setTimeout(queue, 55);
        else lastAdvanced = 0;
      } catch {
        faulted = true;
        clear();
        return;
      }
    };
    const onContextLost = () => { faulted = true; clear(); };
    const queue = () => {
      window.clearTimeout(timer);
      if (frame || document.hidden) return;
      const delay = Math.max(0, 50 - (performance.now() - lastAdvanced));
      if (delay > 4) timer = window.setTimeout(queue, delay);
      else frame = requestAnimationFrame(paintFrame);
    };
    const animate = () => { deadline = performance.now() + 680; queue(); };
    const opticalHover = (event: PointerEvent) => {
      if (event.target instanceof Element && event.target.closest(".ae-orbit")) animate();
    };
    const settle = () => queue();
    const appearanceChanged = () => {
      cancelAnimationFrame(frame);
      window.clearTimeout(timer);
      paintFrame(performance.now());
    };
    const visibility = () => {
      if (document.hidden) {
        cancelAnimationFrame(frame); window.clearTimeout(timer);
        frame = 0; lastAdvanced = 0;
      } else queue();
    };
    const onScroll = () => queue();
    const geometryEvent = (event: Event) => {
      if (event.target instanceof Element && event.target.matches(
        "[data-ae-route-enter], .ae-workspace-view, .ae-orbit-choice, .ae-orbit-orb, .ae-spatial-glyph, .ae-button, " +
        ".ae-transfer-island-frame, .ae-transfer-island, .ae-transfer-island-details")) settle();
    };
    const geometryEvents = ["animationstart", "animationend", "animationcancel", "transitionrun", "transitionend", "transitioncancel"];
    const changes = new MutationObserver(records => {
      if (records.some(record => record.attributeName === "data-open" || record.attributeName === "data-morphing")) animate();
      else settle();
    });
    changes.observe(theme, { attributes: true, attributeFilter: ["data-ae-theme", "data-appearance", "data-contrast", "data-transparency", "data-motion"] });
    changes.observe(shell, { childList: true, subtree: true, attributes: true,
      attributeFilter: ["aria-current", "aria-disabled", "data-destination", "data-selected", "data-open", "data-morphing", "hidden", "disabled",
        "data-ae-route-enter", "data-collapsed", "data-visible", "data-experience-phase", "data-experience-progress", "data-experience-x", "data-experience-y"] });
    const resize = typeof ResizeObserver !== "undefined" ? new ResizeObserver(settle) : undefined;
    resize?.observe(shell);
    for (const mq of media) {
      if (typeof mq.addEventListener === "function") mq.addEventListener("change", settle);
      else mq.addListener(settle);
    }
    canvas.addEventListener("contextlost", onContextLost);
    backing.addEventListener("contextlost", onContextLost);
    window.addEventListener("resize", settle);
    window.addEventListener("scroll", onScroll, { passive: true, capture: true });
    window.visualViewport?.addEventListener("resize", settle);
    document.addEventListener("visibilitychange", visibility);
    document.addEventListener(appearanceCommitEvent, appearanceChanged);
    shell.addEventListener("pointerdown", animate, { passive: true });
    shell.addEventListener("focusin", animate);
    shell.addEventListener("pointerover", opticalHover, { passive: true });
    shell.addEventListener("pointerout", opticalHover, { passive: true });
    for (const name of geometryEvents) shell.addEventListener(name, geometryEvent, true);
    deadline = performance.now() + 840;
    queue();
    return () => {
      cancelAnimationFrame(frame);
      window.clearTimeout(timer);
      changes.disconnect(); resize?.disconnect();
      for (const mq of media) {
        if (typeof mq.removeEventListener === "function") mq.removeEventListener("change", settle);
        else mq.removeListener(settle);
      }
      canvas.removeEventListener("contextlost", onContextLost);
      backing.removeEventListener("contextlost", onContextLost);
      window.removeEventListener("resize", settle); window.removeEventListener("scroll", onScroll, true);
      window.visualViewport?.removeEventListener("resize", settle);
      document.removeEventListener("visibilitychange", visibility);
      document.removeEventListener(appearanceCommitEvent, appearanceChanged);
      shell.removeEventListener("pointerdown", animate); shell.removeEventListener("focusin", animate);
      shell.removeEventListener("pointerover", opticalHover); shell.removeEventListener("pointerout", opticalHover);
      clear();
    };
  }, [appearanceRecipe]);
  return <><AtmosphereFallback /><canvas ref={ref} className="ae-glass-optics" aria-hidden="true" hidden /></>;
}
