export type SupportedLanguage = 'javascript' | 'typescript' | 'c' | 'cpp'

export type VariableKind = 'primitive' | 'pointer' | 'reference'

export interface RuntimeVariable {
  name: string
  type: string
  value: string
  address: string
  scope: string
  kind: VariableKind
  pointsTo?: string
}

export interface StackFrameSnapshot {
  name: string
  line: number
  variables: RuntimeVariable[]
}

export interface HeapEntrySnapshot {
  address: string
  type: string
  value: string
}

export interface DataStructureSnapshot {
  name: string
  type: 'array' | 'object' | 'struct'
  address: string
  preview: string
}

export interface EventLoopQueueItemSnapshot {
  id: string
  label: string
  source: 'web-api' | 'microtask' | 'macrotask'
  line: number
  status: string
  delay?: number
}

export interface EventLoopSnapshot {
  enabled: boolean
  phase: string
  currentTask: string
  webApis: EventLoopQueueItemSnapshot[]
  microtasks: EventLoopQueueItemSnapshot[]
  macrotasks: EventLoopQueueItemSnapshot[]
  logs: string[]
}

export interface StepInsight {
  label: string
  value: string
}

export interface TraceSnapshot {
  line: number
  explanation: string
  callStack: StackFrameSnapshot[]
  stackMemory: StackFrameSnapshot[]
  heapMemory: HeapEntrySnapshot[]
  structures: DataStructureSnapshot[]
  eventLoop: EventLoopSnapshot
  insights: StepInsight[]
}

export interface TraceDiagnostic {
  line: number
  message: string
}

export interface ExecutionTrace {
  snapshots: TraceSnapshot[]
  diagnostics: TraceDiagnostic[]
}

export interface LanguagePreset {
  title: string
  code: string
}
