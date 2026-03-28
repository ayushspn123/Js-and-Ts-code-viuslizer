import { useMemo, useState } from 'react'

type QueryMode = 'postgresql' | 'mongodb'

type TableRows = Record<string, Array<Record<string, unknown>>>

type QueryResult = {
  ok: boolean
  message: string
  rows: Array<Record<string, unknown>>
  touchedRows: number
}

const initialSqlTables: TableRows = {
  users: [
    { id: 1, name: 'Ada', age: 29, city: 'London', pro: true },
    { id: 2, name: 'Linus', age: 35, city: 'Helsinki', pro: false },
    { id: 3, name: 'Grace', age: 41, city: 'New York', pro: true },
  ],
  orders: [
    { id: 101, user_id: 1, total: 74.5, status: 'paid' },
    { id: 102, user_id: 2, total: 19.99, status: 'pending' },
    { id: 103, user_id: 3, total: 120, status: 'paid' },
  ],
  sandbox: [],
}

const initialMongoCollections: TableRows = {
  users: [
    { _id: 'u1', name: 'Ada', age: 29, city: 'London', skills: ['js', 'ts'] },
    { _id: 'u2', name: 'Linus', age: 35, city: 'Helsinki', skills: ['c', 'cpp'] },
    { _id: 'u3', name: 'Grace', age: 41, city: 'New York', skills: ['python', 'db'] },
  ],
  events: [
    { _id: 'e1', type: 'login', user: 'u1', success: true },
    { _id: 'e2', type: 'checkout', user: 'u3', success: true },
    { _id: 'e3', type: 'login', user: 'u2', success: false },
  ],
}

const defaultSqlQuery = `SELECT id, name, city FROM users WHERE age >= 30 ORDER BY age DESC LIMIT 5;`
const defaultMongoCommand = `{
  "action": "find",
  "collection": "users",
  "filter": { "age": { "$gte": 30 } },
  "projection": { "name": 1, "age": 1, "city": 1 },
  "limit": 10
}`

function deepClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function splitStatements(query: string): string[] {
  const statements: string[] = []
  let current = ''
  let quote: 'single' | 'double' | null = null

  for (const char of query) {
    if (char === "'" && quote === null) {
      quote = 'single'
      current += char
      continue
    }

    if (char === '"' && quote === null) {
      quote = 'double'
      current += char
      continue
    }

    if (quote === 'single' && char === "'") {
      quote = null
      current += char
      continue
    }

    if (quote === 'double' && char === '"') {
      quote = null
      current += char
      continue
    }

    if (char === ';' && quote === null) {
      if (current.trim()) {
        statements.push(current.trim())
      }
      current = ''
      continue
    }

    current += char
  }

  if (current.trim()) {
    statements.push(current.trim())
  }

  return statements
}

function parseLiteral(raw: string): unknown {
  const text = raw.trim()

  if (/^null$/i.test(text)) {
    return null
  }

  if (/^(true|false)$/i.test(text)) {
    return text.toLowerCase() === 'true'
  }

  if (/^-?\d+(\.\d+)?$/.test(text)) {
    return Number(text)
  }

  if (
    (text.startsWith("'") && text.endsWith("'")) ||
    (text.startsWith('"') && text.endsWith('"'))
  ) {
    return text.slice(1, -1)
  }

  if ((text.startsWith('{') && text.endsWith('}')) || (text.startsWith('[') && text.endsWith(']'))) {
    try {
      return JSON.parse(text)
    } catch {
      return text
    }
  }

  return text
}

function getFieldValue(row: Record<string, unknown>, key: string): unknown {
  if (!key.includes('.')) {
    return row[key]
  }

  const segments = key.split('.')
  let cursor: unknown = row
  for (const segment of segments) {
    if (cursor === null || typeof cursor !== 'object') {
      return undefined
    }
    cursor = (cursor as Record<string, unknown>)[segment]
  }
  return cursor
}

function matchesWhereCondition(row: Record<string, unknown>, condition: string): boolean {
  const parsed = condition.match(/^(\w+(?:\.\w+)*)\s*(=|!=|>=|<=|>|<|ILIKE)\s*(.+)$/i)
  if (!parsed) {
    return false
  }

  const [, column, operator, rawValue] = parsed
  const actual = getFieldValue(row, column)
  const expected = parseLiteral(rawValue)

  if (operator.toUpperCase() === 'ILIKE') {
    const actualText = String(actual ?? '').toLowerCase()
    const pattern = String(expected ?? '')
      .toLowerCase()
      .replace(/%/g, '.*')
    return new RegExp(`^${pattern}$`).test(actualText)
  }

  if (operator === '=') {
    return actual === expected
  }

  if (operator === '!=') {
    return actual !== expected
  }

  if (operator === '>') {
    return Number(actual) > Number(expected)
  }

  if (operator === '<') {
    return Number(actual) < Number(expected)
  }

  if (operator === '>=') {
    return Number(actual) >= Number(expected)
  }

  if (operator === '<=') {
    return Number(actual) <= Number(expected)
  }

  return false
}

function applyWhere(rows: Array<Record<string, unknown>>, whereClause: string | undefined): Array<Record<string, unknown>> {
  if (!whereClause) {
    return rows
  }

  const parts = whereClause
    .split(/\s+AND\s+/i)
    .map((part) => part.trim())
    .filter(Boolean)

  return rows.filter((row) => parts.every((part) => matchesWhereCondition(row, part)))
}

function parseTupleValues(valuesChunk: string): string[] {
  const values: string[] = []
  let token = ''
  let quote: 'single' | 'double' | null = null
  let depth = 0

  for (const char of valuesChunk) {
    if (char === "'" && quote === null) {
      quote = 'single'
      token += char
      continue
    }

    if (char === '"' && quote === null) {
      quote = 'double'
      token += char
      continue
    }

    if ((quote === 'single' && char === "'") || (quote === 'double' && char === '"')) {
      quote = null
      token += char
      continue
    }

    if (quote === null && (char === '{' || char === '[' || char === '(')) {
      depth += 1
      token += char
      continue
    }

    if (quote === null && (char === '}' || char === ']' || char === ')')) {
      depth -= 1
      token += char
      continue
    }

    if (quote === null && depth === 0 && char === ',') {
      values.push(token.trim())
      token = ''
      continue
    }

    token += char
  }

  if (token.trim()) {
    values.push(token.trim())
  }

  return values
}

function runPostgresLikeQuery(queryText: string, current: TableRows): { nextTables: TableRows; result: QueryResult } {
  const statements = splitStatements(queryText)
  if (statements.length === 0) {
    return {
      nextTables: current,
      result: { ok: false, message: 'Write a SQL query first.', rows: [], touchedRows: 0 },
    }
  }

  const next = deepClone(current)
  let lastRows: Array<Record<string, unknown>> = []
  let touchedRows = 0
  let lastMessage = 'Done.'

  for (const statement of statements) {
    const sql = statement.trim()

    if (/^show\s+tables$/i.test(sql)) {
      lastRows = Object.keys(next).map((name) => ({ table_name: name, rows: next[name].length }))
      lastMessage = 'Table inventory loaded.'
      continue
    }

    const describeMatch = sql.match(/^describe\s+(\w+)$/i)
    if (describeMatch) {
      const tableName = describeMatch[1]
      if (!next[tableName]) {
        throw new Error(`Table ${tableName} does not exist.`)
      }

      const first = next[tableName][0] ?? {}
      lastRows = Object.keys(first).map((column) => ({ column_name: column, sample_type: typeof first[column] }))
      lastMessage = `Schema from ${tableName} preview.`
      continue
    }

    const createMatch = sql.match(/^create\s+table\s+(\w+)\s*\((.+)\)$/i)
    if (createMatch) {
      const tableName = createMatch[1]
      if (!next[tableName]) {
        next[tableName] = []
      }
      lastRows = []
      lastMessage = `Table ${tableName} is ready.`
      continue
    }

    const insertMatch = sql.match(/^insert\s+into\s+(\w+)\s*\(([^)]+)\)\s*values\s*(.+)$/i)
    if (insertMatch) {
      const tableName = insertMatch[1]
      const columns = insertMatch[2].split(',').map((column) => column.trim())
      const tuplesPart = insertMatch[3].trim()

      if (!next[tableName]) {
        throw new Error(`Table ${tableName} does not exist.`)
      }

      const tupleMatches = [...tuplesPart.matchAll(/\(([^()]*)\)/g)]
      if (tupleMatches.length === 0) {
        throw new Error('Invalid VALUES tuple syntax.')
      }

      let inserted = 0
      for (const tuple of tupleMatches) {
        const values = parseTupleValues(tuple[1]).map((value) => parseLiteral(value))
        if (values.length !== columns.length) {
          throw new Error('Column count does not match values count.')
        }

        const row: Record<string, unknown> = {}
        columns.forEach((column, index) => {
          row[column] = values[index]
        })
        next[tableName].push(row)
        inserted += 1
      }

      touchedRows += inserted
      lastRows = []
      lastMessage = `Inserted ${inserted} row(s) into ${tableName}.`
      continue
    }

    const selectMatch = sql.match(
      /^select\s+(.+?)\s+from\s+(\w+)(?:\s+where\s+(.+?))?(?:\s+order\s+by\s+(\w+(?:\.\w+)*)(?:\s+(asc|desc))?)?(?:\s+limit\s+(\d+))?$/i,
    )
    if (selectMatch) {
      const columnsClause = selectMatch[1]
      const tableName = selectMatch[2]
      const whereClause = selectMatch[3]
      const orderByColumn = selectMatch[4]
      const orderDirection = (selectMatch[5] ?? 'asc').toLowerCase()
      const limitRaw = selectMatch[6]

      if (!next[tableName]) {
        throw new Error(`Table ${tableName} does not exist.`)
      }

      let rows = applyWhere(next[tableName], whereClause)

      if (orderByColumn) {
        rows = [...rows].sort((left, right) => {
          const leftValue = getFieldValue(left, orderByColumn)
          const rightValue = getFieldValue(right, orderByColumn)

          if (leftValue === rightValue) {
            return 0
          }

          if (leftValue === undefined || leftValue === null) {
            return orderDirection === 'asc' ? -1 : 1
          }

          if (rightValue === undefined || rightValue === null) {
            return orderDirection === 'asc' ? 1 : -1
          }

          if (leftValue > rightValue) {
            return orderDirection === 'asc' ? 1 : -1
          }

          return orderDirection === 'asc' ? -1 : 1
        })
      }

      const limit = limitRaw ? Number(limitRaw) : rows.length
      rows = rows.slice(0, Math.max(0, limit))

      const selectedColumns = columnsClause.trim() === '*' ? null : columnsClause.split(',').map((item) => item.trim())
      lastRows = selectedColumns
        ? rows.map((row) => {
            const projected: Record<string, unknown> = {}
            selectedColumns.forEach((column) => {
              projected[column] = getFieldValue(row, column)
            })
            return projected
          })
        : rows

      lastMessage = `Selected ${lastRows.length} row(s) from ${tableName}.`
      continue
    }

    const updateMatch = sql.match(/^update\s+(\w+)\s+set\s+(.+?)(?:\s+where\s+(.+))?$/i)
    if (updateMatch) {
      const tableName = updateMatch[1]
      const assignments = updateMatch[2]
      const whereClause = updateMatch[3]

      if (!next[tableName]) {
        throw new Error(`Table ${tableName} does not exist.`)
      }

      const assignmentPairs = assignments.split(',').map((pair) => pair.trim())
      const targetRows = applyWhere(next[tableName], whereClause)
      touchedRows += targetRows.length

      targetRows.forEach((row) => {
        assignmentPairs.forEach((pair) => {
          const splitIndex = pair.indexOf('=')
          if (splitIndex === -1) {
            return
          }
          const key = pair.slice(0, splitIndex).trim()
          const value = parseLiteral(pair.slice(splitIndex + 1).trim())
          row[key] = value
        })
      })

      lastRows = []
      lastMessage = `Updated ${targetRows.length} row(s) in ${tableName}.`
      continue
    }

    const deleteMatch = sql.match(/^delete\s+from\s+(\w+)(?:\s+where\s+(.+))?$/i)
    if (deleteMatch) {
      const tableName = deleteMatch[1]
      const whereClause = deleteMatch[2]

      if (!next[tableName]) {
        throw new Error(`Table ${tableName} does not exist.`)
      }

      if (!whereClause) {
        touchedRows += next[tableName].length
        next[tableName] = []
        lastRows = []
        lastMessage = `Deleted all rows from ${tableName}.`
        continue
      }

      const before = next[tableName].length
      next[tableName] = next[tableName].filter((row) => !applyWhere([row], whereClause).length)
      const removed = before - next[tableName].length
      touchedRows += removed
      lastRows = []
      lastMessage = `Deleted ${removed} row(s) from ${tableName}.`
      continue
    }

    throw new Error(`Unsupported SQL statement: ${sql}`)
  }

  return {
    nextTables: next,
    result: {
      ok: true,
      message: lastMessage,
      rows: lastRows,
      touchedRows,
    },
  }
}

function matchesMongoFilter(doc: Record<string, unknown>, filter: Record<string, unknown>): boolean {
  const entries = Object.entries(filter)
  for (const [key, condition] of entries) {
    if (key === '$and' && Array.isArray(condition)) {
      if (!condition.every((part) => typeof part === 'object' && part !== null && matchesMongoFilter(doc, part as Record<string, unknown>))) {
        return false
      }
      continue
    }

    if (key === '$or' && Array.isArray(condition)) {
      if (!condition.some((part) => typeof part === 'object' && part !== null && matchesMongoFilter(doc, part as Record<string, unknown>))) {
        return false
      }
      continue
    }

    const actual = getFieldValue(doc, key)

    if (typeof condition === 'object' && condition !== null && !Array.isArray(condition)) {
      const operators = condition as Record<string, unknown>
      for (const [operator, expected] of Object.entries(operators)) {
        if (operator === '$eq' && actual !== expected) {
          return false
        }
        if (operator === '$ne' && actual === expected) {
          return false
        }
        if (operator === '$gt' && !(Number(actual) > Number(expected))) {
          return false
        }
        if (operator === '$gte' && !(Number(actual) >= Number(expected))) {
          return false
        }
        if (operator === '$lt' && !(Number(actual) < Number(expected))) {
          return false
        }
        if (operator === '$lte' && !(Number(actual) <= Number(expected))) {
          return false
        }
        if (operator === '$in' && Array.isArray(expected) && !expected.includes(actual)) {
          return false
        }
        if (operator === '$regex') {
          const regex = new RegExp(String(expected), operators.$options ? String(operators.$options) : '')
          if (!regex.test(String(actual ?? ''))) {
            return false
          }
        }
      }
      continue
    }

    if (actual !== condition) {
      return false
    }
  }

  return true
}

function applyProjection(doc: Record<string, unknown>, projection: Record<string, unknown> | undefined): Record<string, unknown> {
  if (!projection || Object.keys(projection).length === 0) {
    return doc
  }

  const includedKeys = Object.entries(projection)
    .filter(([, value]) => Boolean(value))
    .map(([key]) => key)

  if (includedKeys.length === 0) {
    return doc
  }

  const projected: Record<string, unknown> = {}
  includedKeys.forEach((key) => {
    projected[key] = getFieldValue(doc, key)
  })
  return projected
}

function applyUpdate(document: Record<string, unknown>, update: Record<string, unknown>): Record<string, unknown> {
  const next = { ...document }
  const setPart = update.$set as Record<string, unknown> | undefined
  const incPart = update.$inc as Record<string, unknown> | undefined

  if (setPart) {
    Object.entries(setPart).forEach(([key, value]) => {
      next[key] = value
    })
  }

  if (incPart) {
    Object.entries(incPart).forEach(([key, value]) => {
      next[key] = Number(next[key] ?? 0) + Number(value)
    })
  }

  return next
}

function runMongoCommand(commandText: string, current: TableRows): { nextCollections: TableRows; result: QueryResult } {
  const command = JSON.parse(commandText) as {
    action?: string
    collection?: string
    filter?: Record<string, unknown>
    projection?: Record<string, unknown>
    sort?: Record<string, 1 | -1>
    limit?: number
    update?: Record<string, unknown>
    document?: Record<string, unknown>
    documents?: Array<Record<string, unknown>>
    pipeline?: Array<Record<string, unknown>>
  }

  const next = deepClone(current)
  const action = (command.action ?? 'find').toLowerCase()
  const collectionName = command.collection ?? 'users'

  if (!next[collectionName]) {
    next[collectionName] = []
  }

  const collection = next[collectionName]

  if (action === 'insert') {
    const docs = command.documents ?? (command.document ? [command.document] : [])
    if (docs.length === 0) {
      throw new Error('Mongo insert requires document or documents.')
    }
    docs.forEach((doc) => collection.push(doc))
    return {
      nextCollections: next,
      result: {
        ok: true,
        message: `Inserted ${docs.length} document(s) into ${collectionName}.`,
        rows: docs,
        touchedRows: docs.length,
      },
    }
  }

  if (action === 'updateMany') {
    if (!command.update) {
      throw new Error('Mongo updateMany requires update object.')
    }

    let updated = 0
    for (let index = 0; index < collection.length; index += 1) {
      if (matchesMongoFilter(collection[index], command.filter ?? {})) {
        collection[index] = applyUpdate(collection[index], command.update)
        updated += 1
      }
    }

    return {
      nextCollections: next,
      result: {
        ok: true,
        message: `Updated ${updated} document(s) in ${collectionName}.`,
        rows: [],
        touchedRows: updated,
      },
    }
  }

  if (action === 'deleteMany') {
    const before = collection.length
    next[collectionName] = collection.filter((doc) => !matchesMongoFilter(doc, command.filter ?? {}))
    const removed = before - next[collectionName].length

    return {
      nextCollections: next,
      result: {
        ok: true,
        message: `Deleted ${removed} document(s) from ${collectionName}.`,
        rows: [],
        touchedRows: removed,
      },
    }
  }

  if (action === 'count') {
    const matched = collection.filter((doc) => matchesMongoFilter(doc, command.filter ?? {}))
    return {
      nextCollections: next,
      result: {
        ok: true,
        message: `Counted ${matched.length} document(s).`,
        rows: [{ count: matched.length }],
        touchedRows: 0,
      },
    }
  }

  if (action === 'aggregate') {
    const pipeline = command.pipeline ?? []
    let currentRows = [...collection]

    pipeline.forEach((stage) => {
      if (stage.$match && typeof stage.$match === 'object') {
        currentRows = currentRows.filter((doc) => matchesMongoFilter(doc, stage.$match as Record<string, unknown>))
      }

      if (stage.$sort && typeof stage.$sort === 'object') {
        const [sortField, direction] = Object.entries(stage.$sort as Record<string, number>)[0] ?? []
        if (sortField) {
          currentRows = [...currentRows].sort((a, b) => {
            const left = getFieldValue(a, sortField)
            const right = getFieldValue(b, sortField)
            if (left === right) {
              return 0
            }
            if (left === undefined || left === null) {
              return -1
            }
            if (right === undefined || right === null) {
              return 1
            }
            if (left > right) {
              return direction === -1 ? -1 : 1
            }
            return direction === -1 ? 1 : -1
          })
        }
      }

      if (stage.$limit) {
        currentRows = currentRows.slice(0, Number(stage.$limit))
      }

      if (stage.$project && typeof stage.$project === 'object') {
        currentRows = currentRows.map((doc) => applyProjection(doc, stage.$project as Record<string, unknown>))
      }

      if (stage.$group && typeof stage.$group === 'object') {
        const groupStage = stage.$group as Record<string, unknown>
        const idField = String(groupStage._id ?? '').replace(/^\$/, '')
        const groups = new Map<string, { _id: unknown; count: number }>()

        currentRows.forEach((doc) => {
          const idValue = getFieldValue(doc, idField)
          const key = JSON.stringify(idValue)
          const entry = groups.get(key) ?? { _id: idValue, count: 0 }
          entry.count += 1
          groups.set(key, entry)
        })

        currentRows = [...groups.values()]
      }
    })

    return {
      nextCollections: next,
      result: {
        ok: true,
        message: `Aggregation returned ${currentRows.length} row(s).`,
        rows: currentRows,
        touchedRows: 0,
      },
    }
  }

  let rows = collection.filter((doc) => matchesMongoFilter(doc, command.filter ?? {}))

  if (command.sort && Object.keys(command.sort).length > 0) {
    const [sortField, direction] = Object.entries(command.sort)[0]
    rows = [...rows].sort((left, right) => {
      const leftValue = getFieldValue(left, sortField)
      const rightValue = getFieldValue(right, sortField)
      if (leftValue === rightValue) {
        return 0
      }
      if (leftValue === undefined || leftValue === null) {
        return -1
      }
      if (rightValue === undefined || rightValue === null) {
        return 1
      }
      if (leftValue > rightValue) {
        return direction === -1 ? -1 : 1
      }
      return direction === -1 ? 1 : -1
    })
  }

  if (command.limit !== undefined) {
    rows = rows.slice(0, Math.max(0, Number(command.limit)))
  }

  rows = rows.map((doc) => applyProjection(doc, command.projection))

  return {
    nextCollections: next,
    result: {
      ok: true,
      message: `Fetched ${rows.length} document(s) from ${collectionName}.`,
      rows,
      touchedRows: 0,
    },
  }
}

function formatJson(value: unknown): string {
  return JSON.stringify(value, null, 2)
}

function QueryLab() {
  const [queryMode, setQueryMode] = useState<QueryMode>('postgresql')
  const [sqlQuery, setSqlQuery] = useState(defaultSqlQuery)
  const [mongoCommand, setMongoCommand] = useState(defaultMongoCommand)
  const [sqlTables, setSqlTables] = useState<TableRows>(() => deepClone(initialSqlTables))
  const [mongoCollections, setMongoCollections] = useState<TableRows>(() => deepClone(initialMongoCollections))
  const [result, setResult] = useState<QueryResult>({ ok: true, message: 'Ready.', rows: [], touchedRows: 0 })
  const [dataInput, setDataInput] = useState('[{ "name": "New User", "age": 22 }]')
  const [targetName, setTargetName] = useState('sandbox')

  const activePreview = useMemo(() => {
    const source = queryMode === 'postgresql' ? sqlTables : mongoCollections
    const entries = Object.entries(source)
    return entries.map(([name, rows]) => ({ name, count: rows.length, sample: rows.slice(0, 3) }))
  }, [queryMode, sqlTables, mongoCollections])

  const totalRows = useMemo(() => {
    return activePreview.reduce((acc, item) => acc + item.count, 0)
  }, [activePreview])

  const resultJson = useMemo(() => formatJson(result.rows), [result.rows])

  const setEditorExample = (variant: 'default' | 'filter' | 'mutate') => {
    if (queryMode === 'postgresql') {
      if (variant === 'default') {
        setSqlQuery(defaultSqlQuery)
        return
      }

      if (variant === 'filter') {
        setSqlQuery(`SELECT id, name, city FROM users WHERE city ILIKE '%on%' ORDER BY age DESC LIMIT 10;`)
        return
      }

      setSqlQuery(`UPDATE users SET pro = true WHERE age >= 35;\nSELECT id, name, pro FROM users ORDER BY id ASC;`)
      return
    }

    if (variant === 'default') {
      setMongoCommand(defaultMongoCommand)
      return
    }

    if (variant === 'filter') {
      setMongoCommand(`{
  "action": "find",
  "collection": "events",
  "filter": { "type": "login", "success": true },
  "sort": { "_id": -1 },
  "limit": 10
}`)
      return
    }

    setMongoCommand(`{
  "action": "updateMany",
  "collection": "users",
  "filter": { "city": "London" },
  "update": {
    "$set": { "pro": true },
    "$inc": { "age": 1 }
  }
}`)
  }

  const runQuery = () => {
    try {
      if (queryMode === 'postgresql') {
        const { nextTables, result: nextResult } = runPostgresLikeQuery(sqlQuery, sqlTables)
        setSqlTables(nextTables)
        setResult(nextResult)
        return
      }

      const { nextCollections, result: nextResult } = runMongoCommand(mongoCommand, mongoCollections)
      setMongoCollections(nextCollections)
      setResult(nextResult)
    } catch (error) {
      setResult({
        ok: false,
        message: error instanceof Error ? error.message : 'Query execution failed.',
        rows: [],
        touchedRows: 0,
      })
    }
  }

  const addJsonData = () => {
    try {
      const parsed = JSON.parse(dataInput)
      const incoming = Array.isArray(parsed) ? parsed : [parsed]
      if (!Array.isArray(incoming) || incoming.some((item) => item === null || typeof item !== 'object')) {
        throw new Error('Input must be an object or array of objects.')
      }

      if (queryMode === 'postgresql') {
        setSqlTables((current) => {
          const next = deepClone(current)
          if (!next[targetName]) {
            next[targetName] = []
          }
          next[targetName].push(...(incoming as Array<Record<string, unknown>>))
          return next
        })
      } else {
        setMongoCollections((current) => {
          const next = deepClone(current)
          if (!next[targetName]) {
            next[targetName] = []
          }
          next[targetName].push(...(incoming as Array<Record<string, unknown>>))
          return next
        })
      }

      setResult({
        ok: true,
        message: `Added ${incoming.length} custom row(s) to ${targetName}.`,
        rows: incoming as Array<Record<string, unknown>>,
        touchedRows: incoming.length,
      })
    } catch (error) {
      setResult({
        ok: false,
        message: error instanceof Error ? error.message : 'Could not add JSON data.',
        rows: [],
        touchedRows: 0,
      })
    }
  }

  const resetDataset = () => {
    if (queryMode === 'postgresql') {
      setSqlTables(deepClone(initialSqlTables))
      setResult({ ok: true, message: 'PostgreSQL practice dataset reset.', rows: [], touchedRows: 0 })
      return
    }

    setMongoCollections(deepClone(initialMongoCollections))
    setResult({ ok: true, message: 'MongoDB practice dataset reset.', rows: [], touchedRows: 0 })
  }

  return (
    <section className="query-lab panel">
      <div className="panel-title">
        <h2>Database Query Arena</h2>
        <span>Practice PostgreSQL + MongoDB directly in this UI</span>
      </div>

      <div className="query-lab-intro">
        <p>Use quick templates, run queries instantly, and inspect live dataset previews without leaving the page.</p>
        <div className="query-lab-stats">
          <span>{queryMode === 'postgresql' ? 'SQL Mode' : 'Mongo Mode'}</span>
          <span>{activePreview.length} sources</span>
          <span>{totalRows} total rows</span>
          <span>{result.rows.length} result rows</span>
        </div>
      </div>

      <div className="query-lab-topbar">
        <div className="mode-switch">
          <button className={queryMode === 'postgresql' ? 'active' : ''} onClick={() => setQueryMode('postgresql')}>
            PostgreSQL
          </button>
          <button className={queryMode === 'mongodb' ? 'active' : ''} onClick={() => setQueryMode('mongodb')}>
            MongoDB
          </button>
        </div>
        <button className="report-button" onClick={resetDataset}>
          Reset {queryMode === 'postgresql' ? 'SQL' : 'Mongo'} Data
        </button>
      </div>

      <div className="query-lab-grid">
        <div className="query-editor-block">
          <h3>{queryMode === 'postgresql' ? 'SQL Query Editor' : 'Mongo Command Editor'}</h3>
          <p className="query-section-caption">
            {queryMode === 'postgresql'
              ? 'Tip: Separate multiple SQL statements with semicolons.'
              : 'Tip: Enter valid JSON commands. Start with action = find, then refine filter/sort/limit.'}
          </p>

          <div className="query-template-row" role="group" aria-label="Load query templates">
            <button onClick={() => setEditorExample('default')}>Starter</button>
            <button onClick={() => setEditorExample('filter')}>Filter Example</button>
            <button onClick={() => setEditorExample('mutate')}>Update Example</button>
          </div>

          <textarea
            className="query-input"
            value={queryMode === 'postgresql' ? sqlQuery : mongoCommand}
            onChange={(event) => {
              if (queryMode === 'postgresql') {
                setSqlQuery(event.target.value)
              } else {
                setMongoCommand(event.target.value)
              }
            }}
          />
          <div className="instant-actions">
            <button onClick={runQuery}>Run Query</button>
            <button onClick={() => setEditorExample('default')}>Load Example</button>
          </div>

          <h3>Add Custom Data</h3>
          <p className="query-section-caption">Paste JSON object or array and append it to any table/collection.</p>
          <div className="query-data-controls">
            <input
              type="text"
              value={targetName}
              onChange={(event) => setTargetName(event.target.value.trim())}
              placeholder={queryMode === 'postgresql' ? 'table name' : 'collection name'}
            />
            <button onClick={addJsonData}>Add JSON</button>
          </div>
          <div className="query-target-chips" role="group" aria-label="Pick target dataset">
            {activePreview.map((item) => (
              <button key={item.name} onClick={() => setTargetName(item.name)} className={targetName === item.name ? 'active' : ''}>
                {item.name}
              </button>
            ))}
          </div>
          <textarea className="query-input small-input" value={dataInput} onChange={(event) => setDataInput(event.target.value)} />
        </div>

        <div className="query-output-block">
          <div className="query-output-head">
            <h3>Query Output</h3>
            <button
              className="report-button"
              onClick={() => {
                void navigator.clipboard.writeText(resultJson)
              }}
            >
              Copy JSON
            </button>
          </div>
          <div className={`query-result-chip ${result.ok ? 'ok' : 'error'}`}>
            <strong>{result.ok ? 'Success' : 'Error'}</strong>
            <span>{result.message}</span>
            <span>Rows touched: {result.touchedRows}</span>
          </div>
          <pre className="query-result">{resultJson}</pre>

          <h3>Dataset Browser</h3>
          <div className="dataset-cards">
            {activePreview.map((item) => (
              <article key={item.name} className="dataset-card">
                <div className="row">
                  <strong>{item.name}</strong>
                  <span>{item.count} rows</span>
                </div>
                <pre>{formatJson(item.sample)}</pre>
              </article>
            ))}
          </div>
        </div>
      </div>

      <p className="small query-help">
        SQL supports: SELECT, INSERT, UPDATE, DELETE, CREATE TABLE, SHOW TABLES, DESCRIBE. Mongo supports: find, insert,
        updateMany, deleteMany, count, aggregate with basic stages.
      </p>
    </section>
  )
}

export default QueryLab
