/**
 * router-core: 三套插件整合后的纯路由核心，零外部依赖。
 *
 * 它把 dsh-routing-suite 的实测行为分带（spec/react/weak）、J-Space 的
 * fast/full/loop 门控与模块路由、oh-we-need 的 V4 思维风格统一成一套可测试逻辑。
 */

export const MODE_SPEC = 0
export const MODE_MIXED = 0.3
export const MODE_REACT = 1
export const MODE_WEAK = 'weak'

export const PASS_FAST = 'fast'
export const PASS_FULL = 'full'
export const PASS_LOOP = 'loop'

const SPEC_PERSONA = 'You are a helpful software engineer assistant.'

const MIXED_PERSONA =
  'You are a helpful software engineer assistant.\n'
  + 'Work directly: prefer writing or editing code over describing plans. '
  + 'Verify your changes by reading and running them.'

const REACT_PERSONA =
  'You are a hands-on software engineer who delivers working output fast.\n'
  + 'Work directly: write or edit code, then verify it by reading and running. '
  + 'Keep the loop tight — produce, verify, fix — and do not build test '
  + 'harnesses, scaffolding, or ceremony the user did not ask for. '
  + 'Finish with a usable deliverable and a short summary.'

const WEAK_PRO =
  'You are a helpful software engineer assistant.\n'
  + 'Before acting, decide the task type (build or fix) and adopt the matching '
  + 'style: build → hands-on production; fix → inspect-and-plan.'

const WEAK_FLASH =
  'You are a helpful assistant.\n'
  + 'Before acting, decide the task type (build or fix) and adopt the matching '
  + 'style: build → hands-on production; fix → inspect-and-plan.\n'
  + 'Before acting, briefly review what you have already done in this session and continue from where you left off; do not repeat completed steps. Do not run environment checks (echo, whoami, uname, node --version, date) or exhaustive grep/glob scans.\n'
  + 'Think deeply first, then produce.'

export const COGNITION_SECTION = `
## Cognition Protocol (J-Space + oh-we-need)

You have an inner workspace. Use it deliberately and keep it small.

- Three registers: inner (dense, private), ledger (short durable state), outer (clean, user-facing).
- Gate: fast = one glance; full = one bounded deliverable; loop = multiple stages, files, turns, or persistent state.
- Keep one or two live ideas. Externalize durable constraints to the ledger.
- Mark inner claims: ✓ verified with a named verifier, ? asserted but not yet usable, ✗ refuted with evidence.
- Every dense line must expand back into plain language on demand.
- For DeepSeek V4 reasoning, open steps with "we need to ..." or "we need ..."; interleave I'll / I can / I need / I should / I will / I'm. Prefer one concrete action per sentence. Avoid "let me ...".
- Before delivery: read the goal back line by line, name what was not checked, then stop.
`.trim()

const CHAT_RE = /^(你好|您好|hello|hi|hey|嗨|哈喽|在吗|谢谢|感谢|thanks|thank you|早上好|下午好|晚上好|嗯|好|ok|okay|yes|no|嗯嗯|好的)[!。.!？?~～]*$/i
const LOOP_RE = /(多阶段|多个文件|多轮|长程|长期|仓库级|跨文件|系统化|完整项目|长时|agentic|long-horizon|multi-stage|multi-file|multi-turn|repository-wide|workflow|loop)/i
const REACT_RE = /(开发|创建|写一个|写|生成|从零|做|做一个|做个|游戏|网页|网站|构建|新项目|搭建|实现|做出|上线|落地|脚本|工具|应用|build|create|develop|generate|implement|write a|write an|build a|make a|new project)/gi
const SPEC_RE = /(修复|修一下|调试|重构|维护|排查|报错|出错|崩溃|优化|审查|review|fix|debug|refactor|maintain|repair|broken|break|为什么|异常|故障|迁移|升级|兼容)/gi
const COMPLEX_RE = /(重构|架构|全面|详细|设计|系统|优化|分析|survey|overview|architecture|refactor|comprehensive|detailed|design|system|optimize|analyze)/i

export function isFlashModel(modelId) {
  return typeof modelId === 'string' && /flash/i.test(modelId)
}

export function isComplexTask(text) {
  return typeof text === 'string' && (text.length > 120 || COMPLEX_RE.test(text))
}

export function isChatTask(text) {
  if (typeof text !== 'string') return true
  const t = text.trim()
  if (t.length === 0) return true
  if (CHAT_RE.test(t)) return true
  if (t.length > 24) return false
  if (COMPLEX_RE.test(t)) return false
  return !t.match(REACT_RE) && !t.match(SPEC_RE)
}

export function isLoopTask(text) {
  if (typeof text !== 'string') return false
  if (text.length > 1800) return true
  return LOOP_RE.test(text)
}

function countHits(regex, text) {
  if (typeof text !== 'string') return 0
  return [...text.matchAll(regex)].length
}

export function classifyTask(text) {
  const react = countHits(REACT_RE, text)
  const spec = countHits(SPEC_RE, text)
  if (react > spec) return MODE_REACT
  if (spec > react) return MODE_SPEC
  return MODE_WEAK
}

export function sessionMode(session) {
  const events = session?.events ?? []
  const userMsg = events.find((e) => e.type === 'user/message')
  return classifyTask(extractText(userMsg?.data))
}

export function extractText(data) {
  if (!data) return ''
  const payload = data && typeof data.message === 'object' && data.message !== null ? data.message : data
  const content = Array.isArray(payload.content) ? payload.content : []
  return content.map((c) => (typeof c === 'string' ? c : (c.text ?? ''))).join(' ')
}

export function clamp01(v) {
  return Math.min(1, Math.max(0, Number(v) || 0))
}

export function bandOf(mode) {
  if (mode === MODE_WEAK) return 'weak'
  const m = clamp01(mode)
  if (m < 0.2) return 'spec'
  if (m < 0.5) return 'transition'
  return 'react'
}

export function bandFor(mode) {
  const b = bandOf(mode)
  return b === 'transition' ? 'mixed' : b
}

export function personaFor(mode, modelId) {
  switch (bandOf(mode)) {
    case 'spec': return SPEC_PERSONA
    case 'transition': return MIXED_PERSONA
    case 'weak': return isFlashModel(modelId) ? WEAK_FLASH : WEAK_PRO
    default: return REACT_PERSONA
  }
}

export function coreFor(mode) {
  switch (bandOf(mode)) {
    case 'spec': return ['read', 'edit', 'glob', 'grep']
    case 'transition': return ['read', 'edit', 'write', 'glob', 'grep']
    case 'weak': return ['str_replace_editor']
    default: return ['read', 'write', 'edit']
  }
}

export function testinessFor(mode) {
  switch (bandOf(mode)) {
    case 'react': return 'suppressed'
    case 'spec': return 'normal'
    default: return 'light'
  }
}

export function applyPersona(sections, personaText) {
  const rest = (sections || []).filter(
    (section) => section.name !== 'persona' && !/persona/i.test(section.name),
  )
  return [...rest, { name: 'router-persona', text: personaText, order: 0 }]
}

export function addCognitionSection(sections) {
  const without = (sections || []).filter((s) => s.name !== 'cognition-protocol')
  return [...without, { name: 'cognition-protocol', text: COGNITION_SECTION, order: 50 }]
}

export function passFor(text) {
  if (isChatTask(text)) return PASS_FAST
  if (isLoopTask(text)) return PASS_LOOP
  if (isComplexTask(text)) return PASS_FULL
  const t = (text || '').trim()
  if (t.length < 60 && !t.match(REACT_RE) && !t.match(SPEC_RE) && !COMPLEX_RE.test(t)) return PASS_FAST
  return PASS_FULL
}

export function modulesFor(pass, text) {
  if (pass === PASS_FAST) return []
  if (pass === PASS_LOOP) return ['capacity', 'broadcast', 'markers', 'self-monitoring']
  const react = countHits(REACT_RE, text)
  const spec = countHits(SPEC_RE, text)
  if (spec > react) return ['introspection', 'markers']
  if (react > spec) return ['directed-focus', 'empirics']
  return ['deep-reasoning', 'self-monitoring']
}

export function guideFor({ round, text, modelId, mode, pass, modules }) {
  const fresh = round >= 3
    ? '\n\nRouter: this is a NEW task, different from the previous ones. Classify it fresh (build or fix) and do not follow the previous task\'s style.'
    : '\n\nRouter: classify this task (build or fix) now, then adopt the matching style — build: direct production; fix: inspect-first.'
  const passText = ` J-space pass: ${pass}.`
  const moduleText = modules.length ? ` Load: ${modules.join(', ')}.` : ''
  if (!isComplexTask(text)) {
    return fresh + passText + moduleText + ' We need one concrete next action; I will produce now.'
  }
  const deep = ' We need to think deeply about the architecture, edge cases, and integration points. Do not spend reasoning on the environment or tooling. I will produce when information is complete.'
  const closure = isFlashModel(modelId) ? '' : ' End each reasoning block with a decision or an information need.'
  return fresh + passText + moduleText + deep + closure
}

export function parseMode(token) {
  if (token === undefined || token === null) return null
  const t = String(token).trim().toLowerCase()
  if (t === 'auto') return 'auto'
  if (t === 'weak' || t === 'router') return MODE_WEAK
  if (t === 'spec' || t === 'spec-lean') return MODE_SPEC
  if (t === 'balanced' || t === 'mixed') return MODE_MIXED
  if (t === 'react' || t === 'react-lean') return MODE_REACT
  const n = Number(t)
  if (!Number.isFinite(n)) return null
  if (t.includes('.')) return clamp01(n)
  return clamp01(n / 100)
}

export function fmtMode(mode) {
  return typeof mode === 'string' ? mode : mode.toFixed(2)
}
