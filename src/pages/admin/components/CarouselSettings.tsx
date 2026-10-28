import { useState } from "react";
import { useAuth } from "@/pages/admin/lib/authContext";
import { useAdminData } from "@/pages/admin/lib/storeContext";
import { useToast } from "@/pages/admin/components/toastContext";
import { Button, Card, Field, Select, Toggle } from "@/pages/admin/components/ui";

const CAROUSEL_INTERVALS = [3, 5, 8, 10, 15];
const DRIFT_SPEEDS = [
  { value: "slow", label: "Slow (about 20 px/s)" },
  { value: "medium", label: "Medium (about 40 px/s)" },
  { value: "fast", label: "Fast (about 70 px/s)" },
] as const;

/** Courses > Homepage carousel: auto-slide on/off, slide interval and pause-on-hover. Administrators only. */
export default function CarouselSettings() {
  const { data, saveNow, logActivity } = useAdminData();
  const { user } = useAuth();
  const { push } = useToast();
  const saved = {
    motion: data.settings.carouselMotion ?? "drift",
    speed: data.settings.carouselDriftSpeed ?? "slow",
    auto: data.settings.carouselAutoSlide ?? true,
    seconds: data.settings.carouselIntervalSeconds ?? 5,
    hover: data.settings.carouselPauseOnHover ?? true,
  };
  const [motion, setMotion] = useState<"drift" | "slide">(saved.motion);
  const [speed, setSpeed] = useState<"slow" | "medium" | "fast">(saved.speed);
  const [auto, setAuto] = useState(saved.auto);
  const [seconds, setSeconds] = useState(String(saved.seconds));
  const [hover, setHover] = useState(saved.hover);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const canEdit = user?.role === "Admin";

  const save = async () => {
    const value = Number(seconds);
    if (!DRIFT_SPEEDS.some((option) => option.value === speed)) {
      setError("Choose Slow, Medium or Fast.");
      return;
    }
    if (!CAROUSEL_INTERVALS.includes(value)) {
      setError(`Choose one of ${CAROUSEL_INTERVALS.join(", ")} seconds.`);
      return;
    }
    setError("");
    setSaving(true);
    try {
      // Merge into the latest settings so other unsaved Website Settings edits are never touched.
      await saveNow((d) => ({ ...d, settings: { ...d.settings, carouselMotion: motion, carouselDriftSpeed: speed, carouselAutoSlide: auto, carouselIntervalSeconds: value, carouselPauseOnHover: hover } }));
      logActivity("Updated", "Homepage carousel settings", "Courses");
      push("Homepage carousel settings saved");
    } catch (e) {
      push(e instanceof Error ? e.message : "Could not save the carousel settings. Please try again.", "error");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card className="mb-5 p-4">
      <h2 className="font-heading text-base font-semibold">Homepage carousel</h2>
      <div className="mt-3 flex flex-col gap-4 md:flex-row md:items-start">
        <Toggle label="Auto-play" checked={auto} disabled={!canEdit || saving} onChange={setAuto} />
        <div className="md:w-48">
          <Field label="Motion style" hint="Applies to the homepage courses carousel.">
            <Select aria-label="Motion style" value={motion} disabled={!canEdit || saving} onChange={(e) => setMotion(e.target.value === "slide" ? "slide" : "drift")}>
              <option value="drift">Continuous drift</option>
              <option value="slide">Slide by slide</option>
            </Select>
          </Field>
        </div>
        <div className="md:w-56">
          {motion === "drift" ? (
            <Field label="Speed" hint="Pixels per second, the same on every screen.">
              <Select aria-label="Speed" value={speed} disabled={!canEdit || saving || !auto} onChange={(e) => setSpeed(e.target.value as typeof speed)}>
                {DRIFT_SPEEDS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
              </Select>
            </Field>
          ) : (
            <Field label="Slide interval" hint="Applies to the homepage courses carousel.">
              <Select aria-label="Slide interval" value={seconds} disabled={!canEdit || saving || !auto} onChange={(e) => setSeconds(e.target.value)}>
                {CAROUSEL_INTERVALS.map((option) => <option key={option} value={option}>{option} seconds</option>)}
              </Select>
            </Field>
          )}
          {error ? <p role="alert" className="mt-1.5 text-xs font-medium text-red-700">{error}</p> : null}
        </div>
        <Toggle label="Pause on hover" checked={hover} disabled={!canEdit || saving || !auto} onChange={setHover} />
        <Button icon="ri-save-line" onClick={save} disabled={!canEdit || saving}>
          {saving ? "Saving…" : "Save"}
        </Button>
      </div>
      {!canEdit ? <p className="mt-3 text-xs text-foreground-500">Only administrators can change these settings.</p> : null}
    </Card>
  );
}
