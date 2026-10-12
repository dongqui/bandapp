/** levels를 bars 길이로 맞춘다. 짧으면 왼쪽을 0으로 채우고, 길면 가장 최근(뒤) bars개만 쓴다. */
export function fitLevels(levels: number[], bars: number): number[] {
  if (levels.length >= bars) return levels.slice(levels.length - bars);
  return [...Array.from({ length: bars - levels.length }, () => 0), ...levels];
}
