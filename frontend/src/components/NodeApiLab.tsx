import { useMemo, useState } from 'react'

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

const defaultApiCode = `
app.get('/health', () => ({
  status: 200,
  body: { ok: true, service: 'node-api-lab' },
}))

app.get('/users', () => ({
  status: 200,
  body: [
    { id: 1, name: 'Ada' },
    { id: 2, name: 'Linus' },
  ],
}))

app.get('/users/:id', (req) => ({
  status: 200,
  body: { id: Number(req.params.id), name: 'User #' + req.params.id },
}))

app.post('/echo', (req) => ({
  status: 201,
  body: {
    received: req.body,
    query: req.query,
  },
}))
`.trim()

const defaultRequestBody = '{\n  "name": "new user"\n}'
const defaultRequestHeaders = '{\n  "x-client": "browser-lab"\n}'

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

function buildRoutes(code: string): { routes: RegisteredRoute[]; error?: string } {
  const routes: RegisteredRoute[] = []

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

  try {
    const register = new Function('app', code)
    register(app)
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

function NodeApiLab() {
  const [apiCode, setApiCode] = useState(defaultApiCode)
  const [isServerRunning, setIsServerRunning] = useState(false)
  const [serverError, setServerError] = useState<string | null>(null)
  const [method, setMethod] = useState<HttpMethod>('GET')
  const [requestUrl, setRequestUrl] = useState('/health')
  const [requestHeaders, setRequestHeaders] = useState(defaultRequestHeaders)
  const [requestBody, setRequestBody] = useState(defaultRequestBody)
  const [response, setResponse] = useState<ClientResponse | null>(null)
  const [requestHistory, setRequestHistory] = useState<RequestHistoryEntry[]>([])
  const [isSending, setIsSending] = useState(false)

  const compiled = useMemo(() => buildRoutes(apiCode), [apiCode])

  const startServer = () => {
    if (compiled.error) {
      setServerError(compiled.error)
      setIsServerRunning(false)
      return
    }

    setServerError(null)
    setIsServerRunning(true)
  }

  const stopServer = () => {
    setIsServerRunning(false)
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
    if (!parsedHeaders.ok || typeof parsedHeaders.data !== 'object' || parsedHeaders.data === null || Array.isArray(parsedHeaders.data)) {
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

    setRequestHistory((current) => [
      {
        id: Date.now(),
        method,
        url: requestUrl,
        status: result.status,
        durationMs: result.durationMs,
        at: new Date().toLocaleTimeString(),
      },
      ...current,
    ].slice(0, 12))
  }

  return (
    <section className="node-api-lab panel">
      <div className="panel-title">
        <h2>Node.js Browser API Lab</h2>
        <span>Create routes + call REST endpoints in-browser</span>
      </div>

      <div className="node-api-topbar">
        <div className="row">
          <span className={`status-pill ${isServerRunning ? 'status-success' : 'status-idle'}`}>
            {isServerRunning ? 'SERVER RUNNING' : 'SERVER STOPPED'}
          </span>
          <span className="small">Routes: {compiled.routes.length}</span>
        </div>
        <div className="node-api-actions">
          <button onClick={startServer}>Start Server</button>
          <button onClick={stopServer}>Stop Server</button>
          <button
            onClick={() => {
              setApiCode(defaultApiCode)
              setServerError(null)
            }}
          >
            Reset Code
          </button>
        </div>
      </div>

      {serverError ? <p className="watch-error">Route compile error: {serverError}</p> : null}

      <div className="node-api-grid">
        <div className="node-editor">
          <h3>server.js (browser simulation)</h3>
          <p className="small">Use app.get/post/put/patch/delete(path, handler). Return {`{ status, body, headers }`} or any JSON.</p>
          <textarea
            className="node-code-input"
            value={apiCode}
            onChange={(event) => setApiCode(event.target.value)}
            spellCheck={false}
          />
        </div>

        <div className="node-client">
          <h3>REST Client</h3>
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
              {response ? <span>Status {response.status}</span> : null}
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
