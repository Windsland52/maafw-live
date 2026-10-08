/**
 * 容错 JSON：真实项目的 interface.json 带 `//` 注释（官方解析器基于 meojson），
 * strict JSON.parse 会直接拒绝，因此先做最小脱敏——字符串外的注释与尾随逗号去掉。
 *
 * 取舍：只做这两件**最小**的事，不做单引号 / 无引号键 / 多行字符串那类扩展——
 * 越是"看起来像 JSON"的输入，越容易被静默改写成作者没写的意思。
 * 另：开头的 BOM（Windows 记事本等会写）先剥掉，它会让 JSON.parse 报 "Unexpected token"。
 */

export function parseJsonc(text: string): unknown {
  const noBom = text.charCodeAt(0) === 0xFEFF ? text.slice(1) : text
  return JSON.parse(stripTrailingCommas(stripComments(noBom)))
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
