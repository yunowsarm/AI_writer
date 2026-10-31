/** 配色迁移工具：保留原有浅色值，将组件颜色按文字、表面、边框和阴影映射为主题变量。 */
import { readFile, writeFile, readdir } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import postcss from 'postcss'
const root = fileURLToPath(new URL('../web/src', import.meta.url))
const palette = new Map()

/** 递归收集源样式与组件，不处理生成的主题文件或打包产物。 */
async function filesIn(directory) {
  const entries = await readdir(directory, { withFileTypes: true })
  const files = await Promise.all(
    entries.map((entry) =>
      entry.isDirectory() ? filesIn(path.join(directory, entry.name)) : [path.join(directory, entry.name)]
    )
  )
  return files.flat().filter((file) => /\.(css|vue)$/.test(file) && !/theme(-palette)?\.css$/.test(file))
}

/** 读取色相、饱和度、明度和透明度，用于保留不同题材封面原有的色相。 */
function colorInfo(hex) {
  let value = hex.slice(1)
  if (value.length <= 4) value = [...value].map((letter) => letter + letter).join('')
  const rgb = [0, 2, 4].map((index) => parseInt(value.slice(index, index + 2), 16) / 255)
  const max = Math.max(...rgb),
    min = Math.min(...rgb),
    delta = max - min,
    light = (max + min) / 2
  const saturation = delta ? delta / (1 - Math.abs(2 * light - 1)) : 0
  let hue = 0
  if (delta) {
    hue =
      max === rgb[0]
        ? ((rgb[1] - rgb[2]) / delta) % 6
        : max === rgb[1]
          ? (rgb[2] - rgb[0]) / delta + 2
          : (rgb[0] - rgb[1]) / delta + 4
    hue = (hue * 60 + 360) % 360
  }
  return { hue, saturation, light, alpha: value.length === 8 ? parseInt(value.slice(6), 16) / 255 : 1 }
}

/** 暗色不使用反色滤镜：文字提升明度，表面降低明度，图片与 Logo 不参与转换。 */
function darkColor(hex, role) {
  const info = colorInfo(hex)
  let { hue, saturation, light, alpha } = info
  // 无彩色表面采用冷灰色相，避免纯白映射后出现红褐色偏色。
  if (saturation < 0.1) hue = 250
  if (role === 'shadow') return `rgb(0 0 0 / ${Math.max(alpha, 0.08).toFixed(3)})`
  if (role === 'ink') {
    light = light < 0.35 ? 0.91 : light < 0.6 ? 0.78 : light > 0.94 ? 0.96 : 0.69
    saturation = Math.min(0.5, saturation)
  } else if (role === 'line') {
    light = 0.25
    saturation = Math.min(0.22, saturation)
  } else if (role === 'accent') {
    light = Math.max(0.67, light)
    saturation = Math.min(0.65, saturation)
  } else {
    if (['#f8f9fc', '#faf9fc'].includes(hex)) return '#16161e'
    if (light < 0.7 && saturation > 0.15) return hex
    light = light > 0.96 ? 0.13 : light > 0.88 ? 0.16 : light > 0.75 ? 0.19 : 0.23
    saturation = Math.min(0.27, Math.max(0.09, saturation * 0.65))
  }
  return `hsl(${Math.round(hue)} ${Math.round(saturation * 100)}% ${Math.round(light * 100)}% / ${alpha.toFixed(3)})`
}

/** 同一颜色在文字与背景中使用不同变量，避免白色文字被映射成深色表面。 */
function token(hex, role) {
  const color = hex.toLowerCase(),
    name = `--theme-${role}-${color.slice(1)}`
  palette.set(name, darkColor(color, role))
  return `var(${name}, ${hex})`
}

/** 保留非颜色声明和媒体查询；重复执行时只收集现有变量，不重复嵌套 var。 */
function convertStyle(source) {
  const ast = postcss.parse(source)
  ast.walkDecls((declaration) => {
    if (declaration.prop.startsWith('--')) return
    const role = /shadow/.test(declaration.prop)
      ? 'shadow'
      : /^(color|caret-color|text-decoration-color)$/.test(declaration.prop)
        ? 'ink'
        : /border|outline|stroke/.test(declaration.prop)
          ? 'line'
          : 'surface'
    declaration.value = declaration.value.replace(/(?<![\w-])(white|black)(?![\w-])/gi, (name) =>
      token(name.toLowerCase() === 'white' ? '#fff' : '#000', role)
    )
    if (declaration.value.includes('--theme-')) {
      for (const match of declaration.value.matchAll(/var\((--theme-(\w+)-[a-f0-9]+),\s*(#[a-f0-9]+)\)/gi))
        palette.set(match[1], darkColor(match[3], match[2]))
      return
    }
    declaration.value = declaration.value.replace(/#[a-f0-9]{3,8}\b/gi, (hex) => token(hex, role))
  })
  return ast.toString()
}

for (const file of await filesIn(root)) {
  const before = await readFile(file, 'utf8')
  let after = file.endsWith('.css')
    ? convertStyle(before)
    : before.replace(
        /(<style[^>]*>)([\s\S]*?)(<\/style>)/g,
        (_, open, css, close) => open + convertStyle(css) + close
      )
  // SVG 图表的颜色属性同样使用 CSS 变量，切换主题时无需重新请求统计数据。
  if (file.endsWith('.vue'))
    after = after.replace(
      /\b(fill|stroke)="(#[a-f0-9]{3,8})"/gi,
      (_, attribute, hex) =>
        `${attribute}="${token(hex, attribute === 'stroke' ? (colorInfo(hex).light > 0.7 ? 'line' : 'accent') : hex === '#f1eafa' ? 'surface' : 'ink')}"`
    )
  for (const match of after.matchAll(/var\((--theme-(\w+)-[a-f0-9]+),\s*(#[a-f0-9]+)\)/gi))
    palette.set(match[1], darkColor(match[3], match[2]))
  if (after !== before) await writeFile(file, after)
}
await writeFile(
  path.join(root, 'styles/theme-palette.css'),
  `/* 暗色颜色表：由 tools/theme-palette.mjs 按颜色用途生成；浅色仍使用原有 fallback。 */\nhtml.dark {\n${[
    ...palette,
  ]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, color]) => `  ${name}: ${color};`)
    .join('\n')}\n}\n`
)
console.log(`已统一 ${palette.size} 个用途明确的颜色变量，保留原浅色配色。`)
