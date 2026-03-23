import { useEffect, useMemo, useRef, useState } from 'react'
import { motion } from 'framer-motion'
import Editor from '@monaco-editor/react'
import type { editor } from 'monaco-editor'
import { Parser } from 'expr-eval'
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
  const [selectedRunId, setSelectedRunId] = useState<number | null>(null)
  const [heatmapEnabled, setHeatmapEnabled] = useState(true)
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
      }
    }

    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [trace, jumpToNextBreakpoint])

  const runTrace = () => {
    const nextTrace = generateExecutionTrace(code, language)
    const summary = buildRunSummary(nextTrace, code, language)
    setTrace(nextTrace)
    setStepIndex(0)
    setIsPlaying(false)
    setRunHistory((current) => [summary, ...current].slice(0, 8))

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

  const switchLanguage = (nextLanguage: SupportedLanguage) => {
    setLanguage(nextLanguage)
    setCode(languagePresets[nextLanguage].code)
    setTrace(null)
    setStepIndex(0)
    setIsPlaying(false)
    setSelectedScope('all')
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

  return (
    <div className="app-shell">
      <header className="app-header">
        <div>
          <p className="eyebrow">Code Execution Visualizer</p>
          <h1>Trace JavaScript, TypeScript, C, and C++ step-by-step</h1>
          <p className="hero-copy">
            Follow the call stack, memory, event loop queues, console output, and variable changes as each step executes.
          </p>
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
        </div>
      </header>

      <main className="layout">
        <section className="panel editor-panel">
          <div className="panel-title">
            <h2>Editor</h2>
            <span>{languagePresets[language].title}</span>
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
        </section>

        <section className="panel controls-panel">
          <div className="panel-title">
            <h2>Execution Controls</h2>
            <span>
              Step {trace ? Math.min(stepIndex + 1, trace.snapshots.length) : 0}/
              {trace?.snapshots.length ?? 0}
            </span>
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
            <button onClick={runTrace}>Run</button>
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
