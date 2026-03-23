import { useEffect, useMemo, useRef, useState } from 'react'
import { motion } from 'framer-motion'
import Editor from '@monaco-editor/react'
import type { editor } from 'monaco-editor'
import { Parser } from 'expr-eval'
import { ModuleKind, ScriptTarget, transpileModule } from 'typescript'
import './App.css'
import { languagePresets } from './data/presets'
import { generateExecutionTrace } from './engine/traceEngine'
import type { ExecutionTrace, RuntimeVariable, SupportedLanguage } from './types'

type RunSummary = {
  id: number
  timestamp: string
  language: SupportedLanguage
  steps: number
  diagnostics: number
  maxStackDepth: number
  uniqueLines: number
  variableMutations: number
  microtasksScheduled: number
  macrotasksScheduled: number
  codeHash: string
}

type VariableTransition = {
  step: number
  line: number
  address: string
  name: string
  scope: string
  from: string
  to: string
}

type TraceMilestone = {
  step: number
  line: number
  headline: string
  detail: string
}

type TraceRun = {
  id: number
  summary: RunSummary
  trace: ExecutionTrace
}

type OnboardingTourStep = {
  title: string
  body: string
  target: 'editor' | 'controls' | 'visual' | 'compare' | 'lanes'
}

const onboardingTourSteps: OnboardingTourStep[] = [
  {
    title: 'Welcome to Cinematic Mode',
    body: 'This workspace turns code execution into a guided story. Start with Run, then move through the timeline and watch memory evolve.',
    target: 'controls',
  },
  {
    title: 'Editor Heat + Runtime Focus',
    body: 'The editor highlights active execution and hot paths. Keep heatmap enabled when hunting loops and hotspots.',
    target: 'editor',
  },
  {
    title: 'Split Trace Comparison',
    body: 'Enable compare mode to inspect two runs side-by-side. One scrubber drives both timelines so differences appear immediately.',
    target: 'compare',
  },
  {
    title: 'Performance Lanes',
    body: 'Lane sparklines expose frame pressure per function over time. Badges call out recursion, burstiness, and high occupancy.',
    target: 'lanes',
  },
  {
    title: 'Contextual Tips',
    body: 'Tips update based on your current state and anomalies so you always know the next useful debugging action.',
    target: 'visual',
  },
]

function buildSparklinePoints(samples: number[], width = 160, height = 34): string {
  if (samples.length === 0) {
    return ''
  }

  const max = Math.max(...samples, 1)
  const stepX = samples.length > 1 ? width / (samples.length - 1) : width
  return samples
    .map((value, index) => {
      const x = index * stepX
      const y = height - (value / max) * height
      return `${x.toFixed(2)},${y.toFixed(2)}`
    })
    .join(' ')
}

type ExecutionMode = 'trace' | 'instant'

type InstantRunState = {
  status: 'idle' | 'running' | 'success' | 'error' | 'timeout'
  output: string[]
  durationMs: number | null
  error: string | null
}

const INSTANT_RUN_TIMEOUT_MS = 3500

function compileForInstantRun(code: string, language: SupportedLanguage): string | null {
  if (language === 'javascript') {
    return code
  }

  if (language === 'typescript') {
    return transpileModule(code, {
      compilerOptions: {
        target: ScriptTarget.ES2021,
        module: ModuleKind.ESNext,
      },
      reportDiagnostics: false,
    }).outputText
  }

  return null
}

async function runInstantInWorker(code: string, timeoutMs: number): Promise<{
  timedOut: boolean
  output: string[]
  durationMs: number
  error: string | null
}> {
  const workerSource = `
    self.onmessage = async (event) => {
      const code = event.data?.code ?? '';
      const startedAt = Date.now();
      const logs = [];

      const serialize = (value) => {
        if (typeof value === 'string') {
          return value;
        }

        try {
          return JSON.stringify(value);
        } catch {
          return String(value);
        }
      };

      const emit = (...args) => {
        logs.push(args.map(serialize).join(' '));
      };

      const consoleProxy = {
        log: (...args) => emit(...args),
        info: (...args) => emit(...args),
        warn: (...args) => emit(...args),
        error: (...args) => emit(...args),
      };

      try {
        const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
        const run = new AsyncFunction('console', code);
        await run(consoleProxy);
        self.postMessage({ type: 'done', logs, durationMs: Date.now() - startedAt });
      } catch (error) {
        self.postMessage({
          type: 'error',
          logs,
          durationMs: Date.now() - startedAt,
          error: error && error.message ? error.message : String(error),
        });
      }
    };
  `

  const blob = new Blob([workerSource], { type: 'application/javascript' })
  const workerUrl = URL.createObjectURL(blob)

  return new Promise((resolve) => {
    const worker = new Worker(workerUrl)

    const timeout = window.setTimeout(() => {
      worker.terminate()
      URL.revokeObjectURL(workerUrl)
      resolve({
        timedOut: true,
        output: ['Execution timed out. Check for infinite loops or very heavy work.'],
        durationMs: timeoutMs,
        error: 'Timed out',
      })
    }, timeoutMs)

    worker.onmessage = (event: MessageEvent) => {
      window.clearTimeout(timeout)
      worker.terminate()
      URL.revokeObjectURL(workerUrl)

      const payload = event.data ?? {}
      resolve({
        timedOut: false,
        output: Array.isArray(payload.logs) ? payload.logs : [],
        durationMs: Number(payload.durationMs ?? 0),
        error: typeof payload.error === 'string' ? payload.error : null,
      })
    }

    worker.postMessage({ code })
  })
}

function hashCode(code: string): string {
  let hash = 0
  for (let index = 0; index < code.length; index += 1) {
    hash = (hash * 31 + code.charCodeAt(index)) | 0
  }
  return `${code.length}:${Math.abs(hash)}`
}

function buildRunSummary(trace: ExecutionTrace, code: string, language: SupportedLanguage): RunSummary {
  let maxStackDepth = 0
  const lines = new Set<number>()
  let variableMutations = 0
  let microtasksScheduled = 0
  let macrotasksScheduled = 0

  for (let index = 0; index < trace.snapshots.length; index += 1) {
    const snapshot = trace.snapshots[index]
    maxStackDepth = Math.max(maxStackDepth, snapshot.callStack.length)
    if (snapshot.line > 0) {
      lines.add(snapshot.line)
    }

    microtasksScheduled += snapshot.eventLoop.microtasks.length
    macrotasksScheduled += snapshot.eventLoop.macrotasks.length

    if (index === 0) {
      continue
    }

    const prev = trace.snapshots[index - 1]
    const prevMap = new Map<string, string>()
    prev.stackMemory.forEach((frame) => {
      frame.variables.forEach((variable) => {
        prevMap.set(variable.address, variable.value)
      })
    })

    snapshot.stackMemory.forEach((frame) => {
      frame.variables.forEach((variable) => {
        const before = prevMap.get(variable.address)
        if (before !== undefined && before !== variable.value) {
          variableMutations += 1
        }
      })
    })
  }

  return {
    id: Date.now(),
    timestamp: new Date().toLocaleTimeString(),
    language,
    steps: trace.snapshots.length,
    diagnostics: trace.diagnostics.length,
    maxStackDepth,
    uniqueLines: lines.size,
    variableMutations,
    microtasksScheduled,
    macrotasksScheduled,
    codeHash: hashCode(code),
  }
}

function App() {
  const [language, setLanguage] = useState<SupportedLanguage>('javascript')
  const [code, setCode] = useState(languagePresets.javascript.code)
  const [executionMode, setExecutionMode] = useState<ExecutionMode>('instant')
  const [trace, setTrace] = useState<ExecutionTrace | null>(null)
  const [stepIndex, setStepIndex] = useState(0)
  const [isPlaying, setIsPlaying] = useState(false)
  const [speedMs, setSpeedMs] = useState(900)
  const [breakpointInput, setBreakpointInput] = useState('')
  const [watchInput, setWatchInput] = useState('')
  const [watchExpressions, setWatchExpressions] = useState<string[]>(['score + 1'])
  const [selectedScope, setSelectedScope] = useState('all')
  const [traceSearchQuery, setTraceSearchQuery] = useState('')
  const [runHistory, setRunHistory] = useState<RunSummary[]>([])
  const [traceRuns, setTraceRuns] = useState<TraceRun[]>([])
  const [activeRunId, setActiveRunId] = useState<number | null>(null)
  const [selectedRunId, setSelectedRunId] = useState<number | null>(null)
  const [compareMode, setCompareMode] = useState(false)
  const [compareLeftRunId, setCompareLeftRunId] = useState<number | null>(null)
  const [compareRightRunId, setCompareRightRunId] = useState<number | null>(null)
  const [compareScrubPercent, setCompareScrubPercent] = useState(0)
  const [heatmapEnabled, setHeatmapEnabled] = useState(true)
  const [selectedVariableAddress, setSelectedVariableAddress] = useState('')
  const [reportStatus, setReportStatus] = useState('')
  const [onboardingOpen, setOnboardingOpen] = useState(false)
  const [onboardingStepIndex, setOnboardingStepIndex] = useState(0)
  const [instantRun, setInstantRun] = useState<InstantRunState>({
    status: 'idle',
    output: [],
    durationMs: null,
    error: null,
  })
  const [isFormatting, setIsFormatting] = useState(false)
  const editorRef = useRef<editor.IStandaloneCodeEditor | null>(null)
  const monacoRef = useRef<typeof import('monaco-editor') | null>(null)
  const decorationsRef = useRef<string[]>([])
  const expressionParserRef = useRef(new Parser({ operators: { logical: true, comparison: true } }))

  const activeSnapshot = useMemo(() => {
    if (!trace || trace.snapshots.length === 0) {
      return null
    }
    return trace.snapshots[Math.min(stepIndex, trace.snapshots.length - 1)]
  }, [stepIndex, trace])

  const playbackProgress = useMemo(() => {
    if (!trace || trace.snapshots.length <= 1) {
      return 0
    }
    return Math.round((Math.min(stepIndex, trace.snapshots.length - 1) / (trace.snapshots.length - 1)) * 100)
  }, [stepIndex, trace])

  const runStateLabel = useMemo(() => {
    if (!trace) {
      return 'Idle'
    }

    if (isPlaying) {
      return 'Running'
    }

    if (stepIndex >= trace.snapshots.length - 1) {
      return 'Completed'
    }

    return 'Paused'
  }, [isPlaying, stepIndex, trace])

  const languageForMonaco = useMemo(() => {
    if (language === 'typescript') {
      return 'typescript'
    }
    if (language === 'javascript') {
      return 'javascript'
    }
    return 'cpp'
  }, [language])

  const breakpointLines = useMemo(() => {
    return breakpointInput
      .split(',')
      .map((item) => Number(item.trim()))
      .filter((lineNumber) => Number.isInteger(lineNumber) && lineNumber > 0)
  }, [breakpointInput])

  const previousSnapshot = useMemo(() => {
    if (!trace || stepIndex <= 0) {
      return null
    }
    return trace.snapshots[stepIndex - 1]
  }, [stepIndex, trace])

  const visibleVariables = useMemo(() => {
    if (!activeSnapshot) {
      return [] as RuntimeVariable[]
    }

    const all = activeSnapshot.stackMemory.flatMap((frame) => frame.variables)
    if (selectedScope === 'all') {
      return all
    }
    return all.filter((variable) => variable.scope === selectedScope)
  }, [activeSnapshot, selectedScope])

  const variableChanges = useMemo(() => {
    if (!activeSnapshot || !previousSnapshot) {
      return [] as { name: string; from: string; to: string; scope: string }[]
    }

    const previous = new Map<string, string>()
    previousSnapshot.stackMemory.forEach((frame) => {
      frame.variables.forEach((variable) => {
        previous.set(variable.address, variable.value)
      })
    })

    const changes: { name: string; from: string; to: string; scope: string }[] = []
    activeSnapshot.stackMemory.forEach((frame) => {
      frame.variables.forEach((variable) => {
        const before = previous.get(variable.address)
        if (before !== undefined && before !== variable.value) {
          changes.push({
            name: variable.name,
            from: before,
            to: variable.value,
            scope: variable.scope,
          })
        }
      })
    })

    return changes
  }, [activeSnapshot, previousSnapshot])

  const lineExecutionCounts = useMemo(() => {
    const counts = new Map<number, number>()
    if (!trace) {
      return counts
    }

    trace.snapshots.forEach((snapshot) => {
      if (snapshot.line > 0) {
        counts.set(snapshot.line, (counts.get(snapshot.line) ?? 0) + 1)
      }
    })

    return counts
  }, [trace])

  const hottestLines = useMemo(() => {
    return [...lineExecutionCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 6)
      .map(([line, count]) => ({ line, count }))
  }, [lineExecutionCounts])

  const heatBuckets = useMemo(() => {
    const mapped = new Map<number, 1 | 2 | 3>()
    if (!trace || lineExecutionCounts.size === 0) {
      return mapped
    }

    const max = Math.max(...lineExecutionCounts.values())
    lineExecutionCounts.forEach((count, line) => {
      const ratio = max === 0 ? 0 : count / max
      const bucket: 1 | 2 | 3 = ratio >= 0.75 ? 3 : ratio >= 0.4 ? 2 : 1
      mapped.set(line, bucket)
    })
    return mapped
  }, [lineExecutionCounts, trace])

  const functionActivity = useMemo(() => {
    const activity = new Map<string, number>()
    if (!trace) {
      return [] as { name: string; hits: number }[]
    }

    trace.snapshots.forEach((snapshot) => {
      snapshot.callStack.forEach((frame) => {
        activity.set(frame.name, (activity.get(frame.name) ?? 0) + 1)
      })
    })

    return [...activity.entries()]
      .map(([name, hits]) => ({ name, hits }))
      .sort((a, b) => b.hits - a.hits)
      .slice(0, 6)
  }, [trace])

  const mutationLeaderboard = useMemo(() => {
    if (!trace) {
      return [] as { key: string; count: number }[]
    }

    const mutationMap = new Map<string, number>()
    for (let index = 1; index < trace.snapshots.length; index += 1) {
      const current = trace.snapshots[index]
      const prev = trace.snapshots[index - 1]
      const prevMap = new Map<string, string>()

      prev.stackMemory.forEach((frame) => {
        frame.variables.forEach((variable) => {
          prevMap.set(variable.address, variable.value)
        })
      })

      current.stackMemory.forEach((frame) => {
        frame.variables.forEach((variable) => {
          const before = prevMap.get(variable.address)
          if (before !== undefined && before !== variable.value) {
            const key = `${variable.scope}.${variable.name}`
            mutationMap.set(key, (mutationMap.get(key) ?? 0) + 1)
          }
        })
      })
    }

    return [...mutationMap.entries()]
      .map(([key, count]) => ({ key, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 6)
  }, [trace])

  const variableTimeline = useMemo(() => {
    const catalog: { address: string; name: string; scope: string; label: string }[] = []
    const transitions: VariableTransition[] = []

    if (!trace || trace.snapshots.length === 0) {
      return { catalog, transitions }
    }

    const latestSnapshot = trace.snapshots[trace.snapshots.length - 1]
    latestSnapshot.stackMemory
      .flatMap((frame) => frame.variables)
      .forEach((variable) => {
        catalog.push({
          address: variable.address,
          name: variable.name,
          scope: variable.scope,
          label: `${variable.scope}.${variable.name}`,
        })
      })

    catalog.sort((a, b) => a.label.localeCompare(b.label))

    for (let index = 1; index < trace.snapshots.length; index += 1) {
      const current = trace.snapshots[index]
      const prev = trace.snapshots[index - 1]
      const prevValues = new Map<string, string>()

      prev.stackMemory.forEach((frame) => {
        frame.variables.forEach((variable) => {
          prevValues.set(variable.address, variable.value)
        })
      })

      current.stackMemory.forEach((frame) => {
        frame.variables.forEach((variable) => {
          const before = prevValues.get(variable.address)
          if (before === undefined) {
            transitions.push({
              step: index,
              line: current.line,
              address: variable.address,
              name: variable.name,
              scope: variable.scope,
              from: '(init)',
              to: variable.value,
            })
            return
          }

          if (before !== variable.value) {
            transitions.push({
              step: index,
              line: current.line,
              address: variable.address,
              name: variable.name,
              scope: variable.scope,
              from: before,
              to: variable.value,
            })
          }
        })
      })
    }

    return { catalog, transitions }
  }, [trace])

  const selectedVariableTransitions = useMemo(() => {
    if (!selectedVariableAddress) {
      return [] as VariableTransition[]
    }

    return variableTimeline.transitions
      .filter((entry) => entry.address === selectedVariableAddress)
      .slice(-14)
      .reverse()
  }, [selectedVariableAddress, variableTimeline.transitions])

  const executionHealth = useMemo(() => {
    if (!trace || trace.snapshots.length === 0) {
      return null
    }

    const stepCount = Math.max(trace.snapshots.length, 1)
    const topHotLine = hottestLines[0]
    const hotspotRatio = topHotLine ? topHotLine.count / stepCount : 0
    const queuePeak = trace.snapshots.reduce((peak, snapshot) => {
      const totalQueued =
        snapshot.eventLoop.microtasks.length + snapshot.eventLoop.macrotasks.length + snapshot.eventLoop.webApis.length
      return Math.max(peak, totalQueued)
    }, 0)

    const diagnosticsPenalty = trace.diagnostics.length * 12
    const mutationPenalty = Math.min(24, Math.round((variableTimeline.transitions.length / stepCount) * 22))
    const hotspotPenalty = Math.min(22, Math.round(hotspotRatio * 24))
    const queuePenalty = Math.min(20, queuePeak * 3)
    const score = Math.max(0, 100 - diagnosticsPenalty - mutationPenalty - hotspotPenalty - queuePenalty)

    const risk = score >= 85 ? 'low' : score >= 65 ? 'moderate' : score >= 45 ? 'high' : 'critical'
    return {
      score,
      risk,
      queuePeak,
      hotspotRatio,
      topHotLine,
    }
  }, [hottestLines, trace, variableTimeline.transitions.length])

  const anomalyInsights = useMemo(() => {
    const insights: string[] = []
    if (!trace || !executionHealth) {
      return insights
    }

    if (trace.diagnostics.length > 0) {
      insights.push(`${trace.diagnostics.length} parser/interpreter warning(s) were generated.`)
    }

    if (executionHealth.topHotLine && executionHealth.hotspotRatio >= 0.35) {
      insights.push(
        `Hotspot at line ${executionHealth.topHotLine.line} consumed ${(executionHealth.hotspotRatio * 100).toFixed(0)}% of sampled steps.`,
      )
    }

    if (executionHealth.queuePeak >= 3) {
      insights.push(`Event-loop pressure peaked at ${executionHealth.queuePeak} queued task(s).`)
    }

    if (variableTimeline.transitions.length > trace.snapshots.length * 0.8) {
      insights.push('High mutation density detected; consider reducing shared mutable state.')
    }

    if (insights.length === 0) {
      insights.push('No major anomalies detected in this trace run.')
    }

    return insights
  }, [executionHealth, trace, variableTimeline.transitions.length])

  const timelineMilestones = useMemo(() => {
    if (!trace || trace.snapshots.length === 0) {
      return [] as TraceMilestone[]
    }

    const mutationByStep = new Map<number, number>()
    variableTimeline.transitions.forEach((entry) => {
      mutationByStep.set(entry.step, (mutationByStep.get(entry.step) ?? 0) + 1)
    })

    const milestones: TraceMilestone[] = []
    for (let index = 1; index < trace.snapshots.length; index += 1) {
      const current = trace.snapshots[index]
      const previous = trace.snapshots[index - 1]
      const reasons: string[] = []

      if (current.eventLoop.phase !== previous.eventLoop.phase) {
        reasons.push(`phase changed to ${current.eventLoop.phase}`)
      }

      if (current.callStack.length !== previous.callStack.length) {
        const movement = current.callStack.length > previous.callStack.length ? 'stack grew' : 'stack unwound'
        reasons.push(`${movement} (${current.callStack.length} frame(s))`)
      }

      const mutationCount = mutationByStep.get(index) ?? 0
      if (mutationCount > 0) {
        reasons.push(`${mutationCount} variable mutation(s)`)
      }

      if (reasons.length === 0) {
        continue
      }

      milestones.push({
        step: index,
        line: current.line,
        headline: current.explanation,
        detail: reasons.join(' • '),
      })
    }

    return milestones.slice(0, 16)
  }, [trace, variableTimeline.transitions])

  const heroMetrics = useMemo(() => {
    return [
      {
        label: 'Run State',
        value: runStateLabel,
      },
      {
        label: 'Progress',
        value: `${playbackProgress}%`,
      },
      {
        label: 'Diagnostics',
        value: String(trace?.diagnostics.length ?? 0),
      },
      {
        label: 'Quality',
        value: executionHealth ? `${executionHealth.score}/100` : '--',
      },
    ]
  }, [executionHealth, playbackProgress, runStateLabel, trace?.diagnostics.length])

  const contextualTips = useMemo(() => {
    const tips: string[] = []

    if (!trace) {
      tips.push('Run the preset once to unlock milestone, anomaly, and lane analysis.')
    } else {
      if ((trace.diagnostics.length ?? 0) > 0) {
        tips.push('Open Interpreter Notes first; unresolved diagnostics can skew downstream analytics.')
      }

      if ((activeSnapshot?.eventLoop.microtasks.length ?? 0) > 0 && (activeSnapshot?.eventLoop.macrotasks.length ?? 0) > 0) {
        tips.push('Both microtasks and macrotasks are queued: step to the next milestone to inspect task ordering.')
      }

      if (variableChanges.length > 2) {
        tips.push('High mutation step detected: use Variable Timeline Explorer to isolate which writes were causal.')
      }

      if (executionHealth && executionHealth.score < 65) {
        tips.push('Execution score is low. Check hot lines and function lanes for concentrated frame pressure.')
      }
    }

    if (tips.length === 0) {
      tips.push('Trace is stable. Use compare mode to validate behavior changes between runs.')
    }

    return tips.slice(0, 4)
  }, [activeSnapshot?.eventLoop.macrotasks.length, activeSnapshot?.eventLoop.microtasks.length, executionHealth, trace, variableChanges.length])

  const compareLeftRun = useMemo(() => {
    if (compareLeftRunId === null) {
      return null
    }
    return traceRuns.find((run) => run.id === compareLeftRunId) ?? null
  }, [compareLeftRunId, traceRuns])

  const compareRightRun = useMemo(() => {
    if (compareRightRunId === null) {
      return null
    }
    return traceRuns.find((run) => run.id === compareRightRunId) ?? null
  }, [compareRightRunId, traceRuns])

  const compareLeftIndex = useMemo(() => {
    if (!compareLeftRun || compareLeftRun.trace.snapshots.length <= 1) {
      return 0
    }
    return Math.round((compareScrubPercent / 100) * (compareLeftRun.trace.snapshots.length - 1))
  }, [compareLeftRun, compareScrubPercent])

  const compareRightIndex = useMemo(() => {
    if (!compareRightRun || compareRightRun.trace.snapshots.length <= 1) {
      return 0
    }
    return Math.round((compareScrubPercent / 100) * (compareRightRun.trace.snapshots.length - 1))
  }, [compareRightRun, compareScrubPercent])

  const compareLeftSnapshot = useMemo(() => {
    if (!compareLeftRun) {
      return null
    }
    return compareLeftRun.trace.snapshots[Math.min(compareLeftIndex, compareLeftRun.trace.snapshots.length - 1)] ?? null
  }, [compareLeftIndex, compareLeftRun])

  const compareRightSnapshot = useMemo(() => {
    if (!compareRightRun) {
      return null
    }
    return compareRightRun.trace.snapshots[Math.min(compareRightIndex, compareRightRun.trace.snapshots.length - 1)] ?? null
  }, [compareRightIndex, compareRightRun])

  const functionLanes = useMemo(() => {
    if (!trace || trace.snapshots.length === 0) {
      return [] as { name: string; totalHits: number; sparkline: string; badges: string[] }[]
    }

    const frameNames = new Set<string>()
    trace.snapshots.forEach((snapshot) => {
      snapshot.callStack.forEach((frame) => {
        frameNames.add(frame.name)
      })
    })

    const lanes = [...frameNames]
      .map((name) => {
        const samples = trace.snapshots.map(
          (snapshot) => snapshot.callStack.filter((frame) => frame.name === name).length,
        )
        const totalHits = samples.reduce((sum, value) => sum + value, 0)
        const peak = Math.max(...samples, 0)
        let burst = 0
        let current = 0

        samples.forEach((value) => {
          if (value > 0) {
            current += 1
            burst = Math.max(burst, current)
            return
          }
          current = 0
        })

        const activeRatio = samples.length === 0 ? 0 : totalHits / samples.length
        const badges: string[] = []
        if (peak > 2) {
          badges.push('recursion')
        }
        if (burst >= 4) {
          badges.push('burst')
        }
        if (activeRatio > 0.8) {
          badges.push('hot')
        }

        if (badges.length === 0) {
          badges.push('stable')
        }

        return {
          name,
          totalHits,
          sparkline: buildSparklinePoints(samples),
          badges,
        }
      })
      .sort((a, b) => b.totalHits - a.totalHits)
      .slice(0, 8)

    return lanes
  }, [trace])

  const traceSearchResults = useMemo(() => {
    const query = traceSearchQuery.trim().toLowerCase()
    if (!trace || !query) {
      return [] as { step: number; line: number; preview: string }[]
    }

    return trace.snapshots
      .map((snapshot, index) => {
        const logText = snapshot.eventLoop.logs.join(' ').toLowerCase()
        const message = snapshot.explanation.toLowerCase()
        const lineText = `line ${snapshot.line}`
        const score = Number(message.includes(query)) + Number(logText.includes(query)) + Number(lineText.includes(query))
        return {
          step: index,
          line: snapshot.line,
          preview: snapshot.explanation,
          score,
        }
      })
      .filter((item) => item.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 8)
      .map(({ step, line, preview }) => ({ step, line, preview }))
  }, [trace, traceSearchQuery])

  const currentRunSummary = useMemo(() => {
    if (!trace) {
      return null
    }
    return buildRunSummary(trace, code, language)
  }, [trace, code, language])

  const selectedRun = useMemo(() => {
    if (selectedRunId === null) {
      return null
    }
    return runHistory.find((run) => run.id === selectedRunId) ?? null
  }, [runHistory, selectedRunId])

  const comparisonDelta = useMemo(() => {
    if (!selectedRun || !currentRunSummary) {
      return null
    }

    return {
      steps: currentRunSummary.steps - selectedRun.steps,
      diagnostics: currentRunSummary.diagnostics - selectedRun.diagnostics,
      maxStackDepth: currentRunSummary.maxStackDepth - selectedRun.maxStackDepth,
      variableMutations: currentRunSummary.variableMutations - selectedRun.variableMutations,
    }
  }, [selectedRun, currentRunSummary])

  useEffect(() => {
    if (!trace || trace.snapshots.length === 0) {
      setSelectedVariableAddress('')
      return
    }

    if (selectedVariableAddress && variableTimeline.catalog.some((item) => item.address === selectedVariableAddress)) {
      return
    }

    setSelectedVariableAddress(variableTimeline.catalog[0]?.address ?? '')
  }, [selectedVariableAddress, trace, variableTimeline.catalog])

  useEffect(() => {
    const seen = localStorage.getItem('trace-visualizer-onboarded')
    if (!seen) {
      setOnboardingOpen(true)
      setOnboardingStepIndex(0)
    }
  }, [])

  useEffect(() => {
    if (!trace || trace.snapshots.length <= 1 || activeRunId === null) {
      return
    }

    if (compareRightRunId !== activeRunId) {
      return
    }

    const nextPercent = Math.round((stepIndex / (trace.snapshots.length - 1)) * 100)
    setCompareScrubPercent(nextPercent)
  }, [activeRunId, compareRightRunId, stepIndex, trace])

  const watchValues = useMemo(() => {
    const scope: Record<string, number> = {}
    visibleVariables.forEach((variable) => {
      const numeric = Number(variable.value)
      if (!Number.isNaN(numeric)) {
        scope[variable.name] = numeric
      }
    })

    return watchExpressions.map((expression) => {
      try {
        const value = expressionParserRef.current.evaluate(expression, scope as never)
        return { expression, value: String(value), status: 'ok' as const }
      } catch {
        return { expression, value: 'n/a', status: 'error' as const }
      }
    })
  }, [visibleVariables, watchExpressions])

  const scopeOptions = useMemo(() => {
    if (!activeSnapshot) {
      return ['all']
    }

    return ['all', ...activeSnapshot.stackMemory.map((frame) => frame.name)]
  }, [activeSnapshot])

  const stepNarrative = useMemo(() => {
    if (!activeSnapshot) {
      return [] as string[]
    }

    const notes = [activeSnapshot.explanation]

    if (activeSnapshot.eventLoop.enabled) {
      notes.push(
        `Phase: ${activeSnapshot.eventLoop.phase}. Current task: ${activeSnapshot.eventLoop.currentTask}.`,
      )

      if (activeSnapshot.eventLoop.microtasks.length > 0 || activeSnapshot.eventLoop.macrotasks.length > 0) {
        notes.push(
          `Queued work: ${activeSnapshot.eventLoop.microtasks.length} microtask(s), ${activeSnapshot.eventLoop.macrotasks.length} macrotask(s), ${activeSnapshot.eventLoop.webApis.length} Web API timer(s).`,
        )
      }
    }

    if (variableChanges.length > 0) {
      notes.push(
        `Memory changed in this step: ${variableChanges
          .slice(0, 3)
          .map((change) => `${change.scope}.${change.name}`)
          .join(', ')}.`,
      )
    }

    return notes
  }, [activeSnapshot, variableChanges])

  const jumpToNextBreakpoint = () => {
    if (!trace || breakpointLines.length === 0) {
      return
    }

    for (let index = stepIndex + 1; index < trace.snapshots.length; index += 1) {
      const candidateLine = trace.snapshots[index].line
      if (breakpointLines.includes(candidateLine)) {
        setStepIndex(index)
        return
      }
    }
  }

  useEffect(() => {
    if (!isPlaying || !trace) {
      return
    }

    const timer = setInterval(() => {
      setStepIndex((current) => {
        const next = current + 1
        if (next >= trace.snapshots.length) {
          setIsPlaying(false)
          return current
        }

        if (breakpointLines.includes(trace.snapshots[next].line)) {
          setIsPlaying(false)
          return next
        }

        return next
      })
    }, speedMs)

    return () => clearInterval(timer)
  }, [isPlaying, trace, speedMs, breakpointLines])

  useEffect(() => {
    if (!editorRef.current || !monacoRef.current) {
      return
    }

    const line = activeSnapshot?.line
    if (!line || line < 1) {
      decorationsRef.current = editorRef.current.deltaDecorations(decorationsRef.current, [])
      return
    }

    const heatmapDecorations = heatmapEnabled
      ? [...heatBuckets.entries()].map(([lineNumber, bucket]) => ({
          range: new monacoRef.current!.Range(lineNumber, 1, lineNumber, 1),
          options: {
            isWholeLine: true,
            className: `heat-line-${bucket}`,
            linesDecorationsClassName: `heat-gutter-${bucket}`,
          },
        }))
      : []

    const lineDecorations = [
      ...heatmapDecorations,
      {
        range: new monacoRef.current.Range(line, 1, line, 1),
        options: {
          isWholeLine: true,
          className: 'active-execution-line',
          glyphMarginClassName: 'active-execution-glyph',
        },
      },
      ...breakpointLines.map((point) => ({
        range: new monacoRef.current.Range(point, 1, point, 1),
        options: {
          isWholeLine: false,
          glyphMarginClassName: 'breakpoint-glyph',
          linesDecorationsClassName: 'breakpoint-line',
        },
      })),
    ]

    decorationsRef.current = editorRef.current.deltaDecorations(decorationsRef.current, lineDecorations)

    editorRef.current.revealLineInCenter(line)
  }, [activeSnapshot?.line, breakpointLines, heatBuckets, heatmapEnabled])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && onboardingOpen) {
        setOnboardingOpen(false)
        localStorage.setItem('trace-visualizer-onboarded', 'true')
        return
      }

      const target = event.target as HTMLElement | null
      const isTypingElement =
        target?.tagName === 'INPUT' || target?.tagName === 'TEXTAREA' || target?.getAttribute('role') === 'textbox'
      if (isTypingElement) {
        return
      }

      if (event.code === 'Space' && trace) {
        event.preventDefault()
        setIsPlaying((value) => !value)
        return
      }

      if (event.code === 'ArrowRight' && trace) {
        event.preventDefault()
        setStepIndex((current) => Math.min(current + 1, trace.snapshots.length - 1))
        return
      }

      if (event.code === 'ArrowLeft' && trace) {
        event.preventDefault()
        setStepIndex((current) => Math.max(current - 1, 0))
        return
      }

      if (event.key.toLowerCase() === 'b' && event.shiftKey) {
        event.preventDefault()
        jumpToNextBreakpoint()
        return
      }

      if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
        event.preventDefault()
        if (executionMode === 'instant') {
          void runInstantExecution()
          return
        }

        runTrace()
      }
    }

    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [onboardingOpen, trace, jumpToNextBreakpoint, executionMode, code, language])

  const runTrace = () => {
    const nextTrace = generateExecutionTrace(code, language)
    const summary = buildRunSummary(nextTrace, code, language)
    setTrace(nextTrace)
    setActiveRunId(summary.id)
    setStepIndex(0)
    setIsPlaying(false)
    setRunHistory((current) => [summary, ...current].slice(0, 8))
    setTraceRuns((current) => {
      const nextRuns = [{ id: summary.id, summary, trace: nextTrace }, ...current].slice(0, 8)
      if (nextRuns.length >= 2) {
        setCompareLeftRunId(nextRuns[1].id)
      }
      setCompareRightRunId(summary.id)
      return nextRuns
    })
    setCompareScrubPercent(0)

    if (selectedRunId === null) {
      setSelectedRunId(summary.id)
    }

    if (monacoRef.current && editorRef.current) {
      const markers = nextTrace.diagnostics.map((diagnostic) => ({
        startLineNumber: diagnostic.line,
        endLineNumber: diagnostic.line,
        startColumn: 1,
        endColumn: Math.max(2, (code.split('\n')[diagnostic.line - 1]?.length ?? 1) + 1),
        message: diagnostic.message,
        severity: monacoRef.current!.MarkerSeverity.Warning,
      }))

      monacoRef.current.editor.setModelMarkers(editorRef.current.getModel()!, 'trace', markers)
    }
  }

  const runInstantExecution = async () => {
    const compiled = compileForInstantRun(code, language)
    if (!compiled) {
      setInstantRun({
        status: 'error',
        output: [],
        durationMs: null,
        error: 'Normal run mode currently supports JavaScript and TypeScript.',
      })
      return
    }

    setInstantRun({
      status: 'running',
      output: ['Running in isolated worker...'],
      durationMs: null,
      error: null,
    })

    const result = await runInstantInWorker(compiled, INSTANT_RUN_TIMEOUT_MS)
    if (result.timedOut) {
      setInstantRun({
        status: 'timeout',
        output: result.output,
        durationMs: result.durationMs,
        error: result.error,
      })
      return
    }

    if (result.error) {
      setInstantRun({
        status: 'error',
        output: result.output,
        durationMs: result.durationMs,
        error: result.error,
      })
      return
    }

    setInstantRun({
      status: 'success',
      output: result.output,
      durationMs: result.durationMs,
      error: null,
    })
  }

  const switchLanguage = (nextLanguage: SupportedLanguage) => {
    setLanguage(nextLanguage)
    setCode(languagePresets[nextLanguage].code)
    setTrace(null)
    setInstantRun({ status: 'idle', output: [], durationMs: null, error: null })
    setStepIndex(0)
    setIsPlaying(false)
    setSelectedScope('all')
  }

  const resetToPreset = () => {
    setCode(languagePresets[language].code)
    setTrace(null)
    setInstantRun({ status: 'idle', output: [], durationMs: null, error: null })
    setStepIndex(0)
    setIsPlaying(false)
  }

  const formatDocument = async () => {
    if (!editorRef.current) {
      return
    }

    const action = editorRef.current.getAction('editor.action.formatDocument')
    if (!action) {
      return
    }

    setIsFormatting(true)
    await action.run()
    setIsFormatting(false)
  }

  const stepForward = () => {
    if (!trace) {
      return
    }
    setStepIndex((current) => Math.min(current + 1, trace.snapshots.length - 1))
  }

  const stepBackward = () => {
    setStepIndex((current) => Math.max(current - 1, 0))
  }

  const resetExecution = () => {
    setStepIndex(0)
    setIsPlaying(false)
  }

  const addWatchExpression = () => {
    const normalized = watchInput.trim()
    if (!normalized) {
      return
    }

    if (watchExpressions.includes(normalized)) {
      setWatchInput('')
      return
    }

    setWatchExpressions((current) => [...current, normalized])
    setWatchInput('')
  }

  const removeWatchExpression = (target: string) => {
    setWatchExpressions((current) => current.filter((expression) => expression !== target))
  }

  const copyRunReport = async () => {
    if (!currentRunSummary) {
      return
    }

    const report = {
      createdAt: new Date().toISOString(),
      summary: currentRunSummary,
      quality: executionHealth,
      anomalies: anomalyInsights,
      topHotLines: hottestLines,
      topMutationKeys: mutationLeaderboard,
      timelineMilestones,
    }

    if (!navigator.clipboard?.writeText) {
      setReportStatus('Clipboard API is unavailable in this browser context.')
      return
    }

    await navigator.clipboard.writeText(JSON.stringify(report, null, 2))
    setReportStatus('Run report copied to clipboard.')
  }

  const closeOnboarding = () => {
    setOnboardingOpen(false)
    localStorage.setItem('trace-visualizer-onboarded', 'true')
  }

  const moveOnboarding = (direction: -1 | 1) => {
    setOnboardingStepIndex((current) => {
      const next = Math.min(Math.max(current + direction, 0), onboardingTourSteps.length - 1)
      return next
    })
  }

  const setCompareScrub = (percent: number) => {
    const next = Math.min(100, Math.max(0, percent))
    setCompareScrubPercent(next)

    if (trace && trace.snapshots.length > 1) {
      const nextStep = Math.round((next / 100) * (trace.snapshots.length - 1))
      setStepIndex(nextStep)
    }
  }

  const renderVariables = (variables: RuntimeVariable[]) => {
    if (variables.length === 0) {
      return <p className="empty">No variables yet.</p>
    }

    return (
      <div className="variable-list">
        {variables.map((variable) => (
          <div key={`${variable.scope}-${variable.name}-${variable.address}`} className="variable-card">
            <div className="row">
              <strong>{variable.name}</strong>
              <span className="type">{variable.type}</span>
            </div>
            <div className="row">
              <span>Value: {variable.value}</span>
            </div>
            <div className="row small">
              <span>Address: {variable.address}</span>
              {variable.pointsTo && <span>Points to: {variable.pointsTo}</span>}
            </div>
          </div>
        ))}
      </div>
    )
  }

  const renderQueue = (
    title: string,
    items: { id: string; label: string; line: number; status: string; delay?: number }[],
    emptyMessage: string,
  ) => {
    return (
      <div className="queue-column">
        <div className="row queue-header">
          <h4>{title}</h4>
          <span>{items.length}</span>
        </div>
        {items.length === 0 ? (
          <p className="empty">{emptyMessage}</p>
        ) : (
          <div className="queue-list">
            {items.map((item) => (
              <motion.div
                key={item.id}
                className="queue-item"
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.2 }}
              >
                <div className="row">
                  <strong>{item.label}</strong>
                  <span>{item.status}</span>
                </div>
                <div className="row small">
                  <span>line {item.line}</span>
                  {item.delay !== undefined ? <span>{item.delay}ms</span> : null}
                </div>
              </motion.div>
            ))}
          </div>
        )}
      </div>
    )
  }

  const activeOnboardingStep = onboardingTourSteps[Math.min(onboardingStepIndex, onboardingTourSteps.length - 1)]

  return (
    <div className={`app-shell ${onboardingOpen ? `tour-target-${activeOnboardingStep.target}` : ''}`}>
      <header className="app-header">
        <div>
          <p className="eyebrow">Code Execution Visualizer</p>
          <h1>Build, run, and deep-debug code with a god-level runtime lab</h1>
          <p className="hero-copy">
            Write code directly in the editor and switch between instant run mode and full trace debugging mode with memory + event-loop intelligence.
          </p>
          <div className="hero-metrics">
            {heroMetrics.map((metric) => (
              <article key={metric.label}>
                <p>{metric.label}</p>
                <strong>{metric.value}</strong>
              </article>
            ))}
          </div>
          <div className="hero-progress" aria-hidden="true">
            <span style={{ width: `${playbackProgress}%` }} />
          </div>
        </div>
        <div className="language-switcher">
          {(['javascript', 'typescript', 'c', 'cpp'] as SupportedLanguage[]).map((item) => (
            <button
              key={item}
              className={language === item ? 'active' : ''}
              onClick={() => switchLanguage(item)}
            >
              {item.toUpperCase()}
            </button>
          ))}
          <button
            className="tour-launch"
            onClick={() => {
              setOnboardingStepIndex(0)
              setOnboardingOpen(true)
            }}
          >
            Tour
          </button>
        </div>
      </header>

      <main className="layout">
        <section className="panel editor-panel">
          <div className="panel-title">
            <h2>Editor</h2>
            <span>{languagePresets[language].title}</span>
          </div>
          <div className="mode-switch">
            <button
              className={executionMode === 'instant' ? 'active' : ''}
              onClick={() => setExecutionMode('instant')}
            >
              Instant Run
            </button>
            <button className={executionMode === 'trace' ? 'active' : ''} onClick={() => setExecutionMode('trace')}>
              Trace Debug
            </button>
          </div>
          <div className="editor-toolbar">
            <button onClick={() => void formatDocument()} disabled={isFormatting}>
              {isFormatting ? 'Formatting...' : 'Format Code'}
            </button>
            <button onClick={resetToPreset}>Reset Preset</button>
            <button
              className="primary-cta"
              onClick={() => {
                if (executionMode === 'instant') {
                  void runInstantExecution()
                  return
                }

                runTrace()
              }}
            >
              {executionMode === 'instant' ? 'Run Normally' : 'Run Trace'}
            </button>
          </div>
          <Editor
            height="70vh"
            language={languageForMonaco}
            value={code}
            onChange={(value) => setCode(value ?? '')}
            onMount={(editorInstance, monacoInstance) => {
              editorRef.current = editorInstance
              monacoRef.current = monacoInstance
            }}
            options={{
              minimap: { enabled: false },
              fontSize: 15,
              lineNumbers: 'on',
              smoothScrolling: true,
              glyphMargin: true,
            }}
            theme="vs-dark"
          />
          <div className="instant-runner">
            <div className="row">
              <h3>Normal Run Console</h3>
              <span className={`status-pill status-${instantRun.status}`}>{instantRun.status.toUpperCase()}</span>
            </div>
            <p className="small">Shortcut: Ctrl/Cmd+Enter. Instant mode runs without step-by-step debugging.</p>
            {language === 'c' || language === 'cpp' ? (
              <p className="empty">Normal run currently supports JavaScript and TypeScript. Use trace mode for C/C++.</p>
            ) : (
              <>
                <div className="instant-actions">
                  <button onClick={() => void runInstantExecution()} disabled={instantRun.status === 'running'}>
                    {instantRun.status === 'running' ? 'Running...' : 'Run Now'}
                  </button>
                  <button
                    onClick={() => setInstantRun({ status: 'idle', output: [], durationMs: null, error: null })}
                    disabled={instantRun.status === 'running'}
                  >
                    Clear Output
                  </button>
                </div>
                <div className="console-output instant-output">
                  {instantRun.output.length === 0 ? (
                    <p>No output yet.</p>
                  ) : (
                    instantRun.output.map((entry, index) => <p key={`${entry}-${index}`}>{entry}</p>)
                  )}
                  {instantRun.error ? <p>Error: {instantRun.error}</p> : null}
                </div>
                <p className="small">Duration: {instantRun.durationMs === null ? '-' : `${instantRun.durationMs}ms`}</p>
              </>
            )}
          </div>
        </section>

        <section className="panel controls-panel">
          <div className="panel-title">
            <h2>Execution Controls</h2>
            <span>
              Step {trace ? Math.min(stepIndex + 1, trace.snapshots.length) : 0}/
              {trace?.snapshots.length ?? 0}
            </span>
          </div>
          <div className="state-chip-row">
            <span className={`state-chip state-${runStateLabel.toLowerCase()}`}>{runStateLabel}</span>
            <span className="state-chip secondary">Playback {playbackProgress}%</span>
          </div>
          <div className="runtime-stats">
            <article>
              <p>Current Line</p>
              <strong>{activeSnapshot?.line ?? '-'}</strong>
            </article>
            <article>
              <p>Frames</p>
              <strong>{activeSnapshot?.callStack.length ?? 0}</strong>
            </article>
            <article>
              <p>Heap Cells</p>
              <strong>{activeSnapshot?.heapMemory.length ?? 0}</strong>
            </article>
            <article>
              <p>Structures</p>
              <strong>{activeSnapshot?.structures.length ?? 0}</strong>
            </article>
            <article>
              <p>Microtasks</p>
              <strong>{activeSnapshot?.eventLoop.microtasks.length ?? 0}</strong>
            </article>
            <article>
              <p>Macrotasks</p>
              <strong>{activeSnapshot?.eventLoop.macrotasks.length ?? 0}</strong>
            </article>
          </div>
          <div className="controls-grid">
            <button onClick={runTrace}>Run Trace</button>
            <button onClick={() => setIsPlaying((value) => !value)} disabled={!trace}>
              {isPlaying ? 'Pause' : 'Play'}
            </button>
            <button onClick={stepForward} disabled={!trace}>
              Step Forward
            </button>
            <button onClick={stepBackward} disabled={!trace}>
              Step Backward
            </button>
            <button onClick={resetExecution} disabled={!trace}>
              Reset
            </button>
            <button onClick={jumpToNextBreakpoint} disabled={!trace || breakpointLines.length === 0}>
              Next Breakpoint
            </button>
          </div>
          <div className="jump-grid">
            <button onClick={() => setStepIndex(0)} disabled={!trace}>
              Start
            </button>
            <button
              onClick={() => setStepIndex(Math.floor((trace?.snapshots.length ?? 1) * 0.25))}
              disabled={!trace}
            >
              25%
            </button>
            <button
              onClick={() => setStepIndex(Math.floor((trace?.snapshots.length ?? 1) * 0.5))}
              disabled={!trace}
            >
              50%
            </button>
            <button
              onClick={() => setStepIndex(Math.floor((trace?.snapshots.length ?? 1) * 0.75))}
              disabled={!trace}
            >
              75%
            </button>
            <button onClick={() => setStepIndex(Math.max((trace?.snapshots.length ?? 1) - 1, 0))} disabled={!trace}>
              End
            </button>
          </div>
          <div className="advanced-bar">
            <label>
              Timeline
              <input
                type="range"
                min={0}
                max={Math.max((trace?.snapshots.length ?? 1) - 1, 0)}
                value={Math.min(stepIndex, Math.max((trace?.snapshots.length ?? 1) - 1, 0))}
                onChange={(event) => setStepIndex(Number(event.target.value))}
                disabled={!trace}
              />
            </label>
            <label>
              Speed ({speedMs}ms)
              <input
                type="range"
                min={250}
                max={1800}
                step={50}
                value={speedMs}
                onChange={(event) => setSpeedMs(Number(event.target.value))}
              />
            </label>
            <label>
              Breakpoints (line numbers)
              <input
                type="text"
                value={breakpointInput}
                onChange={(event) => setBreakpointInput(event.target.value)}
                placeholder="3, 7, 10"
              />
            </label>
            <label className="checkbox-label">
              <input
                type="checkbox"
                checked={heatmapEnabled}
                onChange={(event) => setHeatmapEnabled(event.target.checked)}
              />
              <span>Execution heatmap in editor</span>
            </label>
            <p className="shortcut-hint">Shortcuts: Space play/pause, Left/Right step, Shift+B next breakpoint.</p>
          </div>
          <div className="explanation">
            <h3>What is happening now?</h3>
            <p>{activeSnapshot?.explanation ?? 'Press Run to generate a complete trace and memory timeline.'}</p>
          </div>
          <div className="diagnostics">
            <h3>Contextual Tips</h3>
            <div className="context-tip-list">
              {contextualTips.map((tip) => (
                <p key={tip}>{tip}</p>
              ))}
            </div>
          </div>
          <div className="diagnostics">
            <h3>Step Anatomy</h3>
            {stepNarrative.length === 0 ? (
              <p className="empty">No detailed step narrative yet.</p>
            ) : (
              stepNarrative.map((note) => <p key={note}>{note}</p>)
            )}
          </div>
          <div className="diagnostics">
            <h3>State Delta</h3>
            {variableChanges.length === 0 ? (
              <p className="empty">No variable updates in this step.</p>
            ) : (
              variableChanges.slice(0, 6).map((change) => (
                <p key={`${change.scope}-${change.name}-${change.to}`}>
                  {change.scope}.{change.name}: {change.from}{' -> '}{change.to}
                </p>
              ))
            )}
          </div>
          <div className="diagnostics">
            <h3>Interpreter Notes</h3>
            {!trace || trace.diagnostics.length === 0 ? (
              <p className="empty">No warnings for this program.</p>
            ) : (
              trace.diagnostics.slice(0, 8).map((item) => (
                <p key={`${item.line}-${item.message}`}>Line {item.line}: {item.message}</p>
              ))
            )}
          </div>

          <div className="diagnostics">
            <h3>Trace Query</h3>
            <input
              type="text"
              value={traceSearchQuery}
              onChange={(event) => setTraceSearchQuery(event.target.value)}
              placeholder="Search explanation, logs, or line (e.g. line 12)"
              className="trace-search-input"
            />
            {traceSearchQuery.trim() === '' ? (
              <p className="empty">Type to search the timeline and jump to a matching step.</p>
            ) : traceSearchResults.length === 0 ? (
              <p className="empty">No matching step found for this query.</p>
            ) : (
              <div className="trace-search-list">
                {traceSearchResults.map((result) => (
                  <button key={`${result.step}-${result.line}`} onClick={() => setStepIndex(result.step)}>
                    <span>
                      Step {result.step + 1} • line {result.line}
                    </span>
                    <small>{result.preview}</small>
                  </button>
                ))}
              </div>
            )}
          </div>

          <div className="diagnostics">
            <h3>Run Lab</h3>
            {runHistory.length === 0 ? (
              <p className="empty">Run a trace to build comparison history.</p>
            ) : (
              <>
                <label>
                  Compare Against
                  <select
                    value={selectedRunId ?? ''}
                    onChange={(event) => setSelectedRunId(event.target.value ? Number(event.target.value) : null)}
                  >
                    <option value="">None</option>
                    {runHistory.map((run) => (
                      <option key={run.id} value={run.id}>
                        {run.timestamp} • {run.language.toUpperCase()} • {run.steps} steps
                      </option>
                    ))}
                  </select>
                </label>

                <label className="checkbox-label">
                  <input
                    type="checkbox"
                    checked={compareMode}
                    onChange={(event) => setCompareMode(event.target.checked)}
                    disabled={traceRuns.length < 2}
                  />
                  <span>Enable split-screen visual compare</span>
                </label>

                {compareMode && (
                  <div className="compare-controls">
                    <label>
                      Left Run
                      <select
                        value={compareLeftRunId ?? ''}
                        onChange={(event) => setCompareLeftRunId(event.target.value ? Number(event.target.value) : null)}
                      >
                        <option value="">Choose run</option>
                        {traceRuns.map((run) => (
                          <option key={`left-${run.id}`} value={run.id}>
                            {run.summary.timestamp} • {run.summary.language.toUpperCase()} • {run.summary.steps} steps
                          </option>
                        ))}
                      </select>
                    </label>

                    <label>
                      Right Run
                      <select
                        value={compareRightRunId ?? ''}
                        onChange={(event) => setCompareRightRunId(event.target.value ? Number(event.target.value) : null)}
                      >
                        <option value="">Choose run</option>
                        {traceRuns.map((run) => (
                          <option key={`right-${run.id}`} value={run.id}>
                            {run.summary.timestamp} • {run.summary.language.toUpperCase()} • {run.summary.steps} steps
                          </option>
                        ))}
                      </select>
                    </label>

                    <label>
                      Sync Scrub ({compareScrubPercent}%)
                      <input
                        type="range"
                        min={0}
                        max={100}
                        value={compareScrubPercent}
                        onChange={(event) => setCompareScrub(Number(event.target.value))}
                      />
                    </label>
                  </div>
                )}

                {comparisonDelta && (
                  <div className="comparison-grid">
                    <p>Steps delta: {comparisonDelta.steps >= 0 ? `+${comparisonDelta.steps}` : comparisonDelta.steps}</p>
                    <p>
                      Diagnostics delta:{' '}
                      {comparisonDelta.diagnostics >= 0
                        ? `+${comparisonDelta.diagnostics}`
                        : comparisonDelta.diagnostics}
                    </p>
                    <p>
                      Stack depth delta:{' '}
                      {comparisonDelta.maxStackDepth >= 0
                        ? `+${comparisonDelta.maxStackDepth}`
                        : comparisonDelta.maxStackDepth}
                    </p>
                    <p>
                      Mutation delta:{' '}
                      {comparisonDelta.variableMutations >= 0
                        ? `+${comparisonDelta.variableMutations}`
                        : comparisonDelta.variableMutations}
                    </p>
                  </div>
                )}

                <button className="report-button" onClick={copyRunReport} disabled={!currentRunSummary}>
                  Copy Current Run Report
                </button>
                {reportStatus && <p className="small">{reportStatus}</p>}
              </>
            )}
          </div>
        </section>

        <section className="panel visual-panel">
          <div className="panel-title">
            <h2>Runtime Visualizer</h2>
            <span>Live runtime state</span>
          </div>

          <div className="viz-group insight-grid">
            {activeSnapshot?.insights.map((insight) => (
              <div key={insight.label} className="insight-card">
                <p>{insight.label}</p>
                <strong>{insight.value}</strong>
              </div>
            ))}
          </div>

          {compareMode && (
            <div className="viz-group compare-visual-panel">
              <div className="row event-loop-title">
                <h3>Split Trace Compare</h3>
                <span className="phase-chip">sync {compareScrubPercent}%</span>
              </div>
              {!compareLeftSnapshot || !compareRightSnapshot ? (
                <p className="empty">Select both runs in Run Lab to unlock visual compare.</p>
              ) : (
                <div className="split-compare-grid">
                  <article>
                    <header>
                      <strong>
                        Left: {compareLeftRun?.summary.timestamp} • {compareLeftRun?.summary.language.toUpperCase()}
                      </strong>
                    </header>
                    <p>
                      Step {compareLeftIndex + 1}/{compareLeftRun?.trace.snapshots.length}
                    </p>
                    <p>line {compareLeftSnapshot.line}</p>
                    <p>{compareLeftSnapshot.explanation}</p>
                    <p>frames: {compareLeftSnapshot.callStack.length}</p>
                    <p>
                      queue: {compareLeftSnapshot.eventLoop.microtasks.length} micro /{' '}
                      {compareLeftSnapshot.eventLoop.macrotasks.length} macro
                    </p>
                  </article>

                  <article>
                    <header>
                      <strong>
                        Right: {compareRightRun?.summary.timestamp} • {compareRightRun?.summary.language.toUpperCase()}
                      </strong>
                    </header>
                    <p>
                      Step {compareRightIndex + 1}/{compareRightRun?.trace.snapshots.length}
                    </p>
                    <p>line {compareRightSnapshot.line}</p>
                    <p>{compareRightSnapshot.explanation}</p>
                    <p>frames: {compareRightSnapshot.callStack.length}</p>
                    <p>
                      queue: {compareRightSnapshot.eventLoop.microtasks.length} micro /{' '}
                      {compareRightSnapshot.eventLoop.macrotasks.length} macro
                    </p>
                  </article>
                </div>
              )}
            </div>
          )}

          <div className="viz-group">
            <h3>Execution Profiler</h3>
            {!trace ? (
              <p className="empty">Run code to generate profiler analytics.</p>
            ) : (
              <div className="profiler-grid">
                <div className="profiler-card">
                  <h4>Hot Lines</h4>
                  {hottestLines.length === 0 ? (
                    <p className="empty">No line samples yet.</p>
                  ) : (
                    hottestLines.map((entry) => (
                      <p key={`hot-${entry.line}`}>
                        line {entry.line}: {entry.count} hit(s)
                      </p>
                    ))
                  )}
                </div>
                <div className="profiler-card">
                  <h4>Function Activity</h4>
                  {functionActivity.length === 0 ? (
                    <p className="empty">No frame activity yet.</p>
                  ) : (
                    functionActivity.map((entry) => (
                      <p key={`fn-${entry.name}`}>
                        {entry.name}: {entry.hits} frame snapshot(s)
                      </p>
                    ))
                  )}
                </div>
                <div className="profiler-card">
                  <h4>Mutation Leaderboard</h4>
                  {mutationLeaderboard.length === 0 ? (
                    <p className="empty">No mutable state changes yet.</p>
                  ) : (
                    mutationLeaderboard.map((entry) => (
                      <p key={`mutation-${entry.key}`}>
                        {entry.key}: {entry.count} change(s)
                      </p>
                    ))
                  )}
                </div>
                <div className="profiler-card">
                  <h4>Current Run Snapshot</h4>
                  {!currentRunSummary ? (
                    <p className="empty">No run summary.</p>
                  ) : (
                    <>
                      <p>Code fingerprint: {currentRunSummary.codeHash}</p>
                      <p>Unique lines touched: {currentRunSummary.uniqueLines}</p>
                      <p>Max stack depth: {currentRunSummary.maxStackDepth}</p>
                      <p>Total mutations: {currentRunSummary.variableMutations}</p>
                    </>
                  )}
                </div>
              </div>
            )}
          </div>

          <div className="viz-group function-lanes-panel">
            <h3>Function Performance Lanes</h3>
            {!trace ? (
              <p className="empty">Run code to generate function lane charts.</p>
            ) : functionLanes.length === 0 ? (
              <p className="empty">No function activity detected.</p>
            ) : (
              <div className="function-lane-list">
                {functionLanes.map((lane) => (
                  <article key={lane.name} className="function-lane-card">
                    <div className="row">
                      <strong>{lane.name}</strong>
                      <span>{lane.totalHits} frame hits</span>
                    </div>
                    <svg viewBox="0 0 160 34" preserveAspectRatio="none" role="img" aria-label={`${lane.name} sparkline`}>
                      <polyline points={lane.sparkline} className="lane-line" />
                    </svg>
                    <div className="badge-row">
                      {lane.badges.map((badge) => (
                        <span key={`${lane.name}-${badge}`} className={`lane-badge badge-${badge}`}>
                          {badge}
                        </span>
                      ))}
                    </div>
                  </article>
                ))}
              </div>
            )}
          </div>

          <div className="viz-group">
            <div className="row event-loop-title">
              <h3>Deep Trace Insights</h3>
              {executionHealth ? <span className={`risk-chip risk-${executionHealth.risk}`}>{executionHealth.risk}</span> : null}
            </div>
            {!executionHealth ? (
              <p className="empty">Run code to compute risk scoring and anomaly diagnostics.</p>
            ) : (
              <>
                <div className="health-strip">
                  <div className="health-score" style={{ width: `${executionHealth.score}%` }} />
                </div>
                <p className="small">Execution quality score: {executionHealth.score}/100</p>
                <div className="insight-list">
                  {anomalyInsights.map((insight) => (
                    <p key={insight}>{insight}</p>
                  ))}
                </div>
              </>
            )}
          </div>

          <div className="viz-group">
            <h3>Execution Milestones</h3>
            {!trace ? (
              <p className="empty">Run code to generate milestone checkpoints.</p>
            ) : timelineMilestones.length === 0 ? (
              <p className="empty">No major transitions detected in this run.</p>
            ) : (
              <div className="milestone-list">
                {timelineMilestones.map((milestone) => (
                  <button key={`${milestone.step}-${milestone.line}`} onClick={() => setStepIndex(milestone.step)}>
                    <span>
                      Step {milestone.step + 1} • line {milestone.line}
                    </span>
                    <small>{milestone.headline}</small>
                    <small className="muted">{milestone.detail}</small>
                  </button>
                ))}
              </div>
            )}
          </div>

          {activeSnapshot?.eventLoop.enabled ? (
            <div className="viz-group">
              <div className="row event-loop-title">
                <h3>JavaScript Event Loop</h3>
                <span className="phase-chip">{activeSnapshot.eventLoop.phase}</span>
              </div>
              <div className="event-loop-grid">
                {renderQueue(
                  'Web APIs',
                  activeSnapshot.eventLoop.webApis,
                  'No timers or browser tasks are waiting.',
                )}
                {renderQueue(
                  'Microtask Queue',
                  activeSnapshot.eventLoop.microtasks,
                  'No promise jobs or queueMicrotask callbacks.',
                )}
                {renderQueue(
                  'Macrotask Queue',
                  activeSnapshot.eventLoop.macrotasks,
                  'No timer callbacks are queued.',
                )}
              </div>
              <div className="current-task-banner">
                <span>Currently active task</span>
                <strong>{activeSnapshot.eventLoop.currentTask}</strong>
              </div>
            </div>
          ) : (
            <div className="viz-group">
              <h3>Execution Model</h3>
              <p className="empty">
                Event loop lanes are shown for JavaScript and TypeScript. C and C++ stay focused on stack frames, pointers, and memory flow.
              </p>
            </div>
          )}

          <div className="viz-group">
            <h3>Call Stack</h3>
            <div className="stack-list">
              {(activeSnapshot?.callStack ?? []).length === 0 ? (
                <p className="empty">Run execution to view call frames.</p>
              ) : (
                activeSnapshot?.callStack
                  .slice()
                  .reverse()
                  .map((frame) => (
                    <motion.div
                      key={`${frame.name}-${frame.line}-${frame.variables.length}`}
                      className="stack-item"
                      initial={{ opacity: 0, y: 12 }}
                      animate={{ opacity: 1, y: 0 }}
                      transition={{ duration: 0.25 }}
                    >
                      <div className="row">
                        <strong>{frame.name}</strong>
                        <span>line {frame.line}</span>
                      </div>
                    </motion.div>
                  ))
              )}
            </div>
          </div>

          <div className="viz-group">
            <h3>Stack Memory (Variables by Scope)</h3>
            <div className="scope-filter">
              <label>
                Scope
                <select value={selectedScope} onChange={(event) => setSelectedScope(event.target.value)}>
                  {scopeOptions.map((option) => (
                    <option key={option} value={option}>
                      {option}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            {(activeSnapshot?.stackMemory ?? []).map((frame) => (
              <div key={`${frame.name}-${frame.line}`} className="memory-frame">
                <h4>{frame.name}</h4>
                {renderVariables(
                  selectedScope === 'all'
                    ? frame.variables
                    : frame.variables.filter((variable) => variable.scope === selectedScope),
                )}
              </div>
            ))}
          </div>

          <div className="viz-group">
            <h3>Watch Expressions</h3>
            <div className="watch-controls">
              <input
                type="text"
                value={watchInput}
                onChange={(event) => setWatchInput(event.target.value)}
                placeholder="e.g. total + 2"
              />
              <button onClick={addWatchExpression}>Add Watch</button>
            </div>
            {watchValues.length === 0 ? (
              <p className="empty">No watch expressions configured.</p>
            ) : (
              <div className="watch-list">
                {watchValues.map((watch) => (
                  <div key={watch.expression} className="watch-item">
                    <p>{watch.expression}</p>
                    <p className={watch.status === 'ok' ? 'watch-ok' : 'watch-error'}>{watch.value}</p>
                    <button onClick={() => removeWatchExpression(watch.expression)}>Remove</button>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="viz-group">
            <h3>Variable Timeline Explorer</h3>
            {!trace ? (
              <p className="empty">Run code to inspect variable change history over time.</p>
            ) : variableTimeline.catalog.length === 0 ? (
              <p className="empty">No tracked variables in this trace.</p>
            ) : (
              <>
                <label>
                  Variable
                  <select
                    value={selectedVariableAddress}
                    onChange={(event) => setSelectedVariableAddress(event.target.value)}
                  >
                    {variableTimeline.catalog.map((item) => (
                      <option key={item.address} value={item.address}>
                        {item.label}
                      </option>
                    ))}
                  </select>
                </label>

                {selectedVariableTransitions.length === 0 ? (
                  <p className="empty">This variable had no value transitions in the current run.</p>
                ) : (
                  <div className="timeline-table">
                    {selectedVariableTransitions.map((entry) => (
                      <button key={`${entry.step}-${entry.address}`} onClick={() => setStepIndex(entry.step)}>
                        <span>
                          Step {entry.step + 1} • line {entry.line}
                        </span>
                        <small>
                          {entry.from} {'->'} {entry.to}
                        </small>
                      </button>
                    ))}
                  </div>
                )}
              </>
            )}
          </div>

          <div className="viz-group">
            <h3>Console Output</h3>
            {(activeSnapshot?.eventLoop.logs ?? []).length === 0 ? (
              <p className="empty">Nothing has been logged yet.</p>
            ) : (
              <div className="console-output">
                {activeSnapshot?.eventLoop.logs.map((entry) => (
                  <p key={entry}>{entry}</p>
                ))}
              </div>
            )}
          </div>

          <div className="viz-group">
            <h3>Heap Memory</h3>
            {(activeSnapshot?.heapMemory ?? []).length === 0 ? (
              <p className="empty">No heap allocations yet.</p>
            ) : (
              <div className="heap-list">
                {activeSnapshot?.heapMemory.map((entry) => (
                  <div key={entry.address} className="heap-item">
                    <p>{entry.address}</p>
                    <p>{entry.type}</p>
                    <p>{entry.value}</p>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="viz-group">
            <h3>Data Structures</h3>
            {(activeSnapshot?.structures ?? []).length === 0 ? (
              <p className="empty">No arrays/objects/structs tracked yet.</p>
            ) : (
              <div className="heap-list">
                {activeSnapshot?.structures.map((structure) => (
                  <div key={`${structure.address}-${structure.name}`} className="heap-item">
                    <p>{structure.name}</p>
                    <p>{structure.type}</p>
                    <p>{structure.preview}</p>
                  </div>
                ))}
              </div>
            )}
          </div>
        </section>
      </main>
    </div>
  )
}

export default App
