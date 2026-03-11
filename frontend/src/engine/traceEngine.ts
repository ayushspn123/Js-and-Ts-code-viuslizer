import { Parser } from 'expr-eval'
import type {
  DataStructureSnapshot,
  EventLoopQueueItemSnapshot,
  ExecutionTrace,
  HeapEntrySnapshot,
  RuntimeVariable,
  StackFrameSnapshot,
  SupportedLanguage,
  TraceSnapshot,
} from '../types'

type RuntimeFrame = {
  name: string
  line: number
  vars: RuntimeVariable[]
}

type FunctionDef = {
  name: string
  params: string[]
  start: number
  end: number
}

type HeapEntry = {
  address: string
  type: string
  value: unknown
  owner: string
}

type ScheduledTask = EventLoopQueueItemSnapshot & {
  callbackCode: string
}

type RuntimeState = {
  lines: string[]
  callStack: RuntimeFrame[]
  functions: Map<string, FunctionDef>
  heap: HeapEntry[]
  snapshots: TraceSnapshot[]
  diagnostics: { line: number; message: string }[]
  parser: Parser
  addressCounter: number
  language: SupportedLanguage
  taskCounter: number
  eventLoop: {
    enabled: boolean
    phase: string
    currentTask: string
    webApis: ScheduledTask[]
    microtasks: ScheduledTask[]
    macrotasks: ScheduledTask[]
    logs: string[]
  }
}

function nextAddress(state: RuntimeState): string {
  state.addressCounter += 16
  return `0x${state.addressCounter.toString(16)}`
}

function nextTaskId(state: RuntimeState): string {
  state.taskCounter += 1
  return `task-${state.taskCounter}`
}

function cloneVariable(variable: RuntimeVariable): RuntimeVariable {
  return { ...variable }
}

function cloneQueueItem(task: ScheduledTask): EventLoopQueueItemSnapshot {
  return {
    id: task.id,
    label: task.label,
    source: task.source,
    line: task.line,
    status: task.status,
    delay: task.delay,
  }
}

function frameToSnapshot(frame: RuntimeFrame): StackFrameSnapshot {
  return {
    name: frame.name,
    line: frame.line,
    variables: frame.vars.map(cloneVariable),
  }
}

function stringifyValue(value: unknown): string {
  if (typeof value === 'string') {
    return value
  }

  if (Array.isArray(value) || (value && typeof value === 'object')) {
    return JSON.stringify(value)
  }

  return String(value)
}

function buildStructures(state: RuntimeState): DataStructureSnapshot[] {
  const structures: DataStructureSnapshot[] = []

  for (const heapEntry of state.heap) {
    if (Array.isArray(heapEntry.value)) {
      structures.push({
        name: heapEntry.owner,
        type: 'array',
        address: heapEntry.address,
        preview: JSON.stringify(heapEntry.value),
      })
      continue
    }

    if (heapEntry.value && typeof heapEntry.value === 'object') {
      structures.push({
        name: heapEntry.owner,
        type: heapEntry.type.includes('struct') ? 'struct' : 'object',
        address: heapEntry.address,
        preview: JSON.stringify(heapEntry.value),
      })
    }
  }

  return structures
}

function buildInsights(state: RuntimeState): TraceSnapshot['insights'] {
  const activeFrame = state.callStack[state.callStack.length - 1]
  const liveVariables = state.callStack.flatMap((frame) => frame.vars).length
  const references = state.callStack.flatMap((frame) => frame.vars).filter((variable) => variable.pointsTo).length

  return [
    { label: 'Execution Phase', value: state.eventLoop.phase },
    { label: 'Current Task', value: state.eventLoop.currentTask },
    { label: 'Active Scope', value: activeFrame?.name ?? 'none' },
    { label: 'Live Variables', value: String(liveVariables) },
    {
      label: 'Queues',
      value: `${state.eventLoop.microtasks.length} micro / ${state.eventLoop.macrotasks.length} macro / ${state.eventLoop.webApis.length} web`,
    },
    { label: 'References', value: String(references) },
  ]
}

function pushSnapshot(state: RuntimeState, line: number, explanation: string): void {
  const callStack = state.callStack.map(frameToSnapshot)
  const stackMemory = state.callStack.map(frameToSnapshot)

  const heapMemory: HeapEntrySnapshot[] = state.heap.map((entry) => ({
    address: entry.address,
    type: entry.type,
    value: stringifyValue(entry.value),
  }))

  state.snapshots.push({
    line,
    explanation,
    callStack,
    stackMemory,
    heapMemory,
    structures: buildStructures(state),
    eventLoop: {
      enabled: state.eventLoop.enabled,
      phase: state.eventLoop.phase,
      currentTask: state.eventLoop.currentTask,
      webApis: state.eventLoop.webApis.map(cloneQueueItem),
      microtasks: state.eventLoop.microtasks.map(cloneQueueItem),
      macrotasks: state.eventLoop.macrotasks.map(cloneQueueItem),
      logs: [...state.eventLoop.logs],
    },
    insights: buildInsights(state),
  })
}

function splitArguments(raw: string): string[] {
  const args: string[] = []
  let current = ''
  let depth = 0

  for (const char of raw) {
    if (char === ',' && depth === 0) {
      if (current.trim()) {
        args.push(current.trim())
      }
      current = ''
      continue
    }

    if (char === '[' || char === '{' || char === '(') {
      depth += 1
    }

    if (char === ']' || char === '}' || char === ')') {
      depth -= 1
    }

    current += char
  }

  if (current.trim()) {
    args.push(current.trim())
  }

  return args
}

function parseObjectLiteral(raw: string, state: RuntimeState): Record<string, unknown> {
  const body = raw.trim().replace(/^\{/, '').replace(/\}$/, '')
  if (!body.trim()) {
    return {}
  }

  const pairs = splitArguments(body)
  const out: Record<string, unknown> = {}

  for (const pair of pairs) {
    const [left, right] = pair.split(':')
    if (!left || !right) {
      continue
    }

    const key = left.trim().replace(/^['\"]/, '').replace(/['\"]$/, '')
    out[key] = evaluateExpression(state, right.trim())
  }

  return out
}

function parseArrayLiteral(raw: string, state: RuntimeState): unknown[] {
  const body = raw.trim().replace(/^\[/, '').replace(/\]$/, '')
  if (!body.trim()) {
    return []
  }

  return splitArguments(body).map((part) => evaluateExpression(state, part.trim()))
}

function getVisibleScope(state: RuntimeState): Record<string, unknown> {
  const vars: Record<string, unknown> = {}

  for (const frame of state.callStack) {
    for (const variable of frame.vars) {
      const numeric = Number(variable.value)
      if (!Number.isNaN(numeric)) {
        vars[variable.name] = numeric
        continue
      }

      if (variable.value === 'true' || variable.value === 'false') {
        vars[variable.name] = variable.value === 'true'
        continue
      }

      vars[variable.name] = variable.value
    }
  }

  return vars
}

function findVariable(state: RuntimeState, name: string): RuntimeVariable | undefined {
  for (let index = state.callStack.length - 1; index >= 0; index -= 1) {
    const found = state.callStack[index].vars.find((variable) => variable.name === name)
    if (found) {
      return found
    }
  }

  return undefined
}

function evaluateExpression(state: RuntimeState, rawExpression: string): unknown {
  const expression = rawExpression.trim().replace(/;$/, '')

  if (!expression) {
    return 0
  }

  if (expression === 'null') {
    return 'null'
  }

  if (/^['\"].*['\"]$/.test(expression)) {
    return expression.slice(1, -1)
  }

  if (expression === 'true' || expression === 'false') {
    return expression === 'true'
  }

  if (/^-?\d+(\.\d+)?$/.test(expression)) {
    return Number(expression)
  }

  if (expression.startsWith('&')) {
    const target = findVariable(state, expression.slice(1).trim())
    return target?.address ?? 'null'
  }

  if (expression.startsWith('*')) {
    const pointer = findVariable(state, expression.slice(1).trim())
    if (pointer?.pointsTo) {
      const target = state.callStack
        .flatMap((frame) => frame.vars)
        .find((candidate) => candidate.address === pointer.pointsTo)
      if (target) {
        const numeric = Number(target.value)
        return Number.isNaN(numeric) ? target.value : numeric
      }
    }
  }

  if (expression.startsWith('[') && expression.endsWith(']')) {
    return parseArrayLiteral(expression, state)
  }

  if (expression.startsWith('{') && expression.endsWith('}')) {
    return parseObjectLiteral(expression, state)
  }

  const direct = findVariable(state, expression)
  if (direct) {
    const numeric = Number(direct.value)
    return Number.isNaN(numeric) ? direct.value : numeric
  }

  try {
    return state.parser.evaluate(expression, getVisibleScope(state) as never)
  } catch {
    return expression
  }
}

function detectType(statement: string, language: SupportedLanguage): string {
  const tsType = statement.match(/:\s*([^=;]+)/)
  if (tsType && language === 'typescript') {
    return tsType[1].trim()
  }

  const jsDecl = statement.match(/^\s*(let|var|const)\s+/)
  if (jsDecl) {
    return jsDecl[1]
  }

  const cDecl = statement.match(/^\s*([A-Za-z_][\w:]*(?:\s*\*)?)\s+[A-Za-z_][\w]*\s*(?:[=\[]|;)/)
  if (cDecl) {
    return cDecl[1].trim()
  }

  return language === 'typescript' ? 'typed' : 'auto'
}

function setVariableValue(state: RuntimeState, variable: RuntimeVariable, rawValue: unknown): void {
  if (Array.isArray(rawValue) || (rawValue && typeof rawValue === 'object')) {
    const address = nextAddress(state)
    variable.kind = 'reference'
    variable.pointsTo = address
    variable.value = address

    state.heap.push({
      address,
      type: variable.type,
      value: rawValue,
      owner: variable.name,
    })
    return
  }

  variable.value = stringifyValue(rawValue)
}

function declareVariable(
  state: RuntimeState,
  frame: RuntimeFrame,
  name: string,
  type: string,
  initialValue: unknown,
  line: number,
): void {
  const variable: RuntimeVariable = {
    name,
    type,
    value: '0',
    address: nextAddress(state),
    scope: frame.name,
    kind: 'primitive',
  }

  if (typeof initialValue === 'string' && /^0x[0-9a-f]+$/i.test(initialValue)) {
    variable.kind = 'pointer'
    variable.pointsTo = initialValue
    variable.value = initialValue
  } else {
    setVariableValue(state, variable, initialValue)
  }

  frame.vars.push(variable)
  pushSnapshot(state, line, `Created ${name} in ${frame.name} scope with value ${variable.value}.`)
}

function assignVariable(state: RuntimeState, variable: RuntimeVariable, value: unknown, line: number): void {
  if (variable.kind === 'pointer' && typeof value === 'string' && /^0x[0-9a-f]+$/i.test(value)) {
    variable.pointsTo = value
    variable.value = value
  } else {
    setVariableValue(state, variable, value)
  }

  pushSnapshot(state, line, `Updated ${variable.name} to ${variable.value}.`)
}

function executeDereferenceWrite(state: RuntimeState, pointerName: string, rawValue: string, line: number): void {
  const pointer = findVariable(state, pointerName)
  if (!pointer || !pointer.pointsTo) {
    state.diagnostics.push({ line, message: `Pointer ${pointerName} does not reference a valid address.` })
    return
  }

  const target = state.callStack
    .flatMap((frame) => frame.vars)
    .find((candidate) => candidate.address === pointer.pointsTo)

  if (!target) {
    state.diagnostics.push({ line, message: `No variable found at address ${pointer.pointsTo}.` })
    return
  }

  const value = evaluateExpression(state, rawValue)
  target.value = stringifyValue(value)
  pushSnapshot(
    state,
    line,
    `Dereferenced ${pointerName} and wrote ${target.value} into ${target.name} at ${target.address}.`,
  )
}

function parseFunctionDefinitions(lines: string[]): Map<string, FunctionDef> {
  const functions = new Map<string, FunctionDef>()
  const stack: { name: string; start: number; params: string[] }[] = []

  for (let index = 0; index < lines.length; index += 1) {
    const lineNumber = index + 1
    const line = lines[index].trim()

    const jsMatch = line.match(/^function\s+([A-Za-z_][\w]*)\s*\(([^)]*)\)\s*(?::\s*[^\{]+)?\{\s*$/)
    const cMatch = line.match(
      /^(?!if\b|for\b|while\b|switch\b)(?:[A-Za-z_][\w:*<>\s]*\s+)+([A-Za-z_][\w]*)\s*\(([^)]*)\)\s*\{\s*$/,
    )

    const selected = jsMatch ?? cMatch
    if (selected) {
      const name = selected[1]
      const params = selected[2]
        .split(',')
        .map((part) => part.trim())
        .filter(Boolean)
        .map((part) => {
          const cleaned = part.includes(':') ? part.split(':')[0].trim() : part
          const sections = cleaned.split(/\s+/)
          return sections[sections.length - 1].replace(/[*&]/g, '')
        })
      stack.push({ name, start: lineNumber, params })
      continue
    }

    if (line === '}' && stack.length) {
      const def = stack.pop()!
      functions.set(def.name, {
        name: def.name,
        params: def.params,
        start: def.start,
        end: lineNumber,
      })
    }
  }

  return functions
}

function insideFunction(line: number, functions: Map<string, FunctionDef>): boolean {
  return [...functions.values()].some((fn) => line >= fn.start && line <= fn.end)
}

function invokeFunction(state: RuntimeState, fnName: string, argsRaw: string, callLine: number): unknown {
  const def = state.functions.get(fnName)
  if (!def) {
    state.diagnostics.push({ line: callLine, message: `Function ${fnName} is not defined in this program.` })
    return 0
  }

  const argValues = splitArguments(argsRaw).map((arg) => evaluateExpression(state, arg))
  const frame: RuntimeFrame = {
    name: fnName,
    line: def.start,
    vars: [],
  }

  for (let index = 0; index < def.params.length; index += 1) {
    const paramName = def.params[index]
    const value = argValues[index] ?? 0
    frame.vars.push({
      name: paramName,
      type: 'param',
      value: stringifyValue(value),
      address: nextAddress(state),
      scope: fnName,
      kind: 'primitive',
    })
  }

  state.callStack.push(frame)
  pushSnapshot(state, callLine, `Called ${fnName} and pushed a new frame on the stack.`)

  let returnValue: unknown = 0
  for (let lineNumber = def.start + 1; lineNumber < def.end; lineNumber += 1) {
    const signal = executeStatement(state, lineNumber)
    if (signal?.returned) {
      returnValue = signal.value
      break
    }
  }

  state.callStack.pop()
  pushSnapshot(state, callLine, `Returned from ${fnName}; frame popped from the call stack.`)

  return returnValue
}

function scheduleTask(
  state: RuntimeState,
  target: 'webApis' | 'microtasks' | 'macrotasks',
  task: Omit<ScheduledTask, 'id' | 'status'>,
  status: string,
  explanation: string,
): void {
  state.eventLoop[target].push({
    ...task,
    id: nextTaskId(state),
    status,
  })
  pushSnapshot(state, task.line, explanation)
}

function handleConsoleLog(state: RuntimeState, argsRaw: string, lineNumber: number): void {
  const rendered = splitArguments(argsRaw)
    .map((item) => stringifyValue(evaluateExpression(state, item)))
    .join(' ')
  state.eventLoop.logs.push(`[line ${lineNumber}] ${rendered}`)
  pushSnapshot(state, lineNumber, `console.log appended "${rendered}" to the output log.`)
}

function executeQueuedCallback(state: RuntimeState, task: ScheduledTask): void {
  const callMatch = task.callbackCode.match(/^([A-Za-z_][\w]*)\((.*)\)$/)
  const consoleMatch = task.callbackCode.match(/^console\.log\((.*)\)$/)

  if (callMatch && state.functions.has(callMatch[1])) {
    invokeFunction(state, callMatch[1], callMatch[2], task.line)
    pushSnapshot(state, task.line, `${task.label} finished running. The event loop will inspect the queues again.`)
    return
  }

  if (consoleMatch) {
    handleConsoleLog(state, consoleMatch[1], task.line)
    pushSnapshot(state, task.line, `${task.label} finished after producing console output.`)
    return
  }

  state.diagnostics.push({
    line: task.line,
    message: `Queued callback could not be interpreted: ${task.callbackCode}`,
  })
  pushSnapshot(state, task.line, `The queued callback ${task.label} was recognized, but its body is outside the supported subset.`)
}

function promoteReadyWebApiTasks(state: RuntimeState, lineNumber: number): void {
  if (state.eventLoop.webApis.length === 0) {
    return
  }

  const readyTasks = state.eventLoop.webApis.splice(0)
  for (const task of readyTasks) {
    state.eventLoop.macrotasks.push({
      ...task,
      source: 'macrotask',
      status: 'queued',
    })
  }

  pushSnapshot(
    state,
    lineNumber,
    'The call stack is clear, so completed Web API timers move into the macrotask queue and wait for their turn.',
  )
}

function flushEventLoop(state: RuntimeState, lineNumber: number): void {
  if (!state.eventLoop.enabled) {
    return
  }

  promoteReadyWebApiTasks(state, lineNumber)

  while (state.eventLoop.microtasks.length > 0 || state.eventLoop.macrotasks.length > 0) {
    while (state.eventLoop.microtasks.length > 0) {
      const task = state.eventLoop.microtasks.shift()!
      state.eventLoop.phase = 'microtask checkpoint'
      state.eventLoop.currentTask = task.label
      pushSnapshot(
        state,
        task.line,
        `The event loop picks microtask ${task.label} before any macrotask because microtasks always flush first.`,
      )
      executeQueuedCallback(state, task)
    }

    if (state.eventLoop.macrotasks.length > 0) {
      const task = state.eventLoop.macrotasks.shift()!
      state.eventLoop.phase = 'macrotask turn'
      state.eventLoop.currentTask = task.label
      pushSnapshot(
        state,
        task.line,
        `The event loop starts macrotask ${task.label}. This runs only after the microtask queue is empty.`,
      )
      executeQueuedCallback(state, task)
    }
  }

  state.eventLoop.phase = state.language === 'javascript' || state.language === 'typescript' ? 'idle' : 'native trace'
  state.eventLoop.currentTask = 'idle'
}

function executeStatement(
  state: RuntimeState,
  lineNumber: number,
): { returned: true; value: unknown } | { returned: false } | null {
  const rawLine = state.lines[lineNumber - 1]
  const line = rawLine.trim()
  const currentFrame = state.callStack[state.callStack.length - 1]

  if (!currentFrame) {
    return null
  }

  currentFrame.line = lineNumber

  if (!line || line.startsWith('//') || line.startsWith('#include') || line.startsWith('using ')) {
    return null
  }

  const promiseThen = line.match(/^Promise\.resolve\(\)\.then\(\(\)\s*=>\s*(.+)\)\s*;$/)
  if (promiseThen && state.eventLoop.enabled) {
    scheduleTask(
      state,
      'microtasks',
      {
        label: 'Promise.then callback',
        source: 'microtask',
        line: lineNumber,
        callbackCode: promiseThen[1].trim().replace(/;$/, ''),
      },
      'queued',
      'Promise.resolve().then scheduled a microtask. It will run after the current synchronous script finishes.',
    )
    return { returned: false }
  }

  const queueMicrotaskMatch = line.match(/^queueMicrotask\(\(\)\s*=>\s*(.+)\)\s*;$/)
  if (queueMicrotaskMatch && state.eventLoop.enabled) {
    scheduleTask(
      state,
      'microtasks',
      {
        label: 'queueMicrotask callback',
        source: 'microtask',
        line: lineNumber,
        callbackCode: queueMicrotaskMatch[1].trim().replace(/;$/, ''),
      },
      'queued',
      'queueMicrotask pushed work into the microtask queue. It will run before timers in the macrotask queue.',
    )
    return { returned: false }
  }

  const setTimeoutMatch = line.match(/^setTimeout\(\(\)\s*=>\s*(.+)\s*,\s*(\d+)\)\s*;$/)
  if (setTimeoutMatch && state.eventLoop.enabled) {
    scheduleTask(
      state,
      'webApis',
      {
        label: `setTimeout callback (${setTimeoutMatch[2]}ms)` ,
        source: 'web-api',
        line: lineNumber,
        delay: Number(setTimeoutMatch[2]),
        callbackCode: setTimeoutMatch[1].trim().replace(/;$/, ''),
      },
      'waiting',
      'setTimeout registered a timer with the Web APIs. The callback waits there until it can be queued as a macrotask.',
    )
    return { returned: false }
  }

  const consoleMatch = line.match(/^console\.log\((.*)\)\s*;$/)
  if (consoleMatch) {
    handleConsoleLog(state, consoleMatch[1], lineNumber)
    return { returned: false }
  }

  if (line.startsWith('return ')) {
    const value = evaluateExpression(state, line.replace(/^return\s+/, '').replace(/;$/, ''))
    pushSnapshot(state, lineNumber, `Function returned ${stringifyValue(value)}.`)
    return { returned: true, value }
  }

  const derefWrite = line.match(/^\*([A-Za-z_][\w]*)\s*=\s*(.+);$/)
  if (derefWrite) {
    executeDereferenceWrite(state, derefWrite[1], derefWrite[2], lineNumber)
    return { returned: false }
  }

  const typedDeclarationWithCall = line.match(
    /^(?:const\s+|let\s+|var\s+|(?:[A-Za-z_][\w:*<>\s]*\s+)+)([A-Za-z_][\w]*)\s*(?::\s*[^=]+)?\s*=\s*([A-Za-z_][\w]*)\((.*)\)\s*;$/,
  )
  if (typedDeclarationWithCall && state.functions.has(typedDeclarationWithCall[2])) {
    const variableName = typedDeclarationWithCall[1]
    const fnName = typedDeclarationWithCall[2]
    const argsRaw = typedDeclarationWithCall[3]
    const value = invokeFunction(state, fnName, argsRaw, lineNumber)
    const type = detectType(line, state.language)
    declareVariable(state, currentFrame, variableName, type, value, lineNumber)
    return { returned: false }
  }

  const declarationArray = line.match(
    /^(?:int|float|double|long|short|char|bool)\s+([A-Za-z_][\w]*)\s*\[(\d+)\]\s*=\s*\{(.+)\};$/,
  )
  if (declarationArray) {
    const arrayValues = splitArguments(declarationArray[3]).map((item) => evaluateExpression(state, item.trim()))
    declareVariable(state, currentFrame, declarationArray[1], 'array', arrayValues, lineNumber)
    return { returned: false }
  }

  const declaration = line.match(
    /^(?:const\s+|let\s+|var\s+|(?:[A-Za-z_][\w:*<>\s]*\s+)+)(\*?)([A-Za-z_][\w]*)\s*(?::\s*[^=]+)?(?:=\s*(.+))?;$/,
  )
  if (declaration) {
    const pointerSymbol = declaration[1]
    const variableName = declaration[2]
    const rhsRaw = declaration[3]
    const type = detectType(line, state.language)

    if (pointerSymbol === '*') {
      const pointerValue = rhsRaw ? evaluateExpression(state, rhsRaw) : 'null'
      declareVariable(state, currentFrame, variableName, `${type} *`, pointerValue, lineNumber)
      const variable = findVariable(state, variableName)
      if (variable) {
        variable.kind = 'pointer'
        variable.pointsTo = typeof pointerValue === 'string' ? pointerValue : undefined
      }
      return { returned: false }
    }

    const value = rhsRaw ? evaluateExpression(state, rhsRaw) : 0
    declareVariable(state, currentFrame, variableName, type, value, lineNumber)
    return { returned: false }
  }

  const assignmentWithCall = line.match(/^([A-Za-z_][\w]*)\s*=\s*([A-Za-z_][\w]*)\((.*)\)\s*;$/)
  if (assignmentWithCall && state.functions.has(assignmentWithCall[2])) {
    const variableName = assignmentWithCall[1]
    const fnName = assignmentWithCall[2]
    const value = invokeFunction(state, fnName, assignmentWithCall[3], lineNumber)
    const variable = findVariable(state, variableName)
    if (!variable) {
      declareVariable(state, currentFrame, variableName, 'auto', value, lineNumber)
      return { returned: false }
    }

    assignVariable(state, variable, value, lineNumber)
    return { returned: false }
  }

  const assignment = line.match(/^([A-Za-z_][\w]*)\s*=\s*(.+);$/)
  if (assignment) {
    const variableName = assignment[1]
    const rhsRaw = assignment[2]
    const variable = findVariable(state, variableName)
    if (!variable) {
      state.diagnostics.push({ line: lineNumber, message: `Variable ${variableName} is not declared before assignment.` })
      return { returned: false }
    }

    assignVariable(state, variable, evaluateExpression(state, rhsRaw), lineNumber)
    return { returned: false }
  }

  const plainCall = line.match(/^([A-Za-z_][\w]*)\((.*)\)\s*;$/)
  if (plainCall && state.functions.has(plainCall[1])) {
    invokeFunction(state, plainCall[1], plainCall[2], lineNumber)
    return { returned: false }
  }

  if (line === '{' || line === '}' || line.startsWith('struct ')) {
    return null
  }

  state.diagnostics.push({ line: lineNumber, message: `Line was not fully interpreted: ${line}` })
  pushSnapshot(state, lineNumber, 'Encountered a statement that is outside the supported subset; trace continues.')
  return { returned: false }
}

export function generateExecutionTrace(code: string, language: SupportedLanguage): ExecutionTrace {
  const lines = code.split('\n')
  const functions = parseFunctionDefinitions(lines)
  const eventLoopEnabled = language === 'javascript' || language === 'typescript'

  const state: RuntimeState = {
    lines,
    callStack: [
      {
        name: 'global',
        line: 1,
        vars: [],
      },
    ],
    functions,
    heap: [],
    snapshots: [],
    diagnostics: [],
    parser: new Parser({ operators: { logical: true, comparison: true } }),
    addressCounter: 4096,
    language,
    taskCounter: 0,
    eventLoop: {
      enabled: eventLoopEnabled,
      phase: eventLoopEnabled ? 'synchronous script' : 'native trace',
      currentTask: eventLoopEnabled ? 'global script' : 'main thread',
      webApis: [],
      microtasks: [],
      macrotasks: [],
      logs: [],
    },
  }

  pushSnapshot(
    state,
    1,
    eventLoopEnabled
      ? 'Execution initialized. The global execution context is on the call stack and the event loop is waiting.'
      : 'Execution initialized. Global frame created.',
  )

  if (language === 'c' || language === 'cpp') {
    for (let lineNumber = 1; lineNumber <= lines.length; lineNumber += 1) {
      if (insideFunction(lineNumber, functions)) {
        continue
      }
      executeStatement(state, lineNumber)
    }

    if (functions.has('main')) {
      invokeFunction(state, 'main', '', functions.get('main')!.start)
    } else {
      state.diagnostics.push({
        line: 1,
        message: 'No main function found. Only global declarations were executed.',
      })
    }
  } else {
    for (let lineNumber = 1; lineNumber <= lines.length; lineNumber += 1) {
      if (insideFunction(lineNumber, functions)) {
        continue
      }
      executeStatement(state, lineNumber)
    }

    flushEventLoop(state, lines.length)
  }

  pushSnapshot(state, lines.length, 'Execution finished. Final memory snapshot captured.')

  return {
    snapshots: state.snapshots,
    diagnostics: state.diagnostics,
  }
}
