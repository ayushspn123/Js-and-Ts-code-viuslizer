import { useEffect, useMemo, useRef, useState } from 'react'
import { motion } from 'framer-motion'
import Editor from '@monaco-editor/react'
import type { editor } from 'monaco-editor'
import { Parser } from 'expr-eval'
import './App.css'
import { languagePresets } from './data/presets'
import { generateExecutionTrace } from './engine/traceEngine'
import type { ExecutionTrace, RuntimeVariable, SupportedLanguage } from './types'

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

    const lineDecorations = [
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
  }, [activeSnapshot?.line, breakpointLines])

  const runTrace = () => {
    const nextTrace = generateExecutionTrace(code, language)
    setTrace(nextTrace)
    setStepIndex(0)
    setIsPlaying(false)

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
                  {change.scope}.{change.name}: {change.from} -> {change.to}
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
