import MarkdownIt from 'markdown-it'
export const md = new MarkdownIt({ html: false, linkify: true, breaks: true, typographer: true })
export function splitNoteMd(mdText: string) {
  const lines = (mdText || '').split('\n'); const secs: { title: string; body: string[] }[] = []; let cur = { title: '_head', body: [] as string[] }
  for (const ln of lines) { const m = ln.match(/──\s*(.+?)\s*──/); if (m) { secs.push(cur); cur = { title: m[1], body: [] } } else cur.body.push(ln) }
  secs.push(cur)
  const find = (rx: RegExp) => { const s = secs.find((x) => rx.test(x.title)); return s ? s.body.join('\n').trim() : '' }
  return { head: secs[0].body.join('\n').trim(), generated: find(/generated/i), raw: find(/raw pipeline|embedded/i), gold: find(/gold/i) }
}
export function computeDiff(a: string, b: string) {
  const A = (a || '').split('\n'), B = (b || '').split('\n'); const n = A.length, m = B.length
  const dp = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0))
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i][j] = A[i] === B[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1])
  const out: { t: string; line: string }[] = []; let i = 0, j = 0
  while (i < n && j < m) { if (A[i] === B[j]) { out.push({ t: ' ', line: A[i] }); i++; j++ } else if (dp[i + 1][j] >= dp[i][j + 1]) { out.push({ t: '-', line: A[i] }); i++ } else { out.push({ t: '+', line: B[j] }); j++ } }
  while (i < n) out.push({ t: '-', line: A[i++] }); while (j < m) out.push({ t: '+', line: B[j++] })
  return out.filter((d) => d.t !== ' ' || d.line.trim())
}
