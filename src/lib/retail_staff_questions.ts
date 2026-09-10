/** Detect retail staff / manager questions — including common STT garble on phone lines. */

export function callerSoundsLikeRetailStaffQuestion(text: string): boolean {
  const t = text
    .trim()
    .toLowerCase()
    .replace(/[^\w\s']/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!t) return false;

  if (
    /\b(store manager|shop manager|duty manager|fresh food manager|ambient manager|department manager|who runs|who manages|who is the manager|who'?s the manager)\b/.test(
      t,
    )
  ) {
    return true;
  }

  if (/\b(manager|supervisor|boss)\b/.test(t) && /\b(who|name|called)\b/.test(t)) {
    return true;
  }

  // STT often garbles "SuperValu" / "store manager" on mobile lines.
  if (
    /\b(server value|super value|supervalu|super valu|store value|shop value)\b/.test(t) &&
    /\b(work for|who|manager|name|run)\b/.test(t)
  ) {
    return true;
  }

  if (/\b(fresh food|ambient|deli|butcher)\b/.test(t) && /\b(manager|who runs|in charge)\b/.test(t)) {
    return true;
  }

  return false;
}
