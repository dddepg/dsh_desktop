/**
 * router-jspace: 三套插件整合后的 DSH agent-preset 路由插件。
 *
 * 外部路由沿用 dsh-routing-suite 的实测分带；每个真实用户消息后追加
 * near-field 引导，把 J-Space pass/module 与 oh-we-need 的 V4 思维风格
 * 一次带给模型。J-Space 账本由 cog_ledger 持久化到 $DSH_HOME/cognition-ledger/。
 */

import { readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import {
  applyPersona, addCognitionSection, bandFor, classifyTask, clamp01, coreFor,
  extractText, fmtMode, guideFor, isChatTask, modulesFor, parseMode, passFor,
  personaFor, sessionMode,
} from './router-core.mjs'

export const name = 'router-jspace'
export const inject = ['systemPrompt', 'tools', 'llm']

const DSH_HOME = process.env.DSH_HOME || join(homedir(), '.dsh')

function toJsonSchema(spec) {
  const properties = {}
  const required = []
  for (const [key, meta] of Object.entries(spec || {})) {
    const prop = { type: meta.type }
    if (Array.isArray(meta.enum)) prop.enum = meta.enum
    if (meta.description) prop.description = meta.description
    properties[key] = prop
    if (meta.required) required.push(key)
  }
  return { type: 'object', properties, required, additionalProperties: false }
}

export function apply(ctx, config = {}) {
  const overrides = new Map()
  const agents = new Map()
  const firstUserText = new Map()
  const guided = new Map()
  const chat = new Set()

  const ledgerDir = config?.ledgerDir || join(DSH_HOME, 'cognition-ledger')

  function ledgerPath(sessionId) {
    const safe = String(sessionId || 'unknown').replace(/[^a-zA-Z0-9_-]/g, '_')
    return join(ledgerDir, safe + '.json')
  }

  function readLedger(sessionId) {
    try {
      const raw = JSON.parse(readFileSync(ledgerPath(sessionId), 'utf8'))
      return {
        goal: typeof raw?.goal === 'string' ? raw.goal : '',
        core: Array.isArray(raw?.core) ? raw.core : [],
        verified: Array.isArray(raw?.verified) ? raw.verified : [],
        open: Array.isArray(raw?.open) ? raw.open : [],
        next: typeof raw?.next === 'string' ? raw.next : '',
      }
    } catch {
      return { goal: '', core: [], verified: [], open: [], next: '' }
    }
  }

  function writeLedger(sessionId, ledger) {
    mkdirSync(ledgerDir, { recursive: true })
    const target = ledgerPath(sessionId)
    const tmp = target + '.tmp'
    writeFileSync(tmp, JSON.stringify(ledger, null, 2), 'utf8')
    renameSync(tmp, target)
  }

  function splitLines(value) {
    return String(value || '')
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
  }

  function formatLedger(ledger) {
    return [
      `goal: ${ledger.goal || '(空)'}`,
      `core: ${ledger.core.length ? ledger.core.join(' | ') : '(空)'}`,
      `verified: ${ledger.verified.length ? ledger.verified.join(' | ') : '(空)'}`,
      `open: ${ledger.open.length ? ledger.open.join(' | ') : '(空)'}`,
      `next: ${ledger.next || '(空)'}`,
    ].join('\n')
  }

  ctx.on('system-prompt/assemble', async (_assembly, context, next) => {
    const assembled = await next()
    const agent = context.agent
    if (agent === undefined) return assembled
    const session = agent.session
    agents.set(session.id, agent)

    const rawText = firstUserText.get(session.id) ?? sessionMode(session)
    const text = typeof rawText === 'string' ? rawText : ''
    if (text.trim() && isChatTask(text)) {
      chat.add(session.id)
      return assembled
    }
    chat.delete(session.id)

    const mode = overrides.get(session.id) ?? (text || sessionMode(session))
    const modelId = agent.options?.model
    const pass = passFor(text)
    const modules = modulesFor(pass, text)
    const persona = personaFor(mode, modelId)
    const sections = addCognitionSection(applyPersona(assembled.sections, persona))

    if (session.events.some((event) => event.type === 'tool/call')) {
      return { ...assembled, sections, contexts: [] }
    }

    const core = new Set(coreFor(mode))
    const available = new Set(assembled.tools.map((tool) => tool.name))
    const shell = available.has('pwsh') ? 'pwsh' : available.has('bash') ? 'bash' : null
    if (shell === null) {
      throw new Error(`${name}: no platform shell in catalog`)
    }
    core.add(shell)

    return {
      ...assembled,
      sections,
      contexts: [],
      tools: assembled.tools.filter((tool) => core.has(tool.name)),
    }
  })

  ctx.on('session/event', (session, event) => {
    if (event.type !== 'user/message') return
    const data = event.data ?? {}
    if (data.source?.kind !== 'user') return
    const text = extractText(data)
    if (!firstUserText.has(session.id) && text.trim()) {
      firstUserText.set(session.id, text.trim())
    }
    if (text.trim() && isChatTask(text)) {
      chat.add(session.id)
      return
    }
    if (chat.has(session.id)) return
    if (!text.trim()) return
    const agent = ctx.get('agent')
    const target = agent !== undefined && agent.session === session
      ? agent
      : [...agents.values()].find((a) => a.session === session)
    if (target === undefined || target.inbox === undefined) return
    if (guided.get(session.id) === event.id) return

    const mode = overrides.get(session.id) ?? firstUserText.get(session.id) ?? sessionMode(session)
    const pass = passFor(text)
    const modules = modulesFor(pass, text)
    const round = (session.events || []).filter((e) => e.type === 'user/message').length
    const guide = guideFor({
      round,
      text,
      modelId: target.options?.model,
      mode,
      pass,
      modules,
    })
    try {
      target.inbox.append('next-step', {
        id: `router-jspace-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        role: 'user',
        source: { kind: 'plugin', plugin: 'router-jspace' },
        content: [{ type: 'text', text: guide }],
      })
      guided.set(session.id, event.id)
    } catch { /* 注入竞态时跳过 */ }
  })

  const registerTool = (tool) => {
    try {
      ctx.effect(() => ctx.tools.register({
        ...tool,
        parameters: toJsonSchema(tool.parameters),
      }))
    } catch { /* 重复注册时跳过 */ }
  }

  function currentSession() {
    const agent = ctx.get('agent')
    if (agent !== undefined && agent.session !== undefined) return agent.session
    const last = [...agents.values()].at(-1)
    return last?.session
  }

  function currentAgent() {
    const session = currentSession()
    return session === undefined ? undefined : [...agents.values()].find((a) => a.session === session)
  }

  registerTool({
    name: 'dev_router_status',
    description: 'Show this session\'s integrated routing: mode, band, J-space pass, modules, ledger path, and override state.',
    parameters: {},
    output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: v }] },
    execute() {
      const session = currentSession()
      if (session === undefined) return 'no agent session'
      const text = firstUserText.get(session.id) ?? ''
      const mode = overrides.get(session.id) ?? firstUserText.get(session.id) ?? sessionMode(session)
      const pass = passFor(text)
      const modules = modulesFor(pass, text)
      const ledger = readLedger(session.id)
      return [
        `mode=${fmtMode(mode)} (band=${bandFor(mode)})`,
        `j-space pass=${pass} modules=[${modules.join(', ')}]`,
        `ledger=${ledgerPath(session.id)}`,
        `goal=${ledger.goal || '(空)'}`,
        `next=${ledger.next || '(空)'}`,
        `override=${overrides.has(session.id) ? 'yes' : 'no'}`,
      ].join('\n')
    },
  })

  registerTool({
    name: 'dev_router_mode',
    description: 'Set this session\'s reasoning mode: spec (plan-first) / weak (internal routing, model decides per task) / mixed (transition, trap) / react (doer). Use auto to return to task classification. The next request applies it.',
    parameters: {
      mode: {
        type: 'string',
        required: true,
        description: 'spec / weak / mixed / react, 0-100, 0.0-1.0, or auto',
      },
    },
    output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: v }] },
    execute(args) {
      const parsed = parseMode(args.mode)
      if (parsed === null) return `invalid mode "${args.mode}": use spec/weak/mixed/react, 0-100, 0.0-1.0, or auto`
      const session = currentSession()
      if (session === undefined) return 'no agent session'
      if (parsed === 'auto') overrides.delete(session.id)
      else overrides.set(session.id, parsed === 'weak' ? 'weak' : clamp01(parsed))
      const current = overrides.get(session.id) ?? firstUserText.get(session.id) ?? sessionMode(session)
      return `mode=${fmtMode(current)} (band=${bandFor(current)}) — next request applies`
    },
  })

  registerTool({
    name: 'dev_mode_subagent',
    description: 'Run one task in a DIFFERENT reasoning mode, in a fresh isolated context with its own system prompt. The current session trajectory is untouched.',
    parameters: {
      mode: { type: 'string', required: true, description: 'spec / weak / react / balanced (or 0-100)' },
      task: { type: 'string', required: true, description: 'task to run in the isolated mode' },
      maxTokens: { type: 'number', description: 'output cap (default 1024)' },
    },
    output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: v }] },
    async execute(args) {
      const parsed = parseMode(args.mode)
      if (parsed === null || parsed === 'auto') return `invalid mode "${args.mode}"`
      const session = currentSession()
      const agent = session === undefined ? undefined : [...agents.values()].find((a) => a.session === session)
      if (agent === undefined || agent.options === undefined) return 'no agent route available'
      const { provider, model } = agent.options
      if (!provider || !model) return 'agent route missing provider/model'
      const persona = personaFor(parsed, model)
      const maxTokens = Number(args.maxTokens || 1024)
      let text = ''
      let reasoningChars = 0
      try {
        const stream = ctx.llm.stream({
          provider,
          model,
          system: persona,
          messages: [{ role: 'user', content: [{ type: 'text', text: String(args.task) }] }],
          maxTokens,
        })
        for await (const chunk of stream) {
          if (chunk.type === 'text-delta') text += chunk.text
          else if (chunk.type === 'reasoning-delta') reasoningChars += chunk.text.length
        }
      } catch (error) {
        return `subagent error: ${error && error.message ? error.message : String(error)}`
      }
      const head = text.slice(0, 3000)
      return `[mode-subagent ${bandFor(parsed)} | reasoning ${reasoningChars} chars]\n${head}${text.length > 3000 ? '\n…(truncated)' : ''}`
    },
  })

  registerTool({
    name: 'cog_ledger',
    description: 'Maintain the J-space ledger. action=update/read/ship/clear; goal and next are one line; core, verified and open accept multiple lines.',
    parameters: {
      action: { type: 'string', enum: ['update', 'read', 'ship', 'clear'], description: 'ledger operation' },
      goal: { type: 'string', description: 'one-line goal' },
      core: { type: 'string', description: 'one entry per line' },
      verified: { type: 'string', description: 'one verified checkpoint per line, with verifier/coverage' },
      open: { type: 'string', description: 'one open question per line, with what would settle it' },
      next: { type: 'string', description: 'single next action' },
    },
    output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: v }] },
    execute(args) {
      const session = currentSession()
      if (session === undefined) return 'no agent session'
      const action = args.action || 'update'
      const ledger = readLedger(session.id)
      if (action === 'read') return formatLedger(ledger)
      if (action === 'clear') {
        writeLedger(session.id, { goal: '', core: [], verified: [], open: [], next: '' })
        return 'J-space ledger cleared'
      }
      if (action === 'ship') {
        if (!ledger.goal) return 'ledger.goal is empty — record a goal before ship'
        return `Ship check: read the goal line by line; mark each line met/partly/not met; name what was not checked; do not finish unless the goal is fully met.\n\nGoal:\n${ledger.goal}`
      }
      if (typeof args.goal === 'string' && args.goal.trim()) ledger.goal = args.goal.trim()
      if (typeof args.next === 'string' && args.next.trim()) ledger.next = args.next.trim()
      if (typeof args.core === 'string') ledger.core = splitLines(args.core)
      if (typeof args.verified === 'string') ledger.verified = splitLines(args.verified)
      if (typeof args.open === 'string') ledger.open = splitLines(args.open)
      writeLedger(session.id, ledger)
      return formatLedger(ledger)
    },
  })

  ctx.logger?.info?.('[router-jspace] active')
}
