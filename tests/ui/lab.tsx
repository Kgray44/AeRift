import { useState } from "react";
import { createRoot } from "react-dom/client";
import { AppShell, Button, GlassSurface, ThemeProvider, transitionAppearance } from "../../packages/ui/src";
import { aeRiftGlassRecipe, glassAppearanceRecipes, type GlassAppearanceRecipe } from "../../packages/ui/src/GlassOptics";
import "../../packages/ui/src/styles.css";
import "./lab.css";

type Appearance = keyof typeof glassAppearanceRecipes;
type OpticalNumber = keyof GlassAppearanceRecipe;

const parameters: readonly { key: OpticalNumber; label: string; min: number; max: number; step: number }[] = [
  { key: "opacity", label: "Optical tint", min: 0, max: 80, step: 1 },
  { key: "softness", label: "Backdrop softness", min: 0, max: 14, step: 1 },
  { key: "exposure", label: "Exposure", min: 80, max: 125, step: 1 },
  { key: "distortion", label: "Distortion", min: 0, max: 40, step: 1 },
  { key: "dispersion", label: "Dispersion", min: 0, max: 100, step: 1 },
  { key: "reflection", label: "Reflection intensity", min: 0, max: 100, step: 1 },
  { key: "patches", label: "Reflection patches", min: 0, max: 100, step: 1 },
  { key: "iridescence", label: "Edge iridescence", min: 0, max: 100, step: 1 },
  { key: "edging", label: "Directional edging", min: 0, max: 100, step: 1 },
];

function Laboratory() {
  const [appearance, setAppearance] = useState<Appearance>("dark");
  const [settings, setSettings] = useState(glassAppearanceRecipes);
  const [pattern, setPattern] = useState(false);
  const recipe = settings[appearance];
  const exportData = JSON.stringify({
    schema: "aerift-glass-lab/v1", settings: { ...aeRiftGlassRecipe, ...recipe },
  }, null, 2);

  function update(patch: Partial<GlassAppearanceRecipe>) {
    setSettings(current => ({ ...current, [appearance]: { ...current[appearance], ...patch } }));
  }

  return <ThemeProvider scheme={appearance}>
    <AppShell brand="GLASS Laboratory" glassRecipe={recipe}>
      <div className="ae-lab" data-experience-phase="idle">
        <div className="ae-lab-actions">
          <a href="./">Workspace showcase</a>
          <div className="ae-actions" role="group" aria-label="Preview appearance">
            {(["light", "dark"] as const).map(scheme => <Button key={scheme} variant="quiet"
              aria-pressed={scheme === appearance} onClick={() => transitionAppearance(() => setAppearance(scheme), "system")}>
              {scheme === "light" ? "Light" : "Dark"}
            </Button>)}
          </div>
          <Button variant="quiet" aria-pressed={pattern} onClick={() => setPattern(!pattern)}>High-contrast detail</Button>
        </div>
        <div className="ae-lab-stage" data-pattern={pattern}>
          <GlassSurface className={pattern ? "ae-lab-surface" : "ae-lab-surface ae-panel"} material="chrome">
            <h2>Interactive material</h2>
            <p>Reflections and refraction across text and controls.</p>
            <div className="ae-actions"><Button variant="primary">Send file</Button><Button>Choose file</Button></div>
          </GlassSurface>
          <GlassSurface material="overlay" className="ae-lab-surface">
            <h2>Floating material</h2><p>Menu and dialog surfaces.</p>
          </GlassSurface>
        </div>
        <div className="ae-lab-tuners">
          {parameters.map(({ key, label, min, max, step }) => <label key={key}>
            <span>{label} <output>{recipe[key]}</output></span>
            <input type="range" aria-label={label} min={min} max={max} step={step} value={recipe[key]}
              onChange={event => update({ [key]: event.currentTarget.valueAsNumber })} />
          </label>)}
        </div>
        <div className="ae-lab-actions">
          <Button variant="quiet" onClick={() => setSettings(current => ({ ...current, [appearance]: glassAppearanceRecipes[appearance] }))}>
            Restore {appearance} defaults
          </Button>
          <a download={`aerift-glass-${appearance}.json`} href={`data:application/json,${encodeURIComponent(exportData)}`}>Download recipe</a>
        </div>
      </div>
    </AppShell>
  </ThemeProvider>;
}

createRoot(document.getElementById("root")!).render(<Laboratory />);
