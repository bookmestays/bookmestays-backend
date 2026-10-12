// Size rules for home advertising posters. Mirrored in the frontend
// (src/lib/home-ads.ts) so the admin sees errors before uploading.

export const HOME_AD_SPECS = {
  desktop: { ratio: 8, minWidth: 1600, minHeight: 200, recommended: "2400 × 300 px" },
  mobile: { ratio: 3, minWidth: 900, minHeight: 300, recommended: "1200 × 400 px" },
} as const;

/** Allowed deviation from the exact aspect ratio (2%) — absorbs export rounding. */
export const HOME_AD_RATIO_TOLERANCE = 0.02;

/** Returns an error message, or null when the dimensions fit the slot. */
export function homeAdSizeError(kind: keyof typeof HOME_AD_SPECS, width: number, height: number): string | null {
  const spec = HOME_AD_SPECS[kind];
  const label = kind === "desktop" ? "Desktop poster" : "Mobile poster";
  if (!width || !height) return `${label}: image size could not be read`;
  if (Math.abs(width / height / spec.ratio - 1) > HOME_AD_RATIO_TOLERANCE)
    return `${label} must be ${spec.ratio}:1 (e.g. ${spec.recommended}); this one is ${width} × ${height} px`;
  if (width < spec.minWidth || height < spec.minHeight)
    return `${label} is too small (${width} × ${height} px) — at least ${spec.minWidth} × ${spec.minHeight} px`;
  return null;
}
