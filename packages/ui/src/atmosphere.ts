type Color = readonly [number, number, number];
type Stop = readonly [number, string];

export interface AtmosphereState {
  x: number;
  y: number;
  energy: number;
  bend: number;
  color: Color;
}

const phases: Record<string, { energy: number; bend: number; color: Color }> = {
  idle: { energy: 0, bend: 0, color: [59, 107, 247] },
  discovery: { energy: .24, bend: .5, color: [79, 135, 252] },
  selected: { energy: .16, bend: .35, color: [75, 147, 253] },
  hand: { energy: .30, bend: -.55, color: [114, 101, 255] },
  held: { energy: .42, bend: -1, color: [155, 71, 245] },
  ready: { energy: .46, bend: .42, color: [48, 203, 251] },
  departure: { energy: .57, bend: 1, color: [55, 162, 252] },
  transferring: { energy: .43, bend: .68, color: [63, 151, 251] },
  receiving: { energy: .48, bend: .37, color: [52, 165, 249] },
  completed: { energy: .21, bend: .04, color: [81, 205, 173] },
  interrupted: { energy: .18, bend: -.3, color: [232, 139, 67] },
  failed: { energy: .20, bend: -.4, color: [221, 82, 131] },
};

function within(value: number, otherwise: number) {
  return Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : otherwise;
}

export function atmosphereTarget(phase = "idle", progress = 0, x = NaN, y = NaN): AtmosphereState {
  const shape = Object.hasOwn(phases, phase) ? phases[phase] : phases.idle;
  const active = phase === "transferring" || phase === "receiving";
  const position = .47 + (within(x, .79) - .47) * within(progress, 0);
  return { ...shape, x: active ? position : within(x, .6), y: within(y, .56) };
}

export function blendAtmosphere(from: AtmosphereState, to: AtmosphereState, seconds: number): AtmosphereState {
  const weight = 1 - Math.exp(-Math.min(seconds, .25) * 6);
  const mix = (a: number, b: number) => a + (b - a) * weight;
  return {
    x: mix(from.x, to.x), y: mix(from.y, to.y), energy: mix(from.energy, to.energy), bend: mix(from.bend, to.bend),
    color: [mix(from.color[0], to.color[0]), mix(from.color[1], to.color[1]), mix(from.color[2], to.color[2])],
  };
}

/** Fast, quiet tool surfaces share the same field as the active Rift. */
export function atmosphereIntensity(inRift: boolean, energy: number, isLight: boolean) {
  const idle = isLight ? .43 : .34;
  return inRift ? idle + .14 + Math.min(.46, Math.max(0, energy) * .95) : idle;
}

const dark = {
  canvas: "#090d17", shade: "#16163b", distance: "#14102e", body: "#141049", bodyDeep: "#09091d",
  lift: "#2d29a8", amethyst: "#7134b6", face: "#1839ad", shadow: "#070716", glow: "#2568ff",
  lip: "#60dfff", lipWhite: "#dcf9ff", violet: "#9e57ff", violetWhite: "#daa2fb", taper: "#160f52",
};
const light = {
  canvas: "#f5f6fa", shade: "#e1e6f3", distance: "#c4c9e8", body: "#afc5f4", bodyDeep: "#e4e1f2",
  lift: "#777bd3", amethyst: "#a080c4", face: "#82afed", shadow: "#9da7d8", glow: "#69a4f4",
  lip: "#5ac0e6", lipWhite: "#faffff", violet: "#ad84e5", violetWhite: "#fff2ff", taper: "#acb4df",
};

export function ribbonGeometry(wave = 0, twist = 0) {
  const crest = `M -83 326 C 75 174 305 ${167 - wave} 490 277 C 661 ${380 + twist} 797 ${465 + wave} 928 406
    C 992 377 1025 339 1062 292`;
  return {
    rear: `M -84 344 C 87 174 278 ${176 - twist} 457 254 C 661 342 811 ${188 + wave} 1048 233
      C 1138 282 1104 400 1026 455 C 901 519 748 424 608 470 C 408 532 129 503 -18 444 C -63 425 -87 382 -84 344 Z`,
    lower: `M -64 333 C 110 196 302 ${188 + wave} 466 312 C 584 403 676 461 820 472
      C 613 477 531 519 328 515 C 157 519 15 466 -64 417 C -86 395 -82 359 -64 333 Z`,
    front: `${crest} C 1130 389 1060 490 930 503 C 767 523 630 ${407 + wave} 474 339
      C 318 262 125 ${174 + twist} -83 371 Z`,
    returning: `M 245 ${216 - wave} C 408 181 539 257 687 319 C 791 367 884 438 966 407
      C 918 479 811 479 712 433 C 562 364 451 306 314 275 C 257 261 208 224 245 ${216 - wave} Z`,
    cyan: crest,
    violet: `M 474 339 C 630 ${407 + wave} 767 523 930 503 C 1060 490 1130 389 1062 292`,
  };
}

/** Canvas-owned artwork in a 1000 × 640 design space. Four surfaces share the same fold, with different edges in light. */
export function paintAtmosphere(ctx: CanvasRenderingContext2D, w: number, h: number, t: number, isLight: boolean,
  state: AtmosphereState, intensity: number, exposure: number) {
  const p = isLight ? light : dark;
  const height = Math.min(h, w * 1.02);
  const top = (h - height) * .44;
  const wave = Math.sin(t * .23) * 2.7 + state.bend * 7;
  const twist = Math.cos(t * .19) * 2.1 - state.bend * 4;
  const rgb = (color: string, opacity: number) => color + Math.round(Math.min(1, opacity * intensity) * 255).toString(16).padStart(2, "0");
  const grad = (x0: number, y0: number, x1: number, y1: number, stops: readonly Stop[]) => {
    const gradient = ctx.createLinearGradient(x0, y0, x1, y1);
    for (const [offset, color] of stops) gradient.addColorStop(offset, color);
    return gradient;
  };
  const spot = (x: number, y: number, size: number, color: string, alpha: number) => {
    const gradient = ctx.createRadialGradient(x, y, 0, x, y, size);
    gradient.addColorStop(0, rgb(color, alpha));
    gradient.addColorStop(.42, rgb(color, alpha * .57));
    gradient.addColorStop(1, rgb(color, 0));
    ctx.fillStyle = gradient;
    ctx.fillRect(x - size, y - size, size * 2, size * 2);
  };
  const sheen = (x: number, y: number, radius: number, angle: number, spread: number, color: string, alpha: number) => {
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(angle);
    ctx.scale(1, spread);
    spot(0, 0, radius, color, alpha);
    ctx.restore();
  };

  // The broad field is visible under window chrome even when the fold falls
  // below it. Keep the hue restrained so headings do not need opaque scrims.
  ctx.fillStyle = grad(0, 0, w, h, [
    [0, p.canvas], [.64, p.canvas], [1, isLight ? "#eef1f9" : "#0b1221"],
  ]);
  ctx.fillRect(0, 0, w, h);
  spot(w * .76, h * .14, Math.max(w * .52, h * .46), isLight ? "#acbcdf" : "#334f76", isLight ? .78 : .58);
  spot(w * .09, h * .57, Math.max(w * .47, h * .39), isLight ? "#bac2df" : "#45447a", .47);
  ctx.save();
  ctx.translate(0, top);
  ctx.scale(w / 1000, height / 640);
  // The darker open space above the fold stays unlit. In Light, a localized cast shadow grounds it on pearl.
  ctx.save();
  ctx.translate(520, 452);
  ctx.scale(1, .24);
  spot(0, 0, 582, p.shade, isLight ? .77 : .48);
  ctx.restore();

  const geometry = ribbonGeometry(wave, twist);
  const rear = new Path2D(geometry.rear), lower = new Path2D(geometry.lower);
  const front = new Path2D(geometry.front), returnFold = new Path2D(geometry.returning);

  const surface = (shape: Path2D, fill: CanvasGradient, lights: () => void) => {
    ctx.fillStyle = fill;
    ctx.fill(shape);
    ctx.save();
    ctx.clip(shape);
    lights();
    ctx.restore();
  };
  surface(rear, grad(470, 218, 470, 514, [
    [0, rgb(p.distance, .39)], [.32, rgb(p.bodyDeep, .27)], [.79, rgb(p.body, .47)], [1, rgb(p.shadow, .22)],
  ]), () => {
    spot(1017, 439, 235, p.lift, .52);
    spot(88, 451, 265, p.face, .34);
    spot(600, 429, 218, p.bodyDeep, .39);
    sheen(260, 224, 207, .08, .14, p.violet, .29);
  });
  surface(lower, grad(400, 210, 470, 520, [
    [0, rgb(p.lift, .27)], [.39, rgb(p.distance, .25)], [.72, rgb(p.bodyDeep, .36)], [1, rgb(p.face, .24)],
  ]), () => {
    spot(100, 452, 238, p.face, .40);
    spot(354, 442, 164, p.bodyDeep, .60);
    spot(567, 387, 166, p.lift, .32);
    sheen(297, 467, 262, .16, .20, p.lip, isLight ? .16 : .11);
  });
  surface(returnFold, grad(475, 200, 490, 465, [
    [0, rgb(p.lift, .40)], [.48, rgb(p.face, .30)], [.79, rgb(p.body, .39)], [1, rgb(p.glow, .46)],
  ]), () => {
    spot(677, 358, 213, p.glow, .48);
    sheen(622, 351, 248, .46, .09, p.lip, isLight ? .34 : .51);
  });
  surface(front, grad(540, 229, 550, 501, [
    [0, rgb(p.amethyst, .33)], [.25, rgb(p.body, .55)], [.56, rgb(p.shadow, .46)],
    [.77, rgb(p.lift, .40)], [1, rgb(p.violet, .60)],
  ]), () => {
    spot(1052, 449, 222, p.glow, .80);
    spot(657, 369, 201, p.face, .45);
    spot(182, 235, 163, p.amethyst, .20);
    sheen(755, 422, 229, .51, .12, p.lip, isLight ? .31 : .51);
    sheen(950, 455, 178, -.27, .20, p.violetWhite, isLight ? .27 : .34);
    if (state.energy > .008) {
      const color = `#${state.color.map(value => Math.round(value).toString(16).padStart(2, "0")).join("")}`;
      spot(state.x * 1000, Math.max(270, Math.min(480, state.y * 640)), 192, color, state.energy * .55);
    }
  });

  const blueLip = new Path2D(geometry.cyan), violetLip = new Path2D(geometry.violet);
  const high = Math.min(1.3, exposure / (isLight ? 100 : 108));
  ctx.lineCap = "round";
  const edge = (path: Path2D, width: number, stops: readonly Stop[]) => {
    ctx.lineWidth = width;
    ctx.strokeStyle = grad(125, 246, 1040, 473, stops);
    ctx.stroke(path);
  };
  edge(blueLip, 29, [[0, rgb(p.lift, 0)], [.49, rgb(p.glow, .02)], [.71, rgb(p.glow, .10 * high)], [.90, rgb(p.glow, .12 * high)], [1, rgb(p.lip, .04)]]);
  edge(blueLip, 12, [[0, rgb(p.lift, 0)], [.49, rgb(p.glow, .03)], [.71, rgb(p.glow, .19 * high)], [.90, rgb(p.lip, .20 * high)], [1, rgb(p.lip, .07)]]);
  edge(blueLip, 4, [[0, rgb(p.lift, 0)], [.37, rgb(p.lift, .12)], [.56, rgb(p.glow, .24)], [.78, rgb(p.lip, .73 * high)], [.92, rgb(p.lip, .77 * high)], [1, rgb(p.lip, 0)]]);
  edge(blueLip, 1.15, [[0, rgb(p.lipWhite, 0)], [.56, rgb(p.lip, .11)], [.80, rgb(p.lipWhite, .91 * high)], [.96, rgb(p.lip, 0)], [1, rgb(p.lip, 0)]]);
  edge(violetLip, 11, [[0, rgb(p.violet, 0)], [.6, rgb(p.violet, .08)], [.87, rgb(p.violet, .36 * high)], [1, rgb(p.violet, .12)]]);
  edge(violetLip, 2.1, [[0, rgb(p.violet, 0)], [.57, rgb(p.violet, .14)], [.83, rgb(p.violetWhite, .62 * high)], [.97, rgb(p.violetWhite, .82 * high)], [1, rgb(p.violet, .42)]]);
  ctx.restore();
}
