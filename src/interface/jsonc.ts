/**
 * 容错 JSON：真实项目的 interface.json 带 `//` 注释（官方解析器基于 meojson），
 * strict JSON.parse 会直接拒绝，因此先做最小脱敏——字符串外的注释与尾随逗号去掉。
 */

export function parseJsonc(text: string): unknown {
  return JSON.parse(stripTrailingCommas(stripComments(text)))
}

function stripComments(s: string): string {
  let out = ''
  let i = 0
  let inStr = false
  while (i < s.length) {
    const ch = s[i]
    if (inStr) {
      out += ch
      if (ch === '\\' && i + 1 < s.length) {
        out += s[i + 1]
        i += 2
        continue
      }
      if (ch === '"') inStr = false
      i++
      continue
    }
    if (ch === '"') {
      inStr = true
      out += ch
      i++
      continue
    }
    if (ch === '/' && s[i + 1] === '/') {
      while (i < s.length && s[i] !== '\n') i++
      continue
    }
    if (ch === '/' && s[i + 1] === '*') {
      i += 2
      while (i < s.length && !(s[i] === '*' && s[i + 1] === '/')) i++
      i += 2
      continue
    }
    out += ch
    i++
  }
  return out
}

function stripTrailingCommas(s: string): string {
  let out = ''
  let i = 0
  let inStr = false
  while (i < s.length) {
    const ch = s[i]
    if (inStr) {
      out += ch
      if (ch === '\\' && i + 1 < s.length) {
        out += s[i + 1]
        i += 2
        continue
      }
      if (ch === '"') inStr = false
      i++
      continue
    }
    if (ch === '"') {
      inStr = true
      out += ch
      i++
      continue
    }
    if (ch === ',') {
      let j = i + 1
      while (j < s.length && isSpace(s[j])) j++
      if (s[j] === '}' || s[j] === ']') {
        i++
        continue
      }
    }
    out += ch
    i++
  }
  return out
}

function isSpace(c: string): boolean {
  return c === ' ' || c === '\t' || c === '\n' || c === '\r'
}
