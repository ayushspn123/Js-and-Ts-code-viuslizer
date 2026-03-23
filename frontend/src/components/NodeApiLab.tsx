import { useMemo, useRef, useState } from 'react'

type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'

type RouteHandler = (request: {
  method: HttpMethod
  path: string
  query: Record<string, string>
  params: Record<string, string>
  body: unknown
  headers: Record<string, string>
}) => unknown | Promise<unknown>

type RegisteredRoute = {
  method: HttpMethod
  path: string
  handler: RouteHandler
}

type CompiledRoutes = {
  routes: RegisteredRoute[]
  error?: string
}

type ClientResponse = {
  ok: boolean
  status: number
  body: unknown
  headers: Record<string, string>
  durationMs: number
  error?: string
}

type RequestHistoryEntry = {
  id: number
  method: HttpMethod
  url: string
  status: number
  durationMs: number
  at: string
}

type VirtualFile = {
  id: number
  name: string
  content: string
}

const defaultFiles: VirtualFile[] = [
  {
    id: 1,
    name: 'server.js',
    content: `const users = requireFile('./routes/users.js')
const tasks = requireFile('./routes/tasks.js')

app.get('/health', () => ({
  status: 200,
  body: { ok: true, service: 'node-api-lab', env: 'browser' },
}))

users.registerUserRoutes(app)
tasks.registerTaskRoutes(app)

app.post('/echo', (req) => ({
  status: 201,
  body: {
    headers: req.headers,
    body: req.body,
    query: req.query,
  },
}))`,
  },
  {
    id: 2,
    name: 'routes/users.js',
    content: `const seedUsers = [
  { id: 1, name: 'Ada' },
  { id: 2, name: 'Linus' },
]

exports.registerUserRoutes = (app) => {
  app.get('/users', () => ({ status: 200, body: seedUsers }))

  app.get('/users/:id', (req) => {
    const id = Number(req.params.id)
    const user = seedUsers.find((item) => item.id === id)

    if (!user) {
      return { status: 404, body: { message: 'User not found' } }
    }

    return { status: 200, body: user }
  })
}`,
  },
  {
    id: 3,
    name: 'routes/tasks.js',
    content: `const taskStore = [
  { id: 101, title: 'Design routes', done: false },
  { id: 102, title: 'Test endpoint', done: true },
]

exports.registerTaskRoutes = (app) => {
  app.get('/tasks', () => ({ status: 200, body: taskStore }))

  app.post('/tasks', (req) => {
    const next = {
      id: Date.now(),
      title: req.body?.title ?? 'Untitled task',
      done: false,
    }
    taskStore.push(next)
    return { status: 201, body: next }
  })
}`,
  },
]

const defaultRequestBody = '{\n  "title": "Ship better API lab"\n}'
const defaultRequestHeaders = '{\n  "x-client": "browser-lab"\n}'

function normalizeFileName(rawName: string): string {
  const sanitized = rawName.trim().replace(/\\/g, '/')
  const compact = sanitized.replace(/^\/+/, '').replace(/\/+/g, '/')
  return compact || 'untitled.js'
}

function ensureJsExtension(fileName: string): string {
  return fileName.endsWith('.js') ? fileName : `${fileName}.js`
}

function dirname(path: string): string {
  const normalized = normalizeFileName(path)
  const parts = normalized.split('/')
  parts.pop()
  return parts.join('/')
}

function resolveImportPath(fromPath: string, requestedPath: string): string {
  const cleaned = requestedPath.trim()
  if (!cleaned) {
    return ''
  }

  if (cleaned.startsWith('/')) {
    return ensureJsExtension(normalizeFileName(cleaned.slice(1)))
  }

  if (!cleaned.startsWith('.')) {
    return ensureJsExtension(normalizeFileName(cleaned))
  }

  const sourceDir = dirname(fromPath)
  const sourceParts = sourceDir ? sourceDir.split('/') : []
  const requestParts = cleaned.split('/')

  requestParts.forEach((part) => {
    if (!part || part === '.') {
      return
    }
    if (part === '..') {
      sourceParts.pop()
      return
    }
    sourceParts.push(part)
  })

  return ensureJsExtension(normalizeFileName(sourceParts.join('/')))
}

function parseJsonSafe(value: string): { ok: true; data: unknown } | { ok: false; error: string } {
  const text = value.trim()
  if (!text) {
    return { ok: true, data: {} }
  }

  try {
    return { ok: true, data: JSON.parse(text) }
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : 'Invalid JSON',
    }
  }
}

function normalizeResponse(result: unknown): { status: number; body: unknown; headers: Record<string, string> } {
  if (result && typeof result === 'object' && !Array.isArray(result)) {
    const candidate = result as Record<string, unknown>
    const status = typeof candidate.status === 'number' ? candidate.status : 200
    const body = candidate.body ?? result
    const headers =
      candidate.headers && typeof candidate.headers === 'object' && !Array.isArray(candidate.headers)
        ? Object.fromEntries(
            Object.entries(candidate.headers as Record<string, unknown>).map(([key, value]) => [key, String(value)]),
          )
        : { 'content-type': 'application/json' }

    return { status, body, headers }
  }

  return {
    status: 200,
    body: result,
    headers: { 'content-type': 'application/json' },
  }
}

function parseUrlPath(input: string): { path: string; query: Record<string, string> } {
  const value = input.trim() || '/'
  const [pathPart, queryPart] = value.split('?')
  const query: Record<string, string> = {}

  if (queryPart) {
    const params = new URLSearchParams(queryPart)
    params.forEach((paramValue, paramKey) => {
      query[paramKey] = paramValue
    })
  }

  return {
    path: pathPart.startsWith('/') ? pathPart : `/${pathPart}`,
    query,
  }
}

function matchPath(routePath: string, requestPath: string): { matched: boolean; params: Record<string, string> } {
  const routeSegments = routePath.split('/').filter(Boolean)
  const requestSegments = requestPath.split('/').filter(Boolean)

  if (routeSegments.length !== requestSegments.length) {
    return { matched: false, params: {} }
  }

  const params: Record<string, string> = {}
  for (let index = 0; index < routeSegments.length; index += 1) {
    const routeSegment = routeSegments[index]
    const requestSegment = requestSegments[index]

    if (routeSegment.startsWith(':')) {
      params[routeSegment.slice(1)] = requestSegment
      continue
    }

    if (routeSegment !== requestSegment) {
      return { matched: false, params: {} }
    }
  }

  return { matched: true, params }
}

function buildRoutesFromFiles(files: VirtualFile[]): CompiledRoutes {
  const routes: RegisteredRoute[] = []
  const fileMap = new Map<string, VirtualFile>()

  files.forEach((file) => {
    fileMap.set(normalizeFileName(file.name), {
      ...file,
      name: normalizeFileName(file.name),
    })
  })

  const app = {
    get: (path: string, handler: RouteHandler) => {
      routes.push({ method: 'GET', path, handler })
    },
    post: (path: string, handler: RouteHandler) => {
      routes.push({ method: 'POST', path, handler })
    },
    put: (path: string, handler: RouteHandler) => {
      routes.push({ method: 'PUT', path, handler })
    },
    patch: (path: string, handler: RouteHandler) => {
      routes.push({ method: 'PATCH', path, handler })
    },
    delete: (path: string, handler: RouteHandler) => {
      routes.push({ method: 'DELETE', path, handler })
    },
  }

  const moduleCache = new Map<string, unknown>()
  const visiting = new Set<string>()

  const executeModule = (modulePath: string): unknown => {
    const normalizedPath = normalizeFileName(modulePath)

    if (moduleCache.has(normalizedPath)) {
      return moduleCache.get(normalizedPath)
    }

    if (visiting.has(normalizedPath)) {
      throw new Error(`Circular import detected at ${normalizedPath}`)
    }

    const target = fileMap.get(normalizedPath)
    if (!target) {
      throw new Error(`Module not found: ${normalizedPath}`)
    }

    visiting.add(normalizedPath)

    const module = { exports: {} as Record<string, unknown> }
    const requireFile = (relativePath: string): unknown => {
      const resolvedPath = resolveImportPath(normalizedPath, relativePath)
      return executeModule(resolvedPath)
    }

    try {
      const runModule = new Function('module', 'exports', 'requireFile', 'app', target.content)
      runModule(module, module.exports, requireFile, app)
      moduleCache.set(normalizedPath, module.exports)
      visiting.delete(normalizedPath)
      return module.exports
    } catch (error) {
      visiting.delete(normalizedPath)
      throw new Error(
        `Compile error in ${normalizedPath}: ${error instanceof Error ? error.message : 'unknown error'}`,
      )
    }
  }

  try {
    if (!fileMap.has('server.js')) {
      return {
        routes: [],
        error: 'Missing server.js. Create server.js to register routes.',
      }
    }

    const serverExports = executeModule('server.js')
    if (typeof serverExports === 'function') {
      ;(serverExports as (api: typeof app) => unknown)(app)
    }

    return { routes }
  } catch (error) {
    return {
      routes: [],
      error: error instanceof Error ? error.message : 'Could not compile routes',
    }
  }
}

async function executeRequest(
  routes: RegisteredRoute[],
  method: HttpMethod,
  rawUrl: string,
  headers: Record<string, string>,
  body: unknown,
): Promise<ClientResponse> {
  const startedAt = performance.now()
  const { path, query } = parseUrlPath(rawUrl)

  for (const route of routes) {
    if (route.method !== method) {
      continue
    }

    const match = matchPath(route.path, path)
    if (!match.matched) {
      continue
    }

    try {
      const result = await route.handler({
        method,
        path,
        query,
        params: match.params,
        body,
        headers,
      })
      const normalized = normalizeResponse(result)

      return {
        ok: normalized.status >= 200 && normalized.status < 400,
        status: normalized.status,
        body: normalized.body,
        headers: normalized.headers,
        durationMs: Math.round(performance.now() - startedAt),
      }
    } catch (error) {
      return {
        ok: false,
        status: 500,
        body: null,
        headers: { 'content-type': 'application/json' },
        durationMs: Math.round(performance.now() - startedAt),
        error: error instanceof Error ? error.message : 'Route execution failed',
      }
    }
  }

  return {
    ok: false,
    status: 404,
    body: { message: `No route for ${method} ${path}` },
    headers: { 'content-type': 'application/json' },
    durationMs: Math.round(performance.now() - startedAt),
  }
}

function formatUnknown(value: unknown): string {
  if (typeof value === 'string') {
    return value
  }

  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

function suggestedUrl(path: string): string {
  return path.replace(/:[A-Za-z_][\w]*/g, '1')
}

function downloadText(fileName: string, content: string): void {
  const blob = new Blob([content], { type: 'application/json;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = fileName
  anchor.click()
  URL.revokeObjectURL(url)
}

function NodeApiLab() {
  const [files, setFiles] = useState<VirtualFile[]>(defaultFiles)
  const [activeFileName, setActiveFileName] = useState('server.js')
  const [newFileName, setNewFileName] = useState('')
  const [isServerRunning, setIsServerRunning] = useState(false)
  const [serverError, setServerError] = useState<string | null>(null)
  const [method, setMethod] = useState<HttpMethod>('GET')
  const [requestUrl, setRequestUrl] = useState('/health')
  const [requestHeaders, setRequestHeaders] = useState(defaultRequestHeaders)
  const [requestBody, setRequestBody] = useState(defaultRequestBody)
  const [response, setResponse] = useState<ClientResponse | null>(null)
  const [requestHistory, setRequestHistory] = useState<RequestHistoryEntry[]>([])
  const [isSending, setIsSending] = useState(false)
  const [fileError, setFileError] = useState<string | null>(null)
  const [projectStatus, setProjectStatus] = useState('')
  const importProjectRef = useRef<HTMLInputElement | null>(null)
  const importFileRef = useRef<HTMLInputElement | null>(null)

  const compiled = useMemo(() => buildRoutesFromFiles(files), [files])

  const activeFile = useMemo(() => {
    return files.find((file) => file.name === activeFileName) ?? files[0] ?? null
  }, [activeFileName, files])

  const startServer = () => {
    if (compiled.error) {
      setServerError(compiled.error)
      setIsServerRunning(false)
      return
    }

    setServerError(null)
    setProjectStatus('Server booted in browser simulation mode.')
    setIsServerRunning(true)
  }

  const stopServer = () => {
    setProjectStatus('Server stopped.')
    setIsServerRunning(false)
  }

  const createFile = () => {
    const normalized = ensureJsExtension(normalizeFileName(newFileName || `new-file-${Date.now()}.js`))

    if (files.some((file) => file.name === normalized)) {
      setFileError(`File already exists: ${normalized}`)
      return
    }

    setFiles((current) => [...current, { id: Date.now(), name: normalized, content: '// new module\n' }])
    setActiveFileName(normalized)
    setNewFileName('')
    setFileError(null)
    setProjectStatus(`Created ${normalized}`)
  }

  const removeActiveFile = () => {
    if (!activeFile) {
      return
    }

    if (activeFile.name === 'server.js') {
      setFileError('server.js cannot be deleted. It is the API entry module.')
      return
    }

    const nextFiles = files.filter((file) => file.name !== activeFile.name)
    setFiles(nextFiles)
    setActiveFileName('server.js')
    setProjectStatus(`Deleted ${activeFile.name}`)
  }

  const updateActiveFile = (content: string) => {
    if (!activeFile) {
      return
    }

    setFiles((current) =>
      current.map((file) => {
        if (file.name !== activeFile.name) {
          return file
        }

        return { ...file, content }
      }),
    )
  }

  const exportProject = () => {
    const payload = {
      version: 1,
      generatedAt: new Date().toISOString(),
      files,
    }

    downloadText('node-api-lab.project.json', JSON.stringify(payload, null, 2))
    setProjectStatus('Project exported.')
  }

  const exportActiveFile = () => {
    if (!activeFile) {
      return
    }

    downloadText(activeFile.name, activeFile.content)
    setProjectStatus(`Exported ${activeFile.name}`)
  }

  const handleProjectImport = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const picked = event.target.files?.[0]
    if (!picked) {
      return
    }

    const text = await picked.text()
    const parsed = parseJsonSafe(text)
    if (!parsed.ok || typeof parsed.data !== 'object' || !parsed.data) {
      setFileError('Invalid project file.')
      return
    }

    const payload = parsed.data as { files?: unknown }
    if (!Array.isArray(payload.files)) {
      setFileError('Project file must contain a files array.')
      return
    }

    const importedFiles: VirtualFile[] = payload.files
      .map((item, index) => {
        if (!item || typeof item !== 'object') {
          return null
        }

        const candidate = item as { name?: unknown; content?: unknown }
        if (typeof candidate.name !== 'string' || typeof candidate.content !== 'string') {
          return null
        }

        return {
          id: Date.now() + index,
          name: ensureJsExtension(normalizeFileName(candidate.name)),
          content: candidate.content,
        }
      })
      .filter((item): item is VirtualFile => item !== null)

    if (importedFiles.length === 0) {
      setFileError('No valid files found in project import.')
      return
    }

    if (!importedFiles.some((file) => file.name === 'server.js')) {
      importedFiles.unshift({
        id: Date.now() - 1,
        name: 'server.js',
        content: `app.get('/health', () => ({ status: 200, body: { ok: true } }))`,
      })
    }

    setFiles(importedFiles)
    setActiveFileName('server.js')
    setFileError(null)
    setProjectStatus(`Imported ${importedFiles.length} file(s).`)
    event.target.value = ''
  }

  const handleFileImport = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const picked = event.target.files?.[0]
    if (!picked) {
      return
    }

    const content = await picked.text()
    const normalizedName = ensureJsExtension(normalizeFileName(picked.name))

    setFiles((current) => {
      const exists = current.find((file) => file.name === normalizedName)
      if (!exists) {
        return [...current, { id: Date.now(), name: normalizedName, content }]
      }

      return current.map((file) => (file.name === normalizedName ? { ...file, content } : file))
    })

    setActiveFileName(normalizedName)
    setFileError(null)
    setProjectStatus(`Imported ${normalizedName}`)
    event.target.value = ''
  }

  const sendRequest = async () => {
    if (!isServerRunning) {
      setResponse({
        ok: false,
        status: 503,
        body: null,
        headers: {},
        durationMs: 0,
        error: 'Server is not running. Click Start Server first.',
      })
      return
    }

    const parsedHeaders = parseJsonSafe(requestHeaders)
    if (
      !parsedHeaders.ok ||
      typeof parsedHeaders.data !== 'object' ||
      parsedHeaders.data === null ||
      Array.isArray(parsedHeaders.data)
    ) {
      setResponse({
        ok: false,
        status: 400,
        body: null,
        headers: {},
        durationMs: 0,
        error: parsedHeaders.ok ? 'Headers must be a JSON object.' : `Invalid headers JSON: ${parsedHeaders.error}`,
      })
      return
    }

    const parsedBody = parseJsonSafe(requestBody)
    if (!parsedBody.ok) {
      setResponse({
        ok: false,
        status: 400,
        body: null,
        headers: {},
        durationMs: 0,
        error: `Invalid body JSON: ${parsedBody.error}`,
      })
      return
    }

    setIsSending(true)
    const result = await executeRequest(
      compiled.routes,
      method,
      requestUrl,
      Object.fromEntries(
        Object.entries(parsedHeaders.data as Record<string, unknown>).map(([key, value]) => [key, String(value)]),
      ),
      parsedBody.data,
    )
    setIsSending(false)
    setResponse(result)

    setRequestHistory((current) =>
      [
        {
          id: Date.now(),
          method,
          url: requestUrl,
          status: result.status,
          durationMs: result.durationMs,
          at: new Date().toLocaleTimeString(),
        },
        ...current,
      ].slice(0, 14),
    )
  }

  return (
    <section className="node-api-lab panel">
      <div className="panel-title">
        <h2>Node.js Browser API Lab</h2>
        <span>Multi-file project + import/export + REST testing</span>
      </div>

      <input ref={importProjectRef} type="file" accept="application/json" hidden onChange={handleProjectImport} />
      <input ref={importFileRef} type="file" accept=".js,text/javascript" hidden onChange={handleFileImport} />

      <div className="node-api-topbar">
        <div className="row">
          <span className={`status-pill ${isServerRunning ? 'status-success' : 'status-idle'}`}>
            {isServerRunning ? 'SERVER RUNNING' : 'SERVER STOPPED'}
          </span>
          <span className="small">Routes: {compiled.routes.length}</span>
          <span className="small">Files: {files.length}</span>
        </div>
        <div className="node-api-actions">
          <button onClick={startServer}>Start Server</button>
          <button onClick={stopServer}>Stop Server</button>
          <button onClick={exportProject}>Export Project</button>
          <button onClick={exportActiveFile}>Export File</button>
          <button onClick={() => importProjectRef.current?.click()}>Import Project</button>
          <button onClick={() => importFileRef.current?.click()}>Import File</button>
          <button
            onClick={() => {
              setFiles(defaultFiles)
              setActiveFileName('server.js')
              setFileError(null)
              setProjectStatus('Reset to starter project.')
            }}
          >
            Reset
          </button>
        </div>
      </div>

      {serverError ? <p className="watch-error">Route compile error: {serverError}</p> : null}
      {fileError ? <p className="watch-error">{fileError}</p> : null}
      {projectStatus ? <p className="small">{projectStatus}</p> : null}

      <div className="node-api-grid">
        <div className="node-editor">
          <div className="row">
            <h3>Project Files</h3>
            <span className="small">Entry file: server.js</span>
          </div>

          <div className="node-file-create">
            <input
              type="text"
              value={newFileName}
              onChange={(event) => setNewFileName(event.target.value)}
              placeholder="routes/orders.js"
            />
            <button onClick={createFile}>Create File</button>
            <button onClick={removeActiveFile} disabled={!activeFile || activeFile.name === 'server.js'}>
              Delete Active
            </button>
          </div>

          <div className="node-file-list">
            {files.map((file) => (
              <button
                key={file.id}
                className={activeFile?.name === file.name ? 'active' : ''}
                onClick={() => setActiveFileName(file.name)}
              >
                {file.name}
              </button>
            ))}
          </div>

          <div className="row node-file-heading">
            <h4>{activeFile?.name ?? 'No file selected'}</h4>
          </div>

          <textarea
            className="node-code-input"
            value={activeFile?.content ?? ''}
            onChange={(event) => updateActiveFile(event.target.value)}
            spellCheck={false}
          />
        </div>

        <div className="node-client">
          <h3>REST Client + Endpoint Catalog</h3>
          <div className="node-client-row">
            <select value={method} onChange={(event) => setMethod(event.target.value as HttpMethod)}>
              <option value="GET">GET</option>
              <option value="POST">POST</option>
              <option value="PUT">PUT</option>
              <option value="PATCH">PATCH</option>
              <option value="DELETE">DELETE</option>
            </select>
            <input
              type="text"
              value={requestUrl}
              onChange={(event) => setRequestUrl(event.target.value)}
              placeholder="/users/1?expand=true"
            />
            <button onClick={() => void sendRequest()} disabled={isSending}>
              {isSending ? 'Sending...' : 'Send'}
            </button>
          </div>

          <div className="node-route-catalog">
            <h4>Registered Endpoints</h4>
            {compiled.routes.length === 0 ? (
              <p className="empty">No routes compiled yet.</p>
            ) : (
              compiled.routes.map((route, index) => (
                <button
                  key={`${route.method}-${route.path}-${index}`}
                  onClick={() => {
                    setMethod(route.method)
                    setRequestUrl(suggestedUrl(route.path))
                  }}
                >
                  <span className="status-pill">{route.method}</span>
                  <span>{route.path}</span>
                </button>
              ))
            )}
          </div>

          <label>
            Headers (JSON)
            <textarea
              className="node-json-input"
              value={requestHeaders}
              onChange={(event) => setRequestHeaders(event.target.value)}
              spellCheck={false}
            />
          </label>

          <label>
            Body (JSON)
            <textarea
              className="node-json-input"
              value={requestBody}
              onChange={(event) => setRequestBody(event.target.value)}
              spellCheck={false}
            />
          </label>

          <div className="node-response">
            <div className="row">
              <h4>Response</h4>
              {response ? (
                <span className={`status-pill ${response.ok ? 'status-success' : 'status-error'}`}>Status {response.status}</span>
              ) : null}
            </div>
            {!response ? (
              <p className="empty">Send a request to view response payload.</p>
            ) : (
              <>
                {response.error ? <p className="watch-error">{response.error}</p> : null}
                <p className="small">Duration: {response.durationMs}ms</p>
                <p className="small">Headers: {formatUnknown(response.headers)}</p>
                <pre>{formatUnknown(response.body)}</pre>
              </>
            )}
          </div>

          <div className="node-history">
            <h4>Request History</h4>
            {requestHistory.length === 0 ? (
              <p className="empty">No requests yet.</p>
            ) : (
              requestHistory.map((entry) => (
                <button
                  key={entry.id}
                  onClick={() => {
                    setMethod(entry.method)
                    setRequestUrl(entry.url)
                  }}
                >
                  <span>{entry.at}</span>
                  <span>
                    {entry.method} {entry.url}
                  </span>
                  <span>
                    {entry.status} ({entry.durationMs}ms)
                  </span>
                </button>
              ))
            )}
          </div>
        </div>
      </div>
    </section>
  )
}

export default NodeApiLab
