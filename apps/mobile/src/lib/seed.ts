export function seededUnit(x: number): number {
  const s = Math.sin(x) * 43758.5453;
  return s - Math.floor(s);
}
