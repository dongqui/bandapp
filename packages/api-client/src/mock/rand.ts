/** 프로토타입과 동일한 결정적 의사난수 (0..1) */
export function seededUnit(x: number): number {
  const s = Math.sin(x) * 43758.5453;
  return s - Math.floor(s);
}

export function seedOf(id: string): number {
  let n = 0;
  for (const c of id) n += c.charCodeAt(0);
  return n;
}
